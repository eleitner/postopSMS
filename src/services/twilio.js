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
 * Send a triage alert to the nurse
 */
async function sendNurseAlert(patient, session, severity, reason) {
  const nursePhone = process.env.TRIAGE_NURSE_PHONE;
  if (!nursePhone) {
    logger.error('TRIAGE_NURSE_PHONE not configured — alert not sent');
    return;
  }

  // NOTE: Nurse alerts DO contain patient identity — nurse needs to know who to call.
  // This goes to the triage nurse's phone, not to any AI system.
  const surgeonClean = (patient.surgeon_name || '').replace(/^Dr\.?\s*/i, '');
  const msg = [
    `⚠️ POSTOP ALERT [${severity}]`,
    `Patient: ${patient.first_name} ${patient.last_name} | POD ${session.pod}`,
    `Procedure: ${patient.procedure_name} (Dr. ${surgeonClean})`,
    `Issue: ${reason}`,
    severity === 'CRITICAL' ? 'ACTION: Verify 911 contacted.' :
    severity === 'URGENT'   ? 'ACTION: Callback within 2 hours.' :
                              'ACTION: Review within 24 hours.',
  ].join('\n');

  const result = await sendSMS(nursePhone, msg, { patientId: patient.id, sessionId: session.id });

  // Create alert record
  try {
    await pool.query(
      `INSERT INTO alerts (session_id, patient_id, severity, reason, source, nurse_notified_at, nurse_sms_sid)
       VALUES ($1, $2, $3, $4, $5, NOW(), $6)`,
      [session.id, patient.id, severity, reason, 'protocol', result?.sid]
    );
    await audit('system', 'alert_created', 'alert', null, { severity, reason, patientId: patient.id });
  } catch (err) {
    logger.error('Failed to create alert record', { error: err.message });
  }

  return result;
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

module.exports = { sendSMS, logInbound, sendNurseAlert, validateTwilioSignature };
