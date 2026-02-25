/**
 * Conversation Handler — Between-Checkin AI
 * 
 * When a patient texts outside of an active check-in session, this handler
 * provides a warm, nurse-like AI response. It can:
 * 
 *   1. Answer informational questions from surgeon's parsed instructions
 *      or standard ACS/AHRQ post-op guidelines
 *   2. Accept symptom reports and triage them
 *   3. Accept wound photos (MMS) and attach them to nurse alerts
 *   4. Escalate to triage nurse when clinical criteria are met
 * 
 * PHI boundary:
 *   - Raw message stored in sms_log (encrypted at rest)
 *   - AI receives ONLY scrubbed text + de-identified clinical context
 *   - AI response is sent back to patient via normal SMS channel
 * 
 * This is NOT a diagnostic tool. It's a care navigation layer that
 * makes patients feel heard and routes concerns to the right person.
 */
const Anthropic = require('@anthropic-ai/sdk');
const { scrubText, buildSafeContext } = require('./phi-scrubber');
const { sendSMS, sendNurseAlert } = require('./twilio');
const { isEmergency } = require('./protocols');
const { pool, audit } = require('../utils/db');
const logger = require('../utils/logger');

let client = null;

function getClient() {
  if (client) return client;
  client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return client;
}

// ═══════════════════════════════════════════════════
// SYSTEM PROMPT — The "Nurse" persona
// ═══════════════════════════════════════════════════

const CONVERSATION_SYSTEM_PROMPT = `You are a warm, experienced post-operative care nurse communicating with a surgical patient via text message. You work at a community hospital's post-discharge screening program.

YOUR TONE:
- Warm, reassuring, conversational — like a nurse who genuinely cares
- Brief — you're texting, not writing an email. 1-3 sentences max.
- Use first names naturally. Say "you" not "the patient"
- Okay to use casual phrasing: "Sounds good!", "That's totally normal", "Glad to hear it"
- Never robotic, never clinical jargon unless the patient uses it first
- If something concerns you, be direct but calm: "I want to make sure we check on that"

YOUR CAPABILITIES:
- Answer questions about post-op recovery using the surgeon's instructions (if provided) or standard post-operative guidelines
- Acknowledge symptoms and route concerning ones to the triage nurse
- Provide reassurance for normal recovery concerns
- Remind patients of their next check-in timing

YOUR LIMITS — ALWAYS FOLLOW THESE:
- NEVER diagnose. NEVER say "you have an infection" or "this is normal." Say "that's worth having someone look at" or "that sounds like typical recovery"
- NEVER adjust medications or give dosing advice. Say "check with your surgeon's office on that"
- NEVER provide specific medical instructions that contradict or go beyond the surgeon's instructions
- If the patient describes something that sounds urgent (new bleeding, fever, worsening pain, wound changes), say you're flagging it for the nurse and that someone will follow up
- If you're unsure, say "Let me flag this for your nurse to take a look" — never guess

ESCALATION RULES — set "escalate" to true in your response if ANY of these:
- New or worsening bleeding
- Fever or chills reported
- Wound changes (redness, discharge, opening, swelling)
- Pain significantly worse than last check-in
- Difficulty breathing, chest pain (should be caught by emergency keywords but double-check)
- Falls or injuries since surgery
- Inability to eat/drink or keep fluids down
- Medication confusion or concerns about opioid use
- Patient expresses distress, anxiety, or depression
- Any symptom you'd want a nurse to know about

PHOTO HANDLING:
- If the patient mentions sending a photo, acknowledge it warmly
- Say something like "Thanks for sending that — I'll make sure the nurse sees it"
- Always escalate when a photo is attached

You will receive:
- The patient's message (scrubbed of identifying info — names replaced with [NAME], etc.)
- Clinical context: procedure type, current POD, recent check-in data, surgeon instructions
- You will NOT see any identifying information. Never ask for names, DOBs, or other identifiers.

RESPOND ONLY IN THIS JSON FORMAT:
{
  "message": "Your text message to the patient (1-3 sentences, warm nurse tone)",
  "escalate": true/false,
  "escalateReason": "Brief reason for nurse (only if escalate=true)",
  "escalateSeverity": "URGENT or MONITOR (only if escalate=true)",
  "category": "informational|symptom_report|reassurance|medication_question|wound_concern|emotional|photo|other"
}`;

// ═══════════════════════════════════════════════════
// MAIN HANDLER
// ═══════════════════════════════════════════════════

/**
 * Handle a between-checkin inbound message with AI conversation.
 * 
 * @param {object} patient — Full patient record from DB
 * @param {string} rawBody — Raw inbound message text
 * @param {object} options — { mediaUrls: string[], twilioSid: string }
 * @returns {{ handled: boolean, type: string, escalated: boolean }}
 */
