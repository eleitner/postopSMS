/**
 * Dashboard API — Alerts, Analytics, Auth, Journey, Export
 */
const express = require('express');
const router = express.Router();
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { pool, audit } = require('../utils/db');
const { authenticate, requireRole } = require('../middleware/auth');
const { startCheckin } = require('../services/session-manager');
const { getPhaseForPOD } = require('../services/protocols');
const logger = require('../utils/logger');

// ═══════════════════ AUTH ═══════════════════

router.post('/auth/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
  try {
    const user = (await pool.query('SELECT * FROM users WHERE email = $1 AND active = TRUE', [email])).rows[0];
    if (!user) return res.status(401).json({ error: 'Invalid credentials' });
    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) return res.status(401).json({ error: 'Invalid credentials' });
    const token = jwt.sign(
      { userId: user.id, email: user.email, name: user.name, role: user.role },
      process.env.JWT_SECRET, { expiresIn: '12h' }
    );
    await pool.query('UPDATE users SET last_login_at = NOW() WHERE id = $1', [user.id]);
    await audit(email, 'login', 'user', user.id, {}, req.ip);
    res.json({ token, user: { id: user.id, name: user.name, email: user.email, role: user.role } });
  } catch (err) {
    logger.error('Login failed', { error: err.message });
    res.status(500).json({ error: 'Login failed' });
  }
});

router.post('/auth/setup', async (req, res) => {
  const { email, password, name } = req.body;
  if (!email || !password || !name) return res.status(400).json({ error: 'Email, password, and name required' });
  try {
    const count = (await pool.query('SELECT COUNT(*) FROM users')).rows[0].count;
    if (parseInt(count) > 0) return res.status(403).json({ error: 'Setup already completed. Use login.' });
    const hash = await bcrypt.hash(password, 12);
    const user = (await pool.query(
      `INSERT INTO users (email, password_hash, name, role) VALUES ($1, $2, $3, 'admin') RETURNING id`,
      [email, hash, name]
    )).rows[0];
    await audit('system', 'admin_created', 'user', user.id, { email }, req.ip);
    res.status(201).json({ message: 'Admin user created. Please login.' });
  } catch (err) {
    logger.error('Setup failed', { error: err.message });
    res.status(500).json({ error: 'Setup failed' });
  }
});

router.post('/auth/users', authenticate, requireRole('admin'), async (req, res) => {
  const { email, password, name, role } = req.body;
  if (!email || !password || !name || !role) return res.status(400).json({ error: 'All fields required' });
  if (!['admin', 'triage_nurse', 'resident', 'viewer'].includes(role)) return res.status(400).json({ error: 'Invalid role' });
  try {
    const hash = await bcrypt.hash(password, 12);
    const user = (await pool.query(
      `INSERT INTO users (email, password_hash, name, role) VALUES ($1, $2, $3, $4) RETURNING id, email, name, role`,
      [email, hash, name, role]
    )).rows[0];
    await audit(req.user.email, 'user_created', 'user', user.id, { role }, req.ip);
    res.status(201).json(user);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Email already exists' });
    res.status(500).json({ error: 'Failed to create user' });
  }
});

// ═══════════════════ ALERTS ═══════════════════

router.get('/dashboard/alerts', authenticate, async (req, res) => {
  const { status = 'open', severity } = req.query;
  let query = `
    SELECT a.id, a.severity, a.reason, a.source, a.status, a.created_at,
      a.acknowledged_by, a.acknowledged_at, a.resolved_by, a.resolved_at,
      a.resolution_note, a.callback_outcome,
      LEFT(p.id::text, 8) as patient_id_short, p.id as patient_id_full,
      p.surgeon_name, p.procedure_name, p.first_name, p.last_name,
      cs.phase, cs.pod, cs.ai_summary, cs.ai_severity
    FROM alerts a
    JOIN patients p ON p.id = a.patient_id
    LEFT JOIN checkin_sessions cs ON cs.id = a.session_id
    WHERE a.status = $1`;
  const params = [status];
  if (severity) { params.push(severity); query += ` AND a.severity = $${params.length}`; }
  query += ` ORDER BY CASE a.severity WHEN 'CRITICAL' THEN 1 WHEN 'URGENT' THEN 2 WHEN 'MONITOR' THEN 3 ELSE 4 END, a.created_at DESC`;
  try {
    const result = await pool.query(query, params);
    res.json({ alerts: result.rows });
  } catch (err) {
    logger.error('Alerts query failed', { error: err.message });
    res.status(500).json({ error: 'Failed to retrieve alerts' });
  }
});

