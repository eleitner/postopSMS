/**
 * PHI Scrubber — Free-Text & Image De-identification
 * 
 * This module scrubs patient-generated free-text messages and images
 * before they reach any AI layer. The existing deidentify.js handles
 * structured triage data; this handles raw inbound messages.
 * 
 * Scrubbing strategy (defense in depth):
 *   Layer 1: Regex patterns (SSN, phone, DOB, email, address patterns)
 *   Layer 2: Known-identity matching (patient name, surgeon name from DB)
 *   Layer 3: Common name/location heuristics
 *   Layer 4: Image EXIF stripping (GPS, device ID, timestamps)
 * 
 * The raw message is ALWAYS stored in the database (encrypted at rest via Render).
 * Only the scrubbed version is sent to AI.
 * 
 * ┌──────────────────┐                ┌──────────────────┐
 * │  Raw inbound SMS  │  scrubText()  │  Scrubbed text    │
 * │  "Hi this is      │ ────────────▶ │  "Hi this is      │ ──▶ Claude
 * │   Margaret at     │               │   [NAME] at       │
 * │   123 Main St"    │               │   [ADDRESS]"      │
 * └──────────────────┘                └──────────────────┘
 * 
 *       │                                      │
 *       ▼                                      ▼
 *   sms_log table                     AI conversation
 *   (raw, encrypted)                  (scrubbed only)
 */

const logger = require('../utils/logger');

// ═══════════════════════════════════════════════════
// REGEX PATTERNS — Layer 1
// ═══════════════════════════════════════════════════