async function handleConversation(patient, rawBody, options = {}) {
  const { mediaUrls = [], twilioSid = null } = options;
  const hasMedia = mediaUrls.length > 0;

  // Step 1: Scrub the inbound message
  const { scrubbed, redactions } = scrubText(rawBody, {
    patientFirst: patient.first_name,
    patientLast: patient.last_name,
    surgeonName: patient.surgeon_name,
    phone: patient.phone,
  });

  // Step 2: Build safe clinical context
  const recentResponses = await getRecentResponses(patient.id);
  const surgeonInstructions = await getSurgeonInstructions(patient);
  const safeContext = buildSafeContext(patient, recentResponses, surgeonInstructions);

  // Step 3: Call AI with scrubbed message + context
  // If photo attached, use vision API for wound analysis
  let aiResponse;
  try {
    if (hasMedia && mediaUrls.length > 0) {
      aiResponse = await callVisionAI(scrubbed, safeContext, mediaUrls);
    } else {
      aiResponse = await callAI(scrubbed, safeContext, hasMedia);
    }
  } catch (err) {
    logger.error('Conversation AI failed — sending fallback', { error: err.message, patientId: patient.id });
    // Fallback: warm human message, always route to nurse
    await sendSMS(patient.phone,
      `Thanks for reaching out! I want to make sure the right person sees this. I'm flagging your message for the nurse — someone will get back to you soon.`,
      { patientId: patient.id }
    );
    // Escalate since we couldn't assess
    await escalateToNurse(patient, rawBody, 'MONITOR', 'AI unavailable — patient sent between-checkin message, needs manual review', hasMedia, mediaUrls);
    return { handled: true, type: 'conversation_fallback', escalated: true };
  }

  // Step 4: Send AI response to patient
  if (aiResponse.message) {
    await sendSMS(patient.phone, aiResponse.message, { patientId: patient.id });
  }

  // Step 5: Log the conversation
  await logConversation(patient.id, rawBody, scrubbed, aiResponse, redactions, twilioSid);

  // Step 6: Escalate if needed
  if (aiResponse.escalate || hasMedia) {
    const severity = aiResponse.escalateSeverity || 'MONITOR';
    const reason = aiResponse.escalateReason || (hasMedia ? 'Patient sent photo/media' : 'AI-flagged concern');
    await escalateToNurse(patient, rawBody, severity, reason, hasMedia, mediaUrls);
  }

  return {
    handled: true,
    type: 'conversation',
    category: aiResponse.category || 'other',
    escalated: aiResponse.escalate || hasMedia,
  };
}

// ═══════════════════════════════════════════════════
// AI CALL
// ═══════════════════════════════════════════════════

async function callAI(scrubbedMessage, safeContext, hasMedia) {
  const anthropic = getClient();

  const userContent = [
    `Patient message: "${scrubbedMessage}"`,
    hasMedia ? '\n[Patient also attached a photo/image]' : '',
    `\nClinical context:\n${JSON.stringify(safeContext, null, 2)}`,
  ].join('');

  const message = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 300,
    system: CONVERSATION_SYSTEM_PROMPT,
    messages: [{ role: 'user', content: userContent }],
  });

  const responseText = message.content[0]?.text || '';

  // Parse JSON response
  try {
    const jsonMatch = responseText.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      // Validate required fields
      return {
        message: parsed.message || "Thanks for reaching out! I'll make sure someone on your care team sees this.",
        escalate: !!parsed.escalate,
        escalateReason: parsed.escalateReason || null,
        escalateSeverity: ['URGENT', 'MONITOR', 'CRITICAL'].includes(parsed.escalateSeverity) ? parsed.escalateSeverity : 'MONITOR',
        category: parsed.category || 'other',
      };
    }
  } catch (parseErr) {
    logger.warn('Failed to parse conversation AI response', { responseText: responseText.substring(0, 200) });
  }

  // If parsing failed, use the raw text as the message and escalate to be safe
  return {
    message: responseText.length > 0 && responseText.length < 320
      ? responseText
      : "Thanks for reaching out! I'm flagging this for your nurse to review.",
    escalate: true,
    escalateReason: 'AI response parsing failed — needs manual review',
    escalateSeverity: 'MONITOR',
    category: 'other',
  };
}

/**
 * Vision AI — analyze wound photos sent via MMS.
 * 
 * IMPORTANT: Photos from Twilio are accessed via URL. We fetch the image,
 * encode to base64, and send to Claude's vision API.
 * 
 * The AI does NOT diagnose. It describes what it sees in clinical terms
 * and recommends escalation level. The nurse makes the clinical decision.
 */
