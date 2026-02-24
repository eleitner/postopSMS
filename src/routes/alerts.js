/**
 * Alert & Disposition Routes — Nurse Dashboard API
 * 
 * Endpoints:
 *   GET  /api/alerts                 — List open alerts with mini-assessment data
 *   GET  /api/alerts/:id             — Single alert detail + templates
 *   POST /api/alerts/:id/disposition — Send a nurse disposition response
 *   POST /api/alerts/:id/acknowledge — Mark alert acknowledged
 *   GET  /api/mini-assessments/:id   — Full mini-assessment detail
 */
const express = require('express');
const router = express.Router();
const { pool, audit } = require('../utils/db');
const { getTemplatesForAlert, sendDisposition } = require('../services/nurse-templates');
const logger = require('../utils/logger');

// ═══════════════════════════════════════════════════
// LIST OPEN ALERTS
// ═══════════════════════════════════════════════════

router.get('/alerts', async (req, res) => {
  try {
    const { status = 'open', severity, limit = 50, offset = 0 } = req.query;

    let where = `WHERE a.status = $1`;
    const params = [status];
    let paramIndex = 2;

    // Include pending_assessment alerts alongside open ones
    if (status === 'open') {
      where = `WHERE a.status IN ('open', 'pending_assessment')`;
      params.shift(); // Remove the first param
      paramIndex = 1;
    }

    if (severity) {
      where += ` AND a.severity = $${paramIndex}`;
      params.push(severity);
      paramIndex++;
    }

    params.push(parseInt(limit), parseInt(offset));

    const result = await pool.query(`
      SELECT 
        a.id, a.severity, a.reason, a.source, a.status, a.created_at,
        a.callback_made, a.acknowledged_at, a.resolved_at,
        a.mini_assessment_id,
        p.id as patient_id, p.first_name, p.last_name, p.procedure_name, p.surgeon_name, p.surgery_date,
        cs.phase, cs.pod,
        ma.assessment_type, ma.status as ma_status, ma.nurse_summary, ma.responses as ma_responses, ma.data_points
      FROM alerts a
      JOIN patients p ON p.id = a.patient_id
      LEFT JOIN checkin_sessions cs ON cs.id = a.session_id
      LEFT JOIN mini_assessments ma ON ma.id = a.mini_assessment_id
      ${where}
      ORDER BY 
        CASE a.severity WHEN 'CRITICAL' THEN 1 WHEN 'URGENT' THEN 2 WHEN 'MONITOR' THEN 3 ELSE 4 END,
        a.created_at DESC
      LIMIT $${paramIndex} OFFSET $${paramIndex + 1}
    `, params);

    // Get count
    const countResult = await pool.query(
      `SELECT COUNT(*) FROM alerts a ${where.replace(/\$\d+/g, (match) => {
        const idx = parseInt(match.substring(1));
        return idx <= params.length - 2 ? match : '';
      }).replace(/AND\s*$/, '')}`,
      params.slice(0, -2)
    );

    res.json({
      alerts: result.rows.map(enrichAlertForDisplay),
      total: parseInt(countResult.rows[0]?.count || 0),
      limit: parseInt(limit),
      offset: parseInt(offset),
    });
  } catch (err) {
    logger.error('Failed to list alerts', { error: err.message });
    res.status(500).json({ error: 'Failed to list alerts' });
  }
});

// ═══════════════════════════════════════════════════
// SINGLE ALERT DETAIL + AVAILABLE TEMPLATES
// ═══════════════════════════════════════════════════

