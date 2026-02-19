/**
 * Patient Enrollment API
 * 
 * POST /api/patients         — Enroll a new patient
 * GET  /api/patients          — List patients (dashboard)
 * GET  /api/patients/:id      — Get patient detail + timeline
 */
const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const { pool, audit } = require('../utils/db');
const { authenticate, requireRole } = require('../middleware/auth');
const logger = require('../utils/logger');

/**
 * POST /api/patients — Enroll a new surgical patient
 * Called by the surgical team at pre-discharge (~2 min per patient)
 */
router.post('/', authenticate, requireRole('admin', 'triage_nurse', 'resident'), async (req, res) => {
  const { firstName, lastName, phone, surgeonName, procedure, surgeryDate, preSurgicalGoal, asaClass, age } = req.body;

  // Validation
  if (!firstName || !lastName || !phone || !surgeonName || !procedure || !surgeryDate) {
    return res.status(400).json({ error: 'Missing required fields: firstName, lastName, phone, surgeonName, procedure, surgeryDate' });
  }

  // Normalize phone
  const cleanPhone = phone.replace(/[^+\d]/g, '');
  if (!/^\+1\d{10}$/.test(cleanPhone)) {
    return res.status(400).json({ error: 'Phone must be in E.164 format: +1XXXXXXXXXX' });
  }

  const phoneHash = crypto.createHash('sha256').update(cleanPhone).digest('hex');

  try {
    // Check for duplicate enrollment
    const existing = await pool.query(
      `SELECT id FROM patients WHERE phone_hash = $1 AND status IN ('enrolled', 'active') AND surgery_date = $2`,
      [phoneHash, surgeryDate]
    );
    if (existing.rows.length > 0) {
      return res.status(409).json({ error: 'Patient already enrolled for this surgery date' });
    }

    const result = await pool.query(
      `INSERT INTO patients (first_name, last_name, phone, phone_hash, surgeon_name, procedure_name, surgery_date, pre_surgical_goal, asa_class, age_at_surgery)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id, status, enrolled_at`,
      [firstName, lastName, cleanPhone, phoneHash, surgeonName, procedure, surgeryDate, preSurgicalGoal || null, asaClass || null, age || null]
    );

    const patient = result.rows[0];
    await audit(req.user.email, 'patient_enrolled', 'patient', patient.id, {
      procedure, surgeonName, surgeryDate,
    }, req.ip);

    logger.info('Patient enrolled', { patientId: patient.id, procedure });

    res.status(201).json({
      id: patient.id,
      status: patient.status,
      enrolledAt: patient.enrolled_at,
      message: `Patient enrolled. First check-in (POD 0) will be sent at 6 PM on ${surgeryDate}.`,
    });
  } catch (err) {
    logger.error('Enrollment failed', { error: err.message });
    res.status(500).json({ error: 'Enrollment failed' });
  }
});

/**
 * GET /api/patients — List enrolled patients
 */
router.get('/', authenticate, async (req, res) => {
  const { status, surgeon, limit = 50, offset = 0 } = req.query;
  let query = `SELECT LEFT(id::text, 8) as patient_id_short, id, surgeon_name, procedure_name, surgery_date, status, 
    (CURRENT_DATE - surgery_date) as current_pod, enrolled_at
    FROM patients WHERE 1=1`;
  const params = [];

  if (status) {
    params.push(status);
    query += ` AND status = $${params.length}`;
  }
  if (surgeon) {
    params.push(`%${surgeon}%`);
    query += ` AND surgeon_name ILIKE $${params.length}`;
  }

  query += ` ORDER BY surgery_date DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
  params.push(limit, offset);

  try {
    const result = await pool.query(query, params);
    const count = await pool.query(`SELECT COUNT(*) FROM patients`);
    
    await audit(req.user.email, 'patients_viewed', null, null, { count: result.rows.length }, req.ip);

    res.json({ patients: result.rows, total: parseInt(count.rows[0].count) });
  } catch (err) {
    logger.error('Patient list failed', { error: err.message });
    res.status(500).json({ error: 'Failed to retrieve patients' });
  }
});

/**
 * GET /api/patients/:id — Full patient detail with timeline
 */
router.get('/:id', authenticate, async (req, res) => {
  try {
    const patient = (await pool.query(
      `SELECT LEFT(id::text, 8) as patient_id_short, id, surgeon_name, procedure_name, surgery_date, 
        pre_surgical_goal, asa_class, age_at_surgery, status, enrolled_at, completed_at,
        (CURRENT_DATE - surgery_date) as current_pod
       FROM patients WHERE id = $1`,
      [req.params.id]
    )).rows[0];

    if (!patient) return res.status(404).json({ error: 'Patient not found' });

    // Get all sessions
    const sessions = (await pool.query(
      `SELECT id, phase, pod, status, started_at, completed_at, ai_summary, ai_severity, responses
       FROM checkin_sessions WHERE patient_id = $1 ORDER BY pod`,
      [req.params.id]
    )).rows;

    // Get all alerts
    const alerts = (await pool.query(
      `SELECT severity, reason, source, status, callback_outcome, created_at
       FROM alerts WHERE patient_id = $1 ORDER BY created_at`,
      [req.params.id]
    )).rows;

    // Get pain + opioid trajectory
    const painData = (await pool.query(
      `SELECT pod, response_parsed as value, question_key FROM responses
       WHERE patient_id = $1 AND question_key IN ('pain', 'pain_trend') ORDER BY pod`,
      [req.params.id]
    )).rows;

    const opioidData = (await pool.query(
      `SELECT pod, response_parsed as value, question_key FROM responses
       WHERE patient_id = $1 AND question_key IN ('opioids', 'still_opioids') ORDER BY pod`,
      [req.params.id]
    )).rows;

    await audit(req.user.email, 'patient_detail_viewed', 'patient', req.params.id, {}, req.ip);

    res.json({ patient, sessions, alerts, painTrajectory: painData, opioidTrajectory: opioidData });
  } catch (err) {
    logger.error('Patient detail failed', { error: err.message });
    res.status(500).json({ error: 'Failed to retrieve patient' });
  }
});

module.exports = router;
