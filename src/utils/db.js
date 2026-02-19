/**
 * Database — connection pool + audit helper
 */
const { Pool } = require('pg');
const logger = require('./logger');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
  max: 20,
  idleTimeoutMillis: 30000,
});

pool.on('error', (err) => {
  logger.error('Unexpected pool error', { error: err.message });
});

/**
 * HIPAA audit log — every access to PHI gets recorded
 */
async function audit(actor, action, resourceType, resourceId, detail = {}, ipAddress = null) {
  try {
    await pool.query(
      `INSERT INTO audit_log (actor, action, resource_type, resource_id, detail, ip_address)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [actor, action, resourceType, resourceId, JSON.stringify(detail), ipAddress]
    );
  } catch (err) {
    // Audit failures must not crash the app but must be logged
    logger.error('AUDIT LOG FAILURE', { actor, action, resourceType, resourceId, error: err.message });
  }
}

module.exports = { pool, audit };
