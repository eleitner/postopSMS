/**
 * Twilio SMS Service
 * 
 * Wraps all Twilio interactions with audit logging.
 * In demo mode, logs to console instead of sending real SMS.
 */
const logger = require('../utils/logger');
const { pool, audit } = require('../utils/db');

let twilioClient = null;

function getClient() {
  if (twilioClient) return twilioClient;
  if (process.env.DEMO_MODE === 'true') return null;
  
  const twilio = require('twilio');
  twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
  return twilioClient;
}

/**
 * Send an SMS message
 */
async function sendSMS(to, body, { patientId = null, sessionId = null } = {}) {
  const from = process.env.TWILIO_FROM_NUMBER;

  // Log to database
  let smsId;
  try {
    const result = await pool.query(
      `INSERT INTO sms_log (patient_id, session_id, direction, phone_to, phone_from, body)
       VALUES ($1, $2, 'outbound', $3, $4, $5) RETURNING id`,
      [patientId, sessionId, to, from, body]
    );
    smsId = result.rows[0].id;
  } catch (err) {
    logger.error('Failed to log outbound SMS', { error: err.message });
  }

  // Send via Twilio or log in demo mode
  if (process.env.DEMO_MODE === 'true') {
    logger.info('DEMO SMS', { to, bodyLength: body.length, preview: body.substring(0, 80) });
    return { sid: `DEMO_${Date.now()}`, status: 'demo' };
  }

  try {
    const client = getClient();
    const message = await client.messages.create({
      to,
      from,
      body,
      statusCallback: process.env.TWILIO_STATUS_CALLBACK_URL || undefined,
    });

    // Update SMS log with Twilio SID
    if (smsId) {
      await pool.query(
        `UPDATE sms_log SET twilio_sid = $1, twilio_status = $2 WHERE id = $3`,
        [message.sid, message.status, smsId]
      );
    }

    await audit('system', 'sms_sent', 'sms_log', smsId, { direction: 'outbound' });
    return message;
  } catch (err) {
    logger.error('Twilio send failed', { to, error: err.message });
    throw err;
  }
}

/**
 * Log an inbound SMS
 */
async function logInbound(from, body, { patientId = null, sessionId = null, twilioSid = null } = {}) {
  try {
    const result = await pool.query(
      `INSERT INTO sms_log (patient_id, session_id, direction, phone_to, phone_from, body, twilio_sid)
       VALUES ($1, $2, 'inbound', $3, $4, $5, $6) RETURNING id`,
      [patientId, sessionId, process.env.TWILIO_FROM_NUMBER, from, body, twilioSid]
    );
    await audit('system', 'sms_received', 'sms_log', result.rows[0].id, { direction: 'inbound' });
    return result.rows[0].id;
  } catch (err) {
    logger.error('Failed to log inbound SMS', { error: err.message });
  }
}

/**
 * Send a triage alert to the nurse WITH numbered disposition options.
 * Nurse can reply with a number to instantly send the template response to the patient.
 */
async function sendNurseAlert(patient, session, severity, reason) {
  const { getTemplatesForAlert } = require('./nurse-templates');

  // Per-surgeon triage nurse routing: check surgeon → fallback to env
  let nursePhone = process.env.TRIAGE_NURSE_PHONE;
  
  try {
    if (patient.surgeon_id) {
      const surgeonResult = await pool.query(
        'SELECT triage_nurse_phone, name FROM surgeons WHERE id = $1',
        [patient.surgeon_id]
      );
      if (surgeonResult.rows[0]?.triage_nurse_phone) {
        nursePhone = surgeonResult.rows[0].triage_nurse_phone;
        logger.info('Using per-surgeon triage nurse', { surgeon: surgeonResult.rows[0].name });
      }
    } else if (patient.surgeon_name) {
      // Fallback: match by name if no surgeon_id FK
      const surgeonResult = await pool.query(
        `SELECT triage_nurse_phone, name FROM surgeons WHERE active = TRUE AND LOWER(name) = LOWER($1)`,
        [patient.surgeon_name]
      );
      if (surgeonResult.rows[0]?.triage_nurse_phone) {
        nursePhone = surgeonResult.rows[0].triage_nurse_phone;
      }
    }
  } catch (err) {
    logger.warn('Surgeon lookup failed for alert routing, using default', { error: err.message });
  }

  if (!nursePhone) {
    logger.error('No triage nurse phone configured — alert not sent');
    return;
  }

  // Infer alert type for template lookup
  const alertType = inferAlertTypeFromReason(reason);
  const templates = getTemplatesForAlert(alertType);

  // NOTE: Nurse alerts DO contain patient identity — nurse needs to know who to call.
  const surgeonClean = (patient.surgeon_name || '').replace(/^Dr\.?\s*/i, '');
  const msgLines = [
    `⚠️ POSTOP ALERT [${severity}]`,
    `Patient: ${patient.first_name} ${patient.last_name} | POD ${session.pod}`,
    `Procedure: ${patient.procedure_name} (Dr. ${surgeonClean})`,
    `Issue: ${reason}`,
    '',
    severity === 'CRITICAL' ? 'ACTION: Verify 911 contacted.' :
    severity === 'URGENT'   ? 'ACTION: Callback within 2 hours.' :
                              'ACTION: Review within 24 hours.',
    '',
    'Reply with a number:',
  ];

  // Add numbered disposition options
  templates.dispositions.forEach((d, i) => {
    msgLines.push(`${i + 1}. ${d.label}`);
  });

  msgLines.push('', 'Or reply NOTE <text> to add a note.');

  const msg = msgLines.join('\n');
  const result = await sendSMS(nursePhone, msg, { patientId: patient.id, sessionId: session.id });

  // Create alert record and track nurse pending reply
  let alertId = null;
  try {
    const alertResult = await pool.query(
      `INSERT INTO alerts (session_id, patient_id, severity, reason, source, nurse_notified_at, nurse_sms_sid)
       VALUES ($1, $2, $3, $4, $5, NOW(), $6) RETURNING id`,
      [session.id, patient.id, severity, reason, 'protocol', result?.sid]
    );
    alertId = alertResult.rows[0]?.id;
    await audit('system', 'alert_created', 'alert', alertId, { severity, reason, patientId: patient.id });

    // Track this as the nurse's pending reply target
    if (alertId && nursePhone) {
      await setNursePendingAlert(nursePhone, alertId, templates.templateKey);
    }
  } catch (err) {
    logger.error('Failed to create alert record', { error: err.message });
  }

  return result;
}