router.get('/alerts/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const result = await pool.query(`
      SELECT 
        a.*,
        p.id as patient_id, p.first_name, p.last_name, p.phone, p.procedure_name, 
        p.surgeon_name, p.surgery_date, p.pre_surgical_goal,
        cs.phase, cs.pod, cs.responses as checkin_responses, cs.ai_summary,
        ma.assessment_type, ma.status as ma_status, ma.nurse_summary, 
        ma.responses as ma_responses, ma.data_points, ma.checklist_items, ma.skipped_items
      FROM alerts a
      JOIN patients p ON p.id = a.patient_id
      LEFT JOIN checkin_sessions cs ON cs.id = a.session_id
      LEFT JOIN mini_assessments ma ON ma.id = a.mini_assessment_id
      WHERE a.id = $1
    `, [id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Alert not found' });
    }

    const alert = result.rows[0];

    // Get available templates for this alert type
    const alertType = inferAlertType(alert);
    const templates = getTemplatesForAlert(alertType);

    // Get any existing dispositions
    const dispositions = (await pool.query(
      `SELECT * FROM nurse_dispositions WHERE alert_id = $1 ORDER BY created_at DESC`,
      [id]
    )).rows;

    res.json({
      alert: enrichAlertForDisplay(alert),
      miniAssessment: alert.mini_assessment_id ? {
        type: alert.assessment_type,
        status: alert.ma_status,
        nurseSummary: alert.nurse_summary,
        responses: alert.ma_responses,
        dataPoints: alert.data_points,
        checklistItems: alert.checklist_items,
        skippedItems: alert.skipped_items,
      } : null,
      templates: {
        key: templates.templateKey,
        name: templates.name,
        dispositions: templates.dispositions.map(d => ({
          key: d.key,
          label: d.label,
          clinicalGuidance: d.clinicalGuidance || null,
          hasAutoFollowUp: !!d.autoFollowUp,
        })),
      },
      previousDispositions: dispositions,
    });
  } catch (err) {
    logger.error('Failed to get alert detail', { error: err.message });
    res.status(500).json({ error: 'Failed to get alert detail' });
  }
});

// ═══════════════════════════════════════════════════
// SEND DISPOSITION
// ═══════════════════════════════════════════════════

router.post('/alerts/:id/disposition', async (req, res) => {
  try {
    const { id } = req.params;
    const { dispositionKey, nurseNote } = req.body;

    if (!dispositionKey) {
      return res.status(400).json({ error: 'dispositionKey is required' });
    }

    // Load alert + patient
    const alertResult = await pool.query(`
      SELECT a.*, p.* FROM alerts a JOIN patients p ON p.id = a.patient_id WHERE a.id = $1
    `, [id]);

    if (alertResult.rows.length === 0) {
      return res.status(404).json({ error: 'Alert not found' });
    }

    const row = alertResult.rows[0];
    const patient = {
      id: row.patient_id,
      first_name: row.first_name,
      last_name: row.last_name,
      phone: row.phone,
      surgeon_name: row.surgeon_name,
      surgeon_id: row.surgeon_id,
      procedure_name: row.procedure_name,
    };
    const alert = { id: row.id, severity: row.severity, reason: row.reason };

    // Determine template
    const alertType = inferAlertType(row);
    const templates = getTemplatesForAlert(alertType);

    const result = await sendDisposition(patient, alert, templates.templateKey, dispositionKey, nurseNote || null);

    if (!result) {
      return res.status(400).json({ error: 'Invalid disposition' });
    }

    await audit('nurse', 'disposition_sent_via_dashboard', 'alert', id, {
      dispositionKey, templateKey: templates.templateKey,
    });

    res.json({ success: true, ...result });
  } catch (err) {
    logger.error('Failed to send disposition', { error: err.message });
    res.status(500).json({ error: 'Failed to send disposition' });
  }
});

// ═══════════════════════════════════════════════════
// ACKNOWLEDGE ALERT
// ═══════════════════════════════════════════════════

router.post('/alerts/:id/acknowledge', async (req, res) => {
  try {
    const { id } = req.params;
    const { acknowledgedBy } = req.body;

    await pool.query(
      `UPDATE alerts SET acknowledged_at = NOW(), acknowledged_by = $1 WHERE id = $2`,
      [acknowledgedBy || 'nurse', id]
    );

    await audit(acknowledgedBy || 'nurse', 'alert_acknowledged', 'alert', id, {});
    res.json({ success: true });
  } catch (err) {
    logger.error('Failed to acknowledge alert', { error: err.message });
    res.status(500).json({ error: 'Failed' });
  }
});

// ═══════════════════════════════════════════════════
// MINI-ASSESSMENT DETAIL
// ═══════════════════════════════════════════════════

router.get('/mini-assessments/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query(`
      SELECT ma.*, p.first_name, p.last_name, p.procedure_name, p.surgeon_name
      FROM mini_assessments ma
      JOIN patients p ON p.id = ma.patient_id
      WHERE ma.id = $1
    `, [id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Mini-assessment not found' });
    }

    res.json({ miniAssessment: result.rows[0] });
  } catch (err) {
    logger.error('Failed to get mini-assessment', { error: err.message });
    res.status(500).json({ error: 'Failed' });
  }
});

// ═══════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════

/**
 * Infer alert type from alert data for template matching.
 */
function inferAlertType(alert) {
  const reason = (alert.reason || '').toLowerCase();
  const source = alert.source;

  if (source === 'conversation') return 'conversation';
  if (alert.assessment_type) return alert.assessment_type.replace('_concern', '').replace('_escalation', '');

  // Match by reason text
  if (reason.includes('ssi') || reason.includes('redness') || reason.includes('discharge')) return 'redness';
  if (reason.includes('dvt') || reason.includes('leg swell')) return 'leg_swelling';
  if (reason.includes('pain')) return 'pain';
  if (reason.includes('fever')) return 'fever';
  if (reason.includes('opioid')) return 'still_opioids';
  if (reason.includes('phq') || reason.includes('depression')) return 'phq_mood';
  if (reason.includes('dehiscence') || reason.includes('wound_open')) return 'wound_open';
  if (reason.includes('seroma') || reason.includes('fluid_bulge')) return 'fluid_bulge';
  if (reason.includes('photo')) return 'photo';
  if (reason.includes('bleeding')) return 'bleeding';

  return 'conversation'; // Fallback to catch-all
}

/**
 * Enrich an alert row for display in the dashboard.
 */
function enrichAlertForDisplay(row) {
  const surgeryDate = row.surgery_date ? new Date(row.surgery_date) : null;
  const pod = surgeryDate ? Math.floor((Date.now() - surgeryDate.getTime()) / 86400000) : row.pod;

  return {
    id: row.id,
    severity: row.severity,
    reason: row.reason,
    source: row.source,
    status: row.status,
    createdAt: row.created_at,
    acknowledgedAt: row.acknowledged_at,
    resolvedAt: row.resolved_at,
    callbackMade: row.callback_made,
    patient: {
      id: row.patient_id,
      name: `${row.first_name} ${row.last_name}`,
      procedure: row.procedure_name,
      surgeon: row.surgeon_name,
      pod,
      phase: row.phase,
    },
    miniAssessment: row.mini_assessment_id ? {
      id: row.mini_assessment_id,
      type: row.assessment_type,
      status: row.ma_status,
      nurseSummary: row.nurse_summary,
      dataPoints: row.data_points,
    } : null,
  };
}

module.exports = router;
