/**
 * Dashboard API — Alerts, Analytics, Auth
 * 
 * GET  /api/dashboard/alerts       — Open alerts for triage nurse
 * PATCH /api/dashboard/alerts/:id  — Acknowledge/resolve alert
 * GET  /api/dashboard/stats        — Aggregate statistics
 * POST /api/auth/login             — Login
 * POST /api/auth/setup             — First-time admin setup
 */
const express = require('express');
const router = express.Router();
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { pool, audit } = require('../utils/db');
const { authenticate, requireRole } = require('../middleware/auth');
const logger = require('../utils/logger');

// ═══════════════════════════════════════════════════
// AUTH
// ═══════════════════════════════════════════════════

/**
 * POST /api/auth/login
 */
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
      process.env.JWT_SECRET,
      { expiresIn: '12h' }
    );

    await pool.query('UPDATE users SET last_login_at = NOW() WHERE id = $1', [user.id]);
    await audit(email, 'login', 'user', user.id, {}, req.ip);

    res.json({ token, user: { id: user.id, name: user.name, email: user.email, role: user.role } });
  } catch (err) {
    logger.error('Login failed', { error: err.message });
    res.status(500).json({ error: 'Login failed' });
  }
});

/**
 * POST /api/auth/setup — Create initial admin user (only works when no users exist)
 */
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

// ═══════════════════════════════════════════════════
// ALERTS (Triage Nurse View)
// ═══════════════════════════════════════════════════

/**
 * GET /api/dashboard/alerts — Open alerts
 */
router.get('/dashboard/alerts', authenticate, async (req, res) => {
  const { status = 'open', severity } = req.query;

  let query = `
    SELECT a.id, a.severity, a.reason, a.source, a.status, a.created_at, a.callback_outcome,
      LEFT SUBSTRING(p.id::text, 1, 8) as patient_id_short,
      p.surgeon_name, p.procedure_name,
      cs.phase, cs.pod, cs.ai_summary
    FROM alerts a
    JOIN patients p ON p.id = a.patient_id
    LEFT JOIN checkin_sessions cs ON cs.id = a.session_id
    WHERE a.status = $1`;
  const params = [status];

  if (severity) {
    params.push(severity);
    query += ` AND a.severity = $${params.length}`;
  }
  query += ` ORDER BY CASE a.severity WHEN 'CRITICAL' THEN 1 WHEN 'URGENT' THEN 2 WHEN 'MONITOR' THEN 3 ELSE 4 END, a.created_at DESC`;

  try {
    const result = await pool.query(query, params);
    await audit(req.user.email, 'alerts_viewed', null, null, { count: result.rows.length, status }, req.ip);
    res.json({ alerts: result.rows });
  } catch (err) {
    res.status(500).json({ error: 'Failed to retrieve alerts' });
  }
});

/**
 * PATCH /api/dashboard/alerts/:id — Acknowledge or resolve
 */