/**
 * Track which alert a nurse is expected to reply to.
 * When nurse texts back "2", we look up their pending alert and fire disposition #2.
 * Uses upsert — each nurse phone has at most one pending alert at a time.
 */
async function setNursePendingAlert(nursePhone, alertId, templateKey) {
  try {
    await pool.query(`
      INSERT INTO nurse_pending_replies (nurse_phone, alert_id, template_key)
      VALUES ($1, $2, $3)
      ON CONFLICT (nurse_phone) 
      DO UPDATE SET alert_id = $2, template_key = $3, created_at = NOW()
    `, [nursePhone, alertId, templateKey]);
  } catch (err) {
    // Table might not exist yet — log and continue
    logger.warn('Failed to set nurse pending reply (migration needed?)', { error: err.message });
  }
}

/**
 * Get the nurse's pending alert for reply routing.
 */
async function getNursePendingAlert(nursePhone) {
  try {
    const result = await pool.query(`
      SELECT npr.*, a.patient_id, a.severity, a.reason, a.status as alert_status
      FROM nurse_pending_replies npr
      JOIN alerts a ON a.id = npr.alert_id
      WHERE npr.nurse_phone = $1
        AND npr.created_at > NOW() - INTERVAL '24 hours'
        AND a.status IN ('open', 'pending_assessment')
      ORDER BY npr.created_at DESC LIMIT 1
    `, [nursePhone]);
    return result.rows[0] || null;
  } catch (err) {
    logger.warn('Failed to get nurse pending reply', { error: err.message });
    return null;
  }
}

/**
 * Clear a nurse's pending reply after disposition is sent.
 */
async function clearNursePendingAlert(nursePhone) {
  try {
    await pool.query('DELETE FROM nurse_pending_replies WHERE nurse_phone = $1', [nursePhone]);
  } catch (err) {
    logger.warn('Failed to clear nurse pending reply', { error: err.message });
  }
}

/**
 * Infer alert type from reason text — used for template matching in SMS alerts.
 * Mirrors the logic in alerts.js but usable without the full alert row.
 */
function inferAlertTypeFromReason(reason) {
  const lower = (reason || '').toLowerCase();
  if (lower.includes('ssi') || lower.includes('redness') || lower.includes('discharge')) return 'redness';
  if (lower.includes('dvt') || lower.includes('leg swell')) return 'leg_swelling';
  if (lower.includes('pain')) return 'pain';
  if (lower.includes('fever')) return 'fever';
  if (lower.includes('opioid')) return 'still_opioids';
  if (lower.includes('phq') || lower.includes('depression')) return 'phq_mood';
  if (lower.includes('dehiscence') || lower.includes('wound_open')) return 'wound_open';
  if (lower.includes('seroma') || lower.includes('fluid_bulge')) return 'fluid_bulge';
  if (lower.includes('photo')) return 'photo';
  if (lower.includes('bleeding')) return 'bleeding';
  return 'conversation';
}

/**
 * Validate Twilio webhook signature (production security)
 */
function validateTwilioSignature(req) {
  if (process.env.DEMO_MODE === 'true') return true;
  
  const twilio = require('twilio');
  const signature = req.headers['x-twilio-signature'];
  const url = process.env.BASE_URL + req.originalUrl;
  const params = req.body;
  
  return twilio.validateRequest(
    process.env.TWILIO_AUTH_TOKEN,
    signature,
    url,
    params
  );
}

module.exports = { sendSMS, logInbound, sendNurseAlert, validateTwilioSignature, getNursePendingAlert, clearNursePendingAlert, setNursePendingAlert };