router.patch('/dashboard/alerts/:id', authenticate, requireRole('admin', 'triage_nurse'), async (req, res) => {
  const { action, note, callbackOutcome } = req.body;
  if (!['acknowledge', 'resolve', 'escalate'].includes(action)) return res.status(400).json({ error: 'Invalid action' });
  try {
    let query, params;
    if (action === 'acknowledge') {
      query = `UPDATE alerts SET status = 'acknowledged', acknowledged_by = $1, acknowledged_at = NOW() WHERE id = $2 RETURNING *`;
      params = [req.user.email, req.params.id];
    } else if (action === 'resolve') {
      query = `UPDATE alerts SET status = 'resolved', resolved_by = $1, resolved_at = NOW(), resolution_note = $2, callback_made = TRUE, callback_at = NOW(), callback_outcome = $3 WHERE id = $4 RETURNING *`;
      params = [req.user.email, note, callbackOutcome || 'no_action', req.params.id];
    } else {
      query = `UPDATE alerts SET status = 'escalated', resolution_note = $1 WHERE id = $2 RETURNING *`;
      params = [note || 'Escalated', req.params.id];
    }
    const result = await pool.query(query, params);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Alert not found' });
    await audit(req.user.email, `alert_${action}`, 'alert', req.params.id, { note, callbackOutcome }, req.ip);
    res.json({ alert: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update alert' });
  }
});

// ═══════════════════ PATIENTS LIST ═══════════════════

router.get('/dashboard/patients', authenticate, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT p.id, p.first_name, p.last_name, p.surgeon_name, p.procedure_name,
        p.surgery_date, p.status, p.asa_class, p.age_at_surgery, p.pre_surgical_goal,
        (CURRENT_DATE - p.surgery_date) as pod,
        (SELECT COUNT(*) FROM checkin_sessions cs WHERE cs.patient_id = p.id AND cs.status = 'completed') as completed_checkins,
        (SELECT string_agg(cs.phase, ',' ORDER BY cs.pod) FROM checkin_sessions cs WHERE cs.patient_id = p.id AND cs.status = 'completed') as completed_phases,
        (SELECT cs.ai_severity FROM checkin_sessions cs WHERE cs.patient_id = p.id AND cs.status = 'completed' AND cs.ai_severity IS NOT NULL ORDER BY cs.completed_at DESC LIMIT 1) as latest_severity,
        (SELECT COUNT(*) FROM alerts a WHERE a.patient_id = p.id AND a.status = 'open') as open_alerts
      FROM patients p
      ORDER BY CASE p.status WHEN 'active' THEN 1 WHEN 'enrolled' THEN 2 WHEN 'completed' THEN 3 ELSE 4 END, p.surgery_date DESC
    `);
    res.json({ patients: result.rows });
  } catch (err) {
    logger.error('Patient list failed', { error: err.message });
    res.status(500).json({ error: 'Failed to retrieve patients' });
  }
});

// ═══════════════════ PATIENT JOURNEY ═══════════════════

router.get('/dashboard/patients/:id', authenticate, async (req, res) => {
  try {
    const patient = (await pool.query(`
      SELECT id, first_name, last_name, surgeon_name, procedure_name,
        surgery_date, status, asa_class, age_at_surgery, pre_surgical_goal,
        enrolled_at, completed_at, (CURRENT_DATE - surgery_date) as pod
      FROM patients WHERE id = $1`, [req.params.id])).rows[0];
    if (!patient) return res.status(404).json({ error: 'Patient not found' });

    const sessions = (await pool.query(`
      SELECT id, phase, pod, status, started_at, completed_at,
        ai_summary, ai_severity, ai_processed_at, responses, current_question_index
      FROM checkin_sessions WHERE patient_id = $1 ORDER BY pod ASC, created_at ASC`, [req.params.id])).rows;

    const responses = (await pool.query(`
      SELECT question_key, question_text, response_raw, response_parsed,
        response_type, phase, pod, alert_triggered, alert_severity, alert_reason, created_at
      FROM responses WHERE patient_id = $1 ORDER BY created_at ASC`, [req.params.id])).rows;

    const alerts = (await pool.query(`
      SELECT id, severity, reason, source, status, created_at,
        acknowledged_by, acknowledged_at, resolved_by, resolved_at, resolution_note, callback_outcome
      FROM alerts WHERE patient_id = $1 ORDER BY created_at DESC`, [req.params.id])).rows;

    const painData = responses.filter(r => r.question_key === 'pain' || r.question_key === 'pain_trend')
      .map(r => ({ pod: r.pod, value: r.question_key === 'pain' ? parseInt(r.response_parsed) || null : null, trend: r.question_key === 'pain_trend' ? r.response_parsed : null, phase: r.phase }));
    const opioidData = responses.filter(r => ['opioids', 'still_opioids'].includes(r.question_key))
      .map(r => ({ pod: r.pod, key: r.question_key, value: r.response_parsed, phase: r.phase }));

    await audit(req.user.email, 'patient_viewed', 'patient', req.params.id, {}, req.ip);
    res.json({ patient, sessions, responses, alerts, trajectories: { pain: painData, opioids: opioidData } });
  } catch (err) {
    logger.error('Patient journey failed', { error: err.message });
    res.status(500).json({ error: 'Failed to retrieve patient journey' });
  }
});

// ═══════════════════ MANUAL TRIGGER ═══════════════════

router.post('/dashboard/trigger', authenticate, requireRole('admin'), async (req, res) => {
  const { patientId, phase } = req.body;
  try {
    let patient;
    if (patientId) {
      patient = (await pool.query('SELECT * FROM patients WHERE id = $1', [patientId])).rows[0];
    } else {
      patient = (await pool.query(`SELECT * FROM patients WHERE status IN ('enrolled','active') ORDER BY created_at DESC LIMIT 1`)).rows[0];
    }
    if (!patient) return res.json({ status: 'no patients found' });
    const pod = Math.floor((Date.now() - new Date(patient.surgery_date).getTime()) / 86400000);
    const targetPhase = phase || getPhaseForPOD(pod) || 'pod0';
    const podMap = { pod0: 0, acute: 2, infectious: 5, late: 14, recovery: 21, closure: 30 };
    const targetPod = phase ? (podMap[phase] || pod) : pod;
    const session = await startCheckin(patient.id, targetPhase, targetPod);
    res.json({ status: 'check-in started', patientId: patient.id, phase: targetPhase, pod: targetPod, sessionId: session.id });
  } catch (err) {
    logger.error('Manual trigger failed', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════ STATS ═══════════════════

router.get('/dashboard/stats', authenticate, async (req, res) => {
  try {
    const stats = {};
    const enrollment = (await pool.query(`SELECT status, COUNT(*) FROM patients GROUP BY status`)).rows;
    stats.enrollment = enrollment.reduce((acc, r) => { acc[r.status] = parseInt(r.count); return acc; }, {});
    stats.totalEnrolled = enrollment.reduce((acc, r) => acc + parseInt(r.count), 0);

    const engagement = (await pool.query(`
      SELECT p.id, COUNT(cs.id) as completed_checkins FROM patients p
      LEFT JOIN checkin_sessions cs ON cs.patient_id = p.id AND cs.status = 'completed'
      WHERE p.status IN ('active', 'completed') GROUP BY p.id`)).rows;
    stats.engagementRate = engagement.length > 0 ? (engagement.filter(e => parseInt(e.completed_checkins) >= 4).length / engagement.length * 100).toFixed(1) : '0';

    stats.alerts = {};
    const alertRows = (await pool.query(`SELECT severity, status, COUNT(*) as cnt FROM alerts GROUP BY severity, status`)).rows;
    stats.alerts.total = alertRows.reduce((a, r) => a + parseInt(r.cnt), 0);
    stats.alerts.open = alertRows.filter(r => r.status === 'open').reduce((a, r) => a + parseInt(r.cnt), 0);
    stats.alerts.bySeverity = {};
    for (const r of alertRows) { stats.alerts.bySeverity[r.severity] = (stats.alerts.bySeverity[r.severity] || 0) + parseInt(r.cnt); }

    const aiStats = (await pool.query(`SELECT ai_severity, COUNT(*) as cnt FROM checkin_sessions WHERE ai_processed_at IS NOT NULL GROUP BY ai_severity`)).rows;
    stats.aiTriage = { processed: aiStats.reduce((a, r) => a + parseInt(r.cnt), 0), bySeverity: aiStats.reduce((a, r) => { a[r.ai_severity] = parseInt(r.cnt); return a; }, {}) };

    const phases = (await pool.query(`SELECT phase, status, COUNT(*) as cnt FROM checkin_sessions GROUP BY phase, status`)).rows;
    stats.phaseCompletion = {};
    for (const r of phases) { if (!stats.phaseCompletion[r.phase]) stats.phaseCompletion[r.phase] = {}; stats.phaseCompletion[r.phase][r.status] = parseInt(r.cnt); }

    const phq2 = (await pool.query(`
      SELECT r1.patient_id, (r1.response_parsed::int + r2.response_parsed::int) as total
      FROM responses r1 JOIN responses r2 ON r1.patient_id = r2.patient_id AND r1.session_id = r2.session_id
      WHERE r1.question_key = 'phq_interest' AND r2.question_key = 'phq_mood'
        AND r1.response_parsed ~ '^[0-3]$' AND r2.response_parsed ~ '^[0-3]$'`)).rows;
    stats.phq2 = { screened: phq2.length, positive: phq2.filter(p => p.total >= 3).length };

    res.json(stats);
  } catch (err) {
    logger.error('Stats failed', { error: err.message });
    res.status(500).json({ error: 'Failed to retrieve stats' });
  }
});

// ═══════════════════ CSV EXPORT ═══════════════════

router.get('/dashboard/export/:type', authenticate, async (req, res) => {
  const { type } = req.params;
  try {
    let rows, filename;
    const queries = {
      responses: { q: `SELECT LEFT(r.patient_id::text, 8) as pid, p.procedure_name, p.surgeon_name, p.asa_class, p.age_at_surgery, r.phase, r.pod, r.question_key, r.response_raw, r.response_parsed, r.alert_triggered, r.alert_severity, r.alert_reason, r.created_at FROM responses r JOIN patients p ON p.id = r.patient_id ORDER BY r.patient_id, r.pod, r.created_at`, f: 'postop_responses.csv' },
      pain: { q: `SELECT LEFT(patient_id::text, 8) as pid, procedure_name, surgeon_name, pod, phase, pain_score, pain_value, created_at FROM v_pain_trajectory`, f: 'pain_trajectory.csv' },
      opioids: { q: `SELECT LEFT(patient_id::text, 8) as pid, procedure_name, pod, phase, question_key, response_parsed, created_at FROM v_opioid_trajectory`, f: 'opioid_trajectory.csv' },
      alerts: { q: `SELECT LEFT(a.patient_id::text, 8) as pid, p.procedure_name, a.severity, a.reason, a.source, a.status, cs.phase, cs.pod, a.callback_outcome, a.resolution_note, a.created_at, a.resolved_at FROM alerts a JOIN patients p ON p.id = a.patient_id LEFT JOIN checkin_sessions cs ON cs.id = a.session_id ORDER BY a.created_at DESC`, f: 'alerts_export.csv' },
      patients: { q: `SELECT LEFT(p.id::text, 8) as pid, p.procedure_name, p.surgeon_name, p.asa_class, p.age_at_surgery, p.surgery_date, p.status, p.pre_surgical_goal, (CURRENT_DATE - p.surgery_date) as pod, (SELECT COUNT(*) FROM checkin_sessions cs WHERE cs.patient_id = p.id AND cs.status = 'completed') as checkins, (SELECT COUNT(*) FROM alerts a WHERE a.patient_id = p.id) as alerts, p.enrolled_at FROM patients p ORDER BY p.surgery_date DESC`, f: 'patients_export.csv' },
      sessions: { q: `SELECT LEFT(cs.patient_id::text, 8) as pid, p.procedure_name, cs.phase, cs.pod, cs.status, cs.ai_summary, cs.ai_severity, cs.started_at, cs.completed_at FROM checkin_sessions cs JOIN patients p ON p.id = cs.patient_id ORDER BY cs.started_at DESC`, f: 'sessions_export.csv' },
    };
    if (!queries[type]) return res.status(400).json({ error: 'Invalid type. Options: responses, pain, opioids, alerts, patients, sessions' });
    rows = (await pool.query(queries[type].q)).rows;
    filename = queries[type].f;

    const escape = (v) => { if (v == null) return ''; const s = String(v); return s.includes(',') || s.includes('"') || s.includes('\n') ? '"' + s.replace(/"/g, '""') + '"' : s; };
    const headers = rows.length > 0 ? Object.keys(rows[0]) : [];
    const csv = [headers.join(','), ...rows.map(r => Object.values(r).map(escape).join(','))].join('\n');

    await audit(req.user.email, 'data_exported', null, null, { type, rows: rows.length }, req.ip);
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(csv);
  } catch (err) {
    logger.error('Export failed', { error: err.message });
    res.status(500).json({ error: 'Export failed' });
  }
});

module.exports = router;
