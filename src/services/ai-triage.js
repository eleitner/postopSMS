/**
 * AI Triage Service
 * 
 * Sends DE-IDENTIFIED clinical data to Claude for triage summarization.
 * The AI never sees patient name, phone, DOB, or any HIPAA identifier.
 * 
 * Flow:
 *   1. deidentify() strips all PHI → produces safe clinical context + token
 *   2. Claude receives: "POD 5, lap chole, pain worsening, fever 101.8"
 *   3. Claude returns: severity assessment + clinical summary
 *   4. reidentify() maps token back to patient for alert routing
 *   5. clearToken() destroys the mapping
 */
const Anthropic = require('@anthropic-ai/sdk');
const { deidentify, reidentify, clearToken, assertNoPHI } = require('../utils/deidentify');
const logger = require('../utils/logger');
const { pool, audit } = require('../utils/db');

let client = null;

function getClient() {
  if (client) return client;
  client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return client;
}

const TRIAGE_SYSTEM_PROMPT = `You are a postoperative triage assistant for a community hospital's post-discharge SMS screening program. You receive de-identified clinical data from automated patient check-ins.

Your job:
1. Assess the severity of the check-in responses
2. Provide a brief clinical summary (2-3 sentences)
3. Classify the overall severity

SEVERITY LEVELS:
- CRITICAL: Life-threatening — chest pain, breathing difficulty, uncontrolled bleeding, loss of consciousness. Requires immediate 911.
- URGENT: Requires nurse callback within 2 hours — possible SSI, DVT signs, fever in infectious window, pain >7/10, wound dehiscence, opioids beyond 3 weeks, PHQ-2 ≥ 3.
- MONITOR: Worth noting, review within 24 hours — no ambulation, urinary retention, residual sedation, no bowel movement by POD 5, wound not fully closed at POD 14.
- LOW: Routine recovery, no concerns.

IMPORTANT RULES:
- You will NEVER receive patient names, phone numbers, or any identifying information. If you see any, refuse to process and flag it.
- Respond ONLY in this JSON format:
{
  "severity": "LOW|MONITOR|URGENT|CRITICAL",
  "summary": "Brief clinical summary",
  "concerns": ["specific concern 1", "specific concern 2"],
  "recommendation": "What the triage nurse should consider"
}
- Be conservative — when in doubt, escalate up.
- Reference the clinical context (POD, procedure type, phase) in your summary.`;

/**
 * Run AI triage on a completed check-in session.
 * Returns { severity, summary, concerns, recommendation }
 */
async function triageSession(patient, session, responses) {
  // Step 1: De-identify
  const safeContext = deidentify(patient, session, responses);

  // Step 2: Safety check — assert no PHI leaked through
  const contextString = JSON.stringify(safeContext);
  try {
    assertNoPHI(contextString, [
      patient.first_name,
      patient.last_name,
      patient.phone,
      patient.id,
    ]);
  } catch (err) {
    logger.error('PHI LEAK PREVENTED', { error: err.message, sessionId: session.id });
    await audit('system', 'phi_leak_blocked', 'session', session.id, { error: err.message });
    // Fall back to protocol-only triage (no AI)
    return fallbackTriage(responses);
  }

  // Step 3: Call Claude with de-identified data only
  try {
    const anthropic = getClient();
    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 500,
      system: TRIAGE_SYSTEM_PROMPT,
      messages: [{
        role: 'user',
        content: `Triage this post-operative check-in:\n\n${JSON.stringify(safeContext, null, 2)}`
      }],
    });

    const responseText = message.content[0]?.text || '';

    // Parse AI response
    let triage;
    try {
      // Extract JSON from response (handle markdown code fences)
      const jsonMatch = responseText.match(/\{[\s\S]*\}/);
      triage = jsonMatch ? JSON.parse(jsonMatch[0]) : null;
    } catch {
      logger.warn('Failed to parse AI triage response', { responseText: responseText.substring(0, 200) });
      triage = null;
    }

    if (!triage) {
      return fallbackTriage(responses);
    }

    // Step 4: Store AI summary on session (mapped back via token)
    const mapping = reidentify(safeContext.token);
    if (mapping) {
      await pool.query(
        `UPDATE checkin_sessions SET ai_summary = $1, ai_severity = $2, ai_processed_at = NOW() WHERE id = $3`,
        [triage.summary, triage.severity, mapping.sessionId]
      );
      await audit('ai_triage', 'session_triaged', 'session', mapping.sessionId, {
        severity: triage.severity,
        concerns: triage.concerns,
      });
    }

    // Step 5: Clean up token
    clearToken(safeContext.token);

    return triage;
  } catch (err) {
    logger.error('AI triage failed — falling back to protocol rules', { error: err.message });
    clearToken(safeContext.token);
    return fallbackTriage(responses);
  }
}

/**
 * Fallback triage when AI is unavailable — uses protocol alert rules only.
 * The system always works without AI. AI is additive, not required.
 */
function fallbackTriage(responses) {
  const alerts = responses.filter(r => r.alert_triggered);
  if (alerts.length === 0) {
    return { severity: 'LOW', summary: 'No alerts triggered. Routine recovery.', concerns: [], recommendation: 'No action needed.' };
  }

  // Use highest severity from protocol alerts
  const severityOrder = { CRITICAL: 4, URGENT: 3, MONITOR: 2, LOW: 1 };
  const highest = alerts.reduce((max, a) => {
    return severityOrder[a.alert_severity] > severityOrder[max] ? a.alert_severity : max;
  }, 'LOW');

  return {
    severity: highest,
    summary: `Protocol alerts triggered: ${alerts.map(a => a.alert_reason).join('; ')}`,
    concerns: alerts.map(a => a.alert_reason),
    recommendation: highest === 'CRITICAL' ? 'Verify 911 contacted' :
                     highest === 'URGENT'   ? 'Nurse callback within 2 hours' :
                                              'Review within 24 hours',
  };
}

module.exports = { triageSession, fallbackTriage };