const VISION_SYSTEM_PROMPT = `You are a post-surgical care assistant reviewing a wound photo sent by a patient via text message.

Your role is NOT to diagnose. You describe what you observe in structured clinical terms so the triage nurse can prioritize their callback.

Analyze the image and respond with ONLY a JSON object:
{
  "message": "A warm, reassuring message to the patient acknowledging their photo and letting them know the nurse will review it. Keep it brief — 2 sentences max. Never describe what you see to the patient or suggest diagnoses.",
  "escalate": true,
  "escalateReason": "Structured description for the nurse: wound location, approximate size, color observations (redness, drainage color), swelling, wound edge approximation, any concerning features. Be factual and specific.",
  "escalateSeverity": "URGENT or MONITOR",
  "category": "wound_concern",
  "visionFindings": {
    "woundAppearance": "brief description",
    "redness": "none | mild_periincisional | spreading | significant",
    "drainage": "none | serous | serosanguinous | purulent | unknown",
    "swelling": "none | mild | moderate | significant",
    "woundEdges": "well_approximated | slight_separation | dehiscence | unable_to_assess",
    "concernLevel": "low | moderate | high"
  }
}

Guidelines:
- ALWAYS escalate wound photos to the nurse. Set escalate: true always.
- High concern (significant redness spreading beyond incision, purulent drainage, dehiscence, signs of infection): URGENT
- Moderate concern (mild redness, serous drainage, mild swelling): MONITOR  
- If the image is unclear, blurry, or not a wound photo, still escalate as MONITOR with a note
- Never tell the patient what you see in the photo — that's the nurse's job
- Never suggest diagnoses or treatments to the patient`;

async function callVisionAI(scrubbedMessage, safeContext, mediaUrls) {
  const anthropic = getClient();

  // Fetch images from Twilio URLs and convert to base64
  const imageContents = [];
  for (const url of mediaUrls.slice(0, 3)) { // Max 3 images
    try {
      const imageData = await fetchImageAsBase64(url);
      if (imageData) {
        imageContents.push({
          type: 'image',
          source: {
            type: 'base64',
            media_type: imageData.mediaType,
            data: imageData.base64,
          },
        });
      }
    } catch (err) {
      logger.warn('Failed to fetch MMS image for vision', { url: url.substring(0, 50), error: err.message });
    }
  }

  // If no images could be fetched, fall back to text-only
  if (imageContents.length === 0) {
    return callAI(scrubbedMessage, safeContext, true);
  }

  const userContent = [
    ...imageContents,
    {
      type: 'text',
      text: [
        scrubbedMessage ? `Patient message: "${scrubbedMessage}"` : 'Patient sent a photo with no text.',
        `\nClinical context:\n${JSON.stringify(safeContext, null, 2)}`,
      ].join(''),
    },
  ];

  const message = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 500,
    system: VISION_SYSTEM_PROMPT,
    messages: [{ role: 'user', content: userContent }],
  });

  const responseText = message.content[0]?.text || '';

  try {
    const jsonMatch = responseText.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      return {
        message: parsed.message || "Thanks for sending that photo! I'm passing it along to your nurse for review.",
        escalate: true, // Always escalate photos
        escalateReason: parsed.escalateReason || 'Patient sent wound photo — needs nurse review',
        escalateSeverity: ['URGENT', 'MONITOR'].includes(parsed.escalateSeverity) ? parsed.escalateSeverity : 'MONITOR',
        category: 'wound_concern',
        visionFindings: parsed.visionFindings || null,
      };
    }
  } catch (parseErr) {
    logger.warn('Failed to parse vision AI response', { responseText: responseText.substring(0, 200) });
  }

  // Fallback — always escalate photos
  return {
    message: "Thanks for sending that photo! I'm passing it to your nurse right now.",
    escalate: true,
    escalateReason: 'Patient sent wound photo — AI analysis unavailable, needs nurse review',
    escalateSeverity: 'MONITOR',
    category: 'wound_concern',
  };
}

/**
 * Fetch an image from a Twilio MMS URL and return as base64.
 * Twilio MMS URLs require authentication with account SID and auth token.
 */