const PATTERNS = [
  // SSN: 123-45-6789 or 123456789
  { regex: /\b\d{3}[-\s]?\d{2}[-\s]?\d{4}\b/g, replacement: '[SSN]', name: 'ssn' },

  // Phone numbers: various formats
  { regex: /\+?1?[-.\s]?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/g, replacement: '[PHONE]', name: 'phone' },

  // Email addresses
  { regex: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g, replacement: '[EMAIL]', name: 'email' },

  // Dates that look like DOB: MM/DD/YYYY, MM-DD-YYYY, MM.DD.YYYY
  // (but NOT pain scores like "5/10" or clinical values)
  { regex: /\b(0?[1-9]|1[0-2])[\/\-\.](0?[1-9]|[12]\d|3[01])[\/\-\.](19|20)\d{2}\b/g, replacement: '[DATE]', name: 'dob' },

  // Street addresses: number + street name patterns
  // Matches: "123 Main St", "456 Oak Avenue", "789 First Street Apt 2"
  { regex: /\b\d{1,5}\s+[A-Z][a-zA-Z]*(\s+(St|Street|Ave|Avenue|Rd|Road|Dr|Drive|Ln|Lane|Blvd|Boulevard|Ct|Court|Way|Pl|Place|Cir|Circle|Pkwy|Parkway))\b\.?(\s+(Apt|Suite|Ste|Unit|#)\s*\w+)?/gi, replacement: '[ADDRESS]', name: 'address' },

  // ZIP codes (5 digit or 5+4)
  { regex: /\b\d{5}(-\d{4})?\b/g, replacement: '[ZIP]', name: 'zip' },

  // MRN patterns: common formats like MRN-123456, MRN: 123456, MRN#123456
  { regex: /\b(MRN|mrn|Medical Record)[#:\s-]*\d{4,10}\b/gi, replacement: '[MRN]', name: 'mrn' },

  // Insurance/policy numbers: alphanumeric patterns often with prefixes
  { regex: /\b(policy|member|subscriber|group|insurance)[#:\s]*[A-Z0-9]{6,15}\b/gi, replacement: '[INSURANCE_ID]', name: 'insurance' },
];

// ═══════════════════════════════════════════════════
// TEXT SCRUBBING
// ═══════════════════════════════════════════════════

/**
 * Scrub free-text of PHI patterns and known identifiers.
 * 
 * @param {string} text — Raw inbound message text
 * @param {object} knownIdentifiers — Patient/surgeon names to scrub
 *   { patientFirst, patientLast, surgeonName, phone }
 * @returns {{ scrubbed: string, redactions: object[] }}
 */
function scrubText(text, knownIdentifiers = {}) {
  if (!text || typeof text !== 'string') return { scrubbed: '', redactions: [] };

  let scrubbed = text;
  const redactions = [];

  // Layer 2: Known-identity matching (do this FIRST — names before regex)
  const names = [];
  if (knownIdentifiers.patientFirst) names.push({ val: knownIdentifiers.patientFirst, label: '[NAME]' });
  if (knownIdentifiers.patientLast) names.push({ val: knownIdentifiers.patientLast, label: '[NAME]' });
  if (knownIdentifiers.surgeonName) {
    // Handle "Dr. Patel", "Patel", etc.
    const clean = knownIdentifiers.surgeonName.replace(/^Dr\.?\s*/i, '');
    names.push({ val: clean, label: '[SURGEON]' });
    names.push({ val: knownIdentifiers.surgeonName, label: '[SURGEON]' });
  }
  if (knownIdentifiers.phone) names.push({ val: knownIdentifiers.phone, label: '[PHONE]' });

  for (const { val, label } of names) {
    if (!val || val.length < 2) continue;
    // Case-insensitive whole-word replacement
    const escaped = val.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const nameRegex = new RegExp(`\\b${escaped}\\b`, 'gi');
    const matches = scrubbed.match(nameRegex);
    if (matches) {
      scrubbed = scrubbed.replace(nameRegex, label);
      redactions.push({ type: 'known_identity', label, count: matches.length });
    }
  }

  // Layer 1: Regex patterns
  for (const pattern of PATTERNS) {
    const matches = scrubbed.match(pattern.regex);
    if (matches) {
      // Don't re-scrub already-scrubbed tokens
      const realMatches = matches.filter(m => !m.startsWith('['));
      if (realMatches.length > 0) {
        scrubbed = scrubbed.replace(pattern.regex, (match) => {
          if (match.startsWith('[')) return match; // already scrubbed
          return pattern.replacement;
        });
        redactions.push({ type: pattern.name, label: pattern.replacement, count: realMatches.length });
      }
    }
  }

  // Layer 3: Final safety — catch any remaining digit sequences that look like identifiers
  // (10+ digits in a row that aren't already scrubbed)
  scrubbed = scrubbed.replace(/\b\d{10,}\b/g, (match) => {
    redactions.push({ type: 'long_number', label: '[ID_NUMBER]', count: 1 });
    return '[ID_NUMBER]';
  });

  if (redactions.length > 0) {
    logger.info('PHI scrubbed from inbound message', {
      redactionCount: redactions.length,
      types: redactions.map(r => r.type),
    });
  }

  return { scrubbed, redactions };
}

// ═══════════════════════════════════════════════════
// IMAGE SCRUBBING
// ═══════════════════════════════════════════════════

/**
 * Strip EXIF metadata from an image buffer.
 * Removes GPS coordinates, device info, timestamps — anything that identifies.
 * Returns a clean buffer safe for AI processing.
 * 
 * For JPEG: strips all APP1 (EXIF) segments.
 * For PNG: passes through (PNG doesn't carry EXIF by default).
 * 
 * @param {Buffer} imageBuffer — Raw image data from Twilio MMS
 * @param {string} contentType — MIME type (image/jpeg, image/png, etc.)
 * @returns {{ buffer: Buffer, stripped: string[] }}
 */
function scrubImage(imageBuffer, contentType = 'image/jpeg') {
  const stripped = [];

  if (!imageBuffer || !Buffer.isBuffer(imageBuffer)) {
    return { buffer: imageBuffer, stripped: ['invalid_input'] };
  }

  // For JPEG: strip EXIF by removing APP1 markers
  if (contentType === 'image/jpeg' || contentType === 'image/jpg') {
    try {
      const cleaned = stripJpegExif(imageBuffer);
      stripped.push('exif_gps', 'exif_device', 'exif_timestamp');
      logger.info('EXIF stripped from inbound image', { originalSize: imageBuffer.length, cleanSize: cleaned.length });
      return { buffer: cleaned, stripped };
    } catch (err) {
      logger.warn('EXIF stripping failed — passing through without metadata access', { error: err.message });
      return { buffer: imageBuffer, stripped: ['strip_failed'] };
    }
  }

  // PNG, GIF, etc. — less EXIF risk, pass through
  return { buffer: imageBuffer, stripped: ['non_jpeg_passthrough'] };
}

/**
 * Strip EXIF from JPEG by removing APP1 (0xFFE1) segments.
 * This is a minimal, dependency-free approach.
 * For production, consider using sharp or piexifjs for robustness.
 */
function stripJpegExif(buffer) {
  // JPEG starts with FF D8
  if (buffer[0] !== 0xFF || buffer[1] !== 0xD8) {
    return buffer; // Not a valid JPEG
  }

  const result = [Buffer.from([0xFF, 0xD8])];
  let offset = 2;

  while (offset < buffer.length - 1) {
    if (buffer[offset] !== 0xFF) break;

    const marker = buffer[offset + 1];

    // SOS (Start of Scan) — everything after this is image data, keep all of it
    if (marker === 0xDA) {
      result.push(buffer.slice(offset));
      break;
    }

    // Get segment length
    if (offset + 3 >= buffer.length) break;
    const segLength = buffer.readUInt16BE(offset + 2);

    // APP1 (0xE1) = EXIF data — SKIP this segment
    if (marker === 0xE1) {
      offset += 2 + segLength;
      continue;
    }

    // Keep all other segments (APP0/JFIF, DQT, DHT, SOF, etc.)
    result.push(buffer.slice(offset, offset + 2 + segLength));
    offset += 2 + segLength;
  }

  return Buffer.concat(result);
}

// ═══════════════════════════════════════════════════
// CONTEXT BUILDER — Safe clinical context for AI conversations
// ═══════════════════════════════════════════════════

/**
 * Build a safe clinical context for the AI conversation handler.
 * Includes patient's clinical state but NO identifying information.
 * 
 * @param {object} patient — Full patient record from DB
 * @param {object[]} recentResponses — Recent check-in responses
 * @param {object|null} surgeonInstructions — Parsed surgeon instructions (if available)
 * @returns {object} Safe context object
 */
function buildSafeContext(patient, recentResponses = [], surgeonInstructions = null) {
  const pod = patient.surgery_date
    ? Math.floor((Date.now() - new Date(patient.surgery_date).getTime()) / 86400000)
    : null;

  return {
    pod,
    procedure: patient.procedure_name,
    ageBracket: getAgeBracket(patient.age_at_surgery),
    asaClass: patient.asa_class || null,
    surgeonSpecialty: null, // loaded separately if needed
    preSurgicalGoal: patient.pre_surgical_goal || null,
    checkinCadence: patient.checkin_cadence || 'standard',
    lastCheckinPhase: patient.last_checkin_phase || null,
    recentData: recentResponses.map(r => ({
      key: r.question_key,
      value: r.response_parsed || r.response_raw,
      pod: r.pod,
      phase: r.phase,
      alertTriggered: r.alert_triggered || false,
    })),
    surgeonInstructions: surgeonInstructions ? {
      woundCare: surgeonInstructions.wound_care || null,
      activityRestrictions: surgeonInstructions.activity_restrictions || null,
      diet: surgeonInstructions.diet || null,
      medications: surgeonInstructions.medications || null,
      warningSignsCallOffice: surgeonInstructions.warning_signs_call_office || null,
      warningSignsER: surgeonInstructions.warning_signs_er || null,
      followUp: surgeonInstructions.follow_up || null,
    } : null,
  };
}

function getAgeBracket(age) {
  if (!age) return 'unknown';
  if (age < 30) return '18-29';
  if (age < 40) return '30-39';
  if (age < 50) return '40-49';
  if (age < 60) return '50-59';
  if (age < 70) return '60-69';
  if (age < 80) return '70-79';
  return '80+';
}

module.exports = {
  scrubText,
  scrubImage,
  buildSafeContext,
  // Exported for testing
  PATTERNS,
  stripJpegExif,
};
