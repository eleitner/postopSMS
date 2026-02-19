/**
 * SMS Webhook Route
 * 
 * POST /api/sms/inbound  — Twilio sends inbound messages here
 * POST /api/sms/status    — Twilio delivery status callbacks
 */
const express = require('express');
const router = express.Router();
const { processInbound } = require('../services/session-manager');
const { validateTwilioSignature } = require('../services/twilio');
const { pool } = require('../utils/db');
const logger = require('../utils/logger');

/**
 * Twilio signature validation middleware
 */
function twilioAuth(req, res, next) {
  if (process.env.DEMO_MODE === 'true') return next();
  
  if (!validateTwilioSignature(req)) {
    logger.warn('Invalid Twilio signature', { ip: req.ip });
    return res.status(403).send('Forbidden');
  }
  next();
}

/**
 * POST /api/sms/inbound
 * Twilio webhook for incoming patient messages
 */
router.post('/inbound', express.urlencoded({ extended: false }), twilioAuth, async (req, res) => {
  const { From: from, Body: body, MessageSid: sid } = req.body;

  if (!from || !body) {
    return res.status(400).send('<Response></Response>');
  }

  try {
    const result = await processInbound(from, body, sid);
    logger.info('Inbound processed', { from: from.slice(-4), type: result.type });
  } catch (err) {
    logger.error('Inbound processing error', { error: err.message, from: from.slice(-4) });
  }

  // Twilio expects a TwiML response (empty = no auto-reply, we handle replies ourselves)
  res.type('text/xml').send('<Response></Response>');
});

/**
 * POST /api/sms/status
 * Twilio delivery status callback
 */
router.post('/status', express.urlencoded({ extended: false }), twilioAuth, async (req, res) => {
  const { MessageSid: sid, MessageStatus: status } = req.body;

  if (sid && status) {
    try {
      await pool.query(
        `UPDATE sms_log SET twilio_status = $1 WHERE twilio_sid = $2`,
        [status, sid]
      );
    } catch (err) {
      logger.error('Status callback update failed', { error: err.message });
    }
  }

  res.sendStatus(200);
});

module.exports = router;