async function fetchImageAsBase64(url) {
  try {
    const https = require('https');
    const http = require('http');

    // Twilio media URLs need basic auth
    const authString = Buffer.from(
      `${process.env.TWILIO_ACCOUNT_SID}:${process.env.TWILIO_AUTH_TOKEN}`
    ).toString('base64');

    return new Promise((resolve, reject) => {
      const protocol = url.startsWith('https') ? https : http;
      const req = protocol.get(url, {
        headers: { 'Authorization': `Basic ${authString}` },
      }, (res) => {
        // Handle redirects (Twilio often redirects media URLs)
        if (res.statusCode === 301 || res.statusCode === 302) {
          fetchImageAsBase64(res.headers.location).then(resolve).catch(reject);
          return;
        }

        if (res.statusCode !== 200) {
          reject(new Error(`Image fetch failed: ${res.statusCode}`));
          return;
        }

        const contentType = res.headers['content-type'] || 'image/jpeg';
        const chunks = [];
        res.on('data', chunk => chunks.push(chunk));
        res.on('end', () => {
          const buffer = Buffer.concat(chunks);
          // Limit to 5MB
          if (buffer.length > 5 * 1024 * 1024) {
            reject(new Error('Image too large (>5MB)'));
            return;
          }
          resolve({
            base64: buffer.toString('base64'),
            mediaType: contentType.split(';')[0].trim(),
          });
        });
        res.on('error', reject);
      });
      req.on('error', reject);
      req.setTimeout(10000, () => { req.destroy(); reject(new Error('Image fetch timeout')); });
    });
  } catch (err) {
    logger.error('Image fetch error', { error: err.message });
    return null;
  }
}

// ═══════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════

/**
 * Get recent check-in responses for clinical context.
 * Last 2 sessions worth of data.
 */
async function getRecentResponses(patientId) {
  try {
    const result = await pool.query(
      `SELECT r.question_key, r.response_parsed, r.response_raw, r.pod, r.phase, r.alert_triggered, r.alert_severity
       FROM responses r
       JOIN checkin_sessions cs ON cs.id = r.session_id
       WHERE r.patient_id = $1 AND cs.status = 'completed'
       ORDER BY r.created_at DESC LIMIT 20`,
      [patientId]
    );
    return result.rows;
  } catch (err) {
    logger.warn('Failed to load recent responses for context', { error: err.message });
    return [];
  }
}

/**
 * Get surgeon's parsed instructions if available.
 */
async function getSurgeonInstructions(patient) {
  try {
    let surgeonId = patient.surgeon_id;

    // Fallback: name-based lookup
    if (!surgeonId && patient.surgeon_name) {
      const result = await pool.query(
        `SELECT id FROM surgeons WHERE active = TRUE AND LOWER(name) = LOWER($1) LIMIT 1`,
        [patient.surgeon_name]
      );
      surgeonId = result.rows[0]?.id;
    }

    if (!surgeonId) return null;

    const result = await pool.query(
      `SELECT instructions, instructions_status FROM surgeons WHERE id = $1`,
      [surgeonId]
    );

    const surgeon = result.rows[0];
    if (!surgeon || surgeon.instructions_status !== 'approved' || !surgeon.instructions) {
      return null;
    }

    return surgeon.instructions;
  } catch (err) {
    logger.warn('Failed to load surgeon instructions', { error: err.message });
    return null;
  }
}

/**
 * Escalate a between-checkin message to the triage nurse.
 * Includes the RAW message (nurse needs full context to call back).
 */
async function escalateToNurse(patient, rawBody, severity, reason, hasMedia, mediaUrls = []) {
  const surgeonClean = (patient.surgeon_name || '').replace(/^Dr\.?\s*/i, '');
  const pod = patient.surgery_date
    ? Math.floor((Date.now() - new Date(patient.surgery_date).getTime()) / 86400000)
    : '?';

  // Use the existing sendNurseAlert which handles per-surgeon routing
  // But we need a session-like object for the interface
  const pseudoSession = { id: null, pod };

  await sendNurseAlert(patient, pseudoSession, severity, reason);

  // Log the conversation-triggered alert
  try {
    await pool.query(
      `INSERT INTO alerts (patient_id, severity, reason, source)
       VALUES ($1, $2, $3, 'conversation')`,
      [patient.id, severity, reason]
    );
    await audit('system', 'conversation_alert', 'patient', patient.id, {
      severity,
      reason,
      hasMedia,
      mediaCount: mediaUrls.length,
    });
  } catch (err) {
    logger.error('Failed to log conversation alert', { error: err.message });
  }
}

/**
 * Log the conversation exchange for audit and analysis.
 */
async function logConversation(patientId, rawMessage, scrubbedMessage, aiResponse, redactions, twilioSid) {
  try {
    await pool.query(
      `INSERT INTO conversation_log (patient_id, inbound_raw, inbound_scrubbed, ai_response, ai_category, escalated, escalate_reason, redaction_count, twilio_sid)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        patientId,
        rawMessage,
        scrubbedMessage,
        aiResponse.message,
        aiResponse.category,
        aiResponse.escalate,
        aiResponse.escalateReason,
        redactions.length,
        twilioSid,
      ]
    );
  } catch (err) {
    // conversation_log table may not exist yet — non-critical
    logger.warn('Failed to log conversation (table may not exist yet)', { error: err.message });
  }
}

module.exports = { handleConversation };
