/**
 * Scheduler — Triggers check-ins at clinically appropriate times
 * 
 * Runs every hour, checks which patients are due for a check-in,
 * and starts the session. Also expires stale sessions.
 * 
 * Schedule logic:
 *   POD 0: 6 PM on surgery day (evening safety check)
 *   POD 2: 10 AM (acute phase)
 *   POD 5: 10 AM (infectious window)
 *   POD 14: 10 AM (late phase)
 *   POD 21: 10 AM (recovery + depression screen)
 *   POD 30: 10 AM (outcomes closure)
 */
const cron = require('node-cron');
const { pool, audit } = require('../utils/db');
const { startCheckin } = require('./session-manager');
const { getPhaseForPOD, getScheduledPODs } = require('./protocols');
const logger = require('../utils/logger');

const SCHEDULED_PODS = getScheduledPODs(); // [0, 2, 5, 14, 21, 30]

/**
 * Main scheduler tick — runs hourly
 */
async function runScheduler() {
  logger.info('Scheduler tick running');

  try {
    // Find patients who are due for a check-in today
    const today = new Date();
    const results = await pool.query(`
      SELECT p.*,
        (CURRENT_DATE - p.surgery_date) as days_since_surgery
      FROM patients p
      WHERE p.status IN ('enrolled', 'active')
        AND p.surgery_date <= CURRENT_DATE
        AND (CURRENT_DATE - p.surgery_date) <= 31
    `);

    for (const patient of results.rows) {
      const pod = parseInt(patient.days_since_surgery);

      // Is this a scheduled check-in day?
      if (!SCHEDULED_PODS.includes(pod)) continue;

      // Has this phase already been completed or started?
      const phase = getPhaseForPOD(pod);
      if (!phase) continue;

      const existing = await pool.query(
        `SELECT id FROM checkin_sessions WHERE patient_id = $1 AND phase = $2 AND status IN ('active', 'completed')`,
        [patient.id, phase]
      );

      if (existing.rows.length > 0) continue; // Already done or in progress

      // Time-of-day check
      const hour = today.getHours();
      if (pod === 0 && hour < 18) continue; // POD 0: wait until 6 PM
      if (pod > 0 && (hour < 10 || hour > 20)) continue; // Others: 10 AM - 8 PM window

      // Start the check-in
      try {
        await startCheckin(patient.id, phase, pod);
        logger.info('Scheduled check-in started', { patientId: patient.id, phase, pod });
      } catch (err) {
        logger.error('Failed to start scheduled check-in', {
          patientId: patient.id, phase, pod, error: err.message,
        });
      }
    }

    // Expire stale sessions (active for > 24 hours without completion)
    const expired = await pool.query(`
      UPDATE checkin_sessions 
      SET status = 'expired', expired_at = NOW()
      WHERE status = 'active' AND started_at < NOW() - INTERVAL '24 hours'
      RETURNING id, patient_id, phase
    `);

    if (expired.rows.length > 0) {
      logger.info(`Expired ${expired.rows.length} stale sessions`);
      for (const s of expired.rows) {
        await audit('scheduler', 'session_expired', 'session', s.id, { phase: s.phase });
      }
    }

  } catch (err) {
    logger.error('Scheduler tick failed', { error: err.message, stack: err.stack });
  }
}

/**
 * Start the cron scheduler
 */
function startScheduler() {
  // Run every hour at :00
  cron.schedule('0 * * * *', runScheduler, {
    timezone: 'America/New_York', // Eastern time for TidalHealth
  });

  logger.info('Scheduler started — running every hour');

  // Also run once on startup (catch any missed check-ins)
  setTimeout(runScheduler, 5000);
}

module.exports = { startScheduler, runScheduler };
