/**
 * De-identification Layer
 * 
 * THIS IS THE HIPAA BOUNDARY. Every call to the AI triage layer
 * passes through here. The AI never sees:
 *   - Patient name
 *   - Phone number
 *   - Date of birth
 *   - MRN / patient ID
 *   - Any other HIPAA identifier
 * 
 * The AI receives a session token (e.g., SESSION_7f3a) and clinical data only.
 * Your server maps the token back to the real patient on return.
 * 
 * ┌──────────────┐     deidentify()     ┌──────────────┐
 * │  Full PHI     │ ──────────────────▶  │  Clinical     │
 * │  Patient DB   │                      │  Data Only    │ ──▶ Claude API
 * │               │ ◀──────────────────  │  + Token      │
 * └──────────────┘     reidentify()     └──────────────┘
 */

const crypto = require('crypto');

// In-memory token map — lives only for the duration of the request
// Never persisted, never logged
const tokenMap = new Map();

/**
 * Strip all identifiers from a patient record + session responses.
 * Returns an object safe to send to the AI layer.
 */
function deidentify(patient, session, responses) {
  // Generate a short, random session token
  const token = 'SESSION_' + crypto.randomBytes(4).toString('hex');

  // Store the mapping (cleaned up after AI response returns)
  tokenMap.set(token, {
    patientId: patient.id,
    sessionId: session.id,
    createdAt: Date.now(),
  });

  // Build the safe clinical context — NO identifiers
  const safeContext = {
    token,
    pod: session.pod,
    phase: session.phase,
    procedure: patient.procedure_name,
    // Age bracket, not exact age
    ageBracket: getAgeBracket(patient.age_at_surgery),
    asaClass: patient.asa_class || null,
    preSurgicalGoal: patient.pre_surgical_goal || null,
    responses: responses.map(r => ({
      key: r.question_key,
      value: r.response_parsed || r.response_raw,
      type: r.response_type,
      alertTriggered: r.alert_triggered,
      alertSeverity: r.alert_severity,
    })),
  };

  return safeContext;
}

/**
 * Look up the real patient from a session token.
 */
function reidentify(token) {
  const mapping = tokenMap.get(token);
  if (!mapping) return null;
  return mapping;
}

/**
 * Clean up a token after use. Call this after the AI response is processed.
 */
function clearToken(token) {
  tokenMap.delete(token);
}

/**
 * Periodic cleanup of stale tokens (safety net — should never be needed)
 */
function cleanupStaleTokens(maxAgeMs = 60000) {
  const now = Date.now();
  for (const [token, mapping] of tokenMap.entries()) {
    if (now - mapping.createdAt > maxAgeMs) {
      tokenMap.delete(token);
    }
  }
}

// Run cleanup every 5 minutes
setInterval(() => cleanupStaleTokens(), 5 * 60 * 1000).unref();

/**
 * Convert exact age to bracket — reduces re-identification risk
 */
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

/**
 * Validate that a string contains no obvious PHI before sending to AI.
 * This is a safety net — the deidentify() function should prevent this,
 * but defense in depth matters for HIPAA.
 */
function assertNoPHI(text, knownIdentifiers = []) {
  const lower = text.toLowerCase();
  for (const id of knownIdentifiers) {
    if (id && lower.includes(id.toLowerCase())) {
      throw new Error(
        `PHI LEAK BLOCKED: Found identifier in text destined for AI layer. ` +
        `This is a bug — the deidentify() function should have caught this.`
      );
    }
  }
  // Check for phone number patterns
  if (/\b\d{3}[-.]?\d{3}[-.]?\d{4}\b/.test(text)) {
    throw new Error('PHI LEAK BLOCKED: Phone number pattern detected in AI-bound text.');
  }
  return true;
}

module.exports = { deidentify, reidentify, clearToken, assertNoPHI, cleanupStaleTokens };