router.patch('/dashboard/alerts/:id', authenticate, requireRole('admin', 'triage_nurse'), async (req, res) => {
  const { action, note, callbackOutcome } = req.body;

  if (!['acknowledge', 'resolve', 'escalate'].includes(action)) {
    return res.status(400).json({ error: 'Action must be: acknowledge, resolve, or escalate' });
  }

  try {
    let query, params;
    if (action === 'acknowledge') {
      query = `UPDATE alerts SET status = 'acknowledged', acknowledged_by = $1, acknowledged_at = NOW() WHERE id = $2 RETURNING *`;
      params = [req.user.email, req.params.id];
    } else if (action === 'resolve') {
      query = `UPDATE alerts SET status = 'resolved', resolved_by = $1, resolved_at = NOW(), resolution_note = $2, 
        callback_made = TRUE, callback_at = NOW(), callback_outcome = $3 WHERE id = $4 RETURNING *`;
      params = [req.user.email, note, callbackOutcome || 'no_action', req.params.id];
    } else {
      query = `UPDATE alerts SET status = 'escalated', resolution_note = $1 WHERE id = $2 RETURNING *`;
      params = [note || 'Escalated by triage nurse', req.params.id];
    }

    const result = await pool.query(query, params);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Alert not found' });

    await audit(req.user.email, `alert_${action}`, 'alert', req.params.id, { note, callbackOutcome }, req.ip);
    res.json({ alert: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update alert' });
  }
});

// ═══════════════════════════════════════════════════
// ANALYTICS (Resident + Admin View)
// ═══════════════════════════════════════════════════

/**
 * GET /api/dashboard/stats — Aggregate QI metrics
 */
router.get('/dashboard/stats', authenticate, async (req, res) => {
  try {
    const stats = {};

    // Enrollment
    const enrollment = (await pool.query(`
      SELECT status, COUNT(*) FROM patients GROUP BY status
    `)).rows;
    stats.enrollment = enrollment.reduce((acc, r) => { acc[r.status] = parseInt(r.count); return acc; }, {});
    stats.totalEnrolled = enrollment.reduce((acc, r) => acc + parseInt(r.count), 0);

    // Engagement rate (% responding to ≥4 of 6 check-ins)
    const engagement = (await pool.query(`
      SELECT p.id, COUNT(cs.id) as completed_checkins
      FROM patients p
      LEFT JOIN checkin_sessions cs ON cs.patient_id = p.id AND cs.status = 'completed'
      WHERE p.status IN ('active', 'completed')
      GROUP BY p.id
    `)).rows;
    const engagedCount = engagement.filter(e => parseInt(e.completed_checkins) >= 4).length;
    stats.engagementRate = engagement.length > 0 ? (engagedCount / engagement.length * 100).toFixed(1) + '%' : 'N/A';

    // Alert summary
    const alertStats = (await pool.query(`
      SELECT severity, status, COUNT(*) FROM alerts GROUP BY severity, status
    `)).rows;
    stats.alerts = alertStats;

    // Callback yield
    const callbacks = (await pool.query(`
      SELECT callback_outcome, COUNT(*) FROM alerts WHERE callback_made = TRUE GROUP BY callback_outcome
    `)).rows;
    stats.callbackOutcomes = callbacks;

    // Phase completion rates
    const phaseCompletion = (await pool.query(`
      SELECT phase, status, COUNT(*) FROM checkin_sessions GROUP BY phase, status
    `)).rows;
    stats.phaseCompletion = phaseCompletion;

    // Opioid status at each phase
    const opioidByPhase = (await pool.query(`
      SELECT phase, response_parsed, COUNT(*) 
      FROM responses 
      WHERE question_key = 'still_opioids'
      GROUP BY phase, response_parsed
    `)).rows;
    stats.opioidByPhase = opioidByPhase;

    // PHQ-2 results
    const phq2 = (await pool.query(`
      SELECT r1.patient_id,
        r1.response_parsed::int as interest,
        r2.response_parsed::int as mood,
        (r1.response_parsed::int + r2.response_parsed::int) as total
      FROM responses r1
      JOIN responses r2 ON r1.patient_id = r2.patient_id AND r1.session_id = r2.session_id
      WHERE r1.question_key = 'phq_interest' AND r2.question_key = 'phq_mood'
        AND r1.response_parsed ~ '^[0-3]$' AND r2.response_parsed ~ '^[0-3]$'
    `)).rows;
    stats.phq2 = {
      screened: phq2.length,
      positive: phq2.filter(p => p.total >= 3).length,
      rate: phq2.length > 0 ? (phq2.filter(p => p.total >= 3).length / phq2.length * 100).toFixed(1) + '%' : 'N/A',
    };

    await audit(req.user.email, 'stats_viewed', null, null, {}, req.ip);
    res.json(stats);
  } catch (err) {
    logger.error('Stats query failed', { error: err.message });
    res.status(500).json({ error: 'Failed to retrieve stats' });
  }
});

/**
 * POST /api/auth/users — Create new dashboard user (admin only)
 */
router.post('/auth/users', authenticate, requireRole('admin'), async (req, res) => {
  const { email, password, name, role } = req.body;
  if (!email || !password || !name || !role) {
    return res.status(400).json({ error: 'All fields required: email, password, name, role' });
  }
  if (!['admin', 'triage_nurse', 'resident', 'viewer'].includes(role)) {
    return res.status(400).json({ error: 'Invalid role' });
  }

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

module.exports = router;
