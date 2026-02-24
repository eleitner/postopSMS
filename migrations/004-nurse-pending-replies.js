/**
 * Migration 004: Nurse Pending Replies
 * 
 * Tracks which alert a nurse is expected to reply to via SMS.
 * Each nurse phone has at most one pending alert at a time (upsert pattern).
 * Expires after 24 hours.
 * 
 * Run: node migrations/004-nurse-pending-replies.js
 * Rollback: node migrations/004-nurse-pending-replies.js down
 */
const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
});

const UP = `
-- ═══════════════════════════════════════════════
-- NURSE PENDING REPLIES — SMS disposition routing
-- ═══════════════════════════════════════════════
-- When a nurse receives an alert SMS with numbered options,
-- this table tracks which alert they're expected to reply to.
-- Simple number replies (1, 2, 3) route to the pending alert.
-- One row per nurse phone (upsert). Expires after 24h.

CREATE TABLE IF NOT EXISTS nurse_pending_replies (
  nurse_phone     TEXT PRIMARY KEY,
  alert_id        UUID NOT NULL REFERENCES alerts(id),
  template_key    TEXT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_npr_alert ON nurse_pending_replies(alert_id);

-- Cleanup job: delete expired pending replies (called by scheduler)
-- Not a trigger — scheduler handles this in its hourly sweep.
`;

const DOWN = `
DROP TABLE IF EXISTS nurse_pending_replies CASCADE;
`;

async function run() {
  const direction = process.argv[2] === 'down' ? 'down' : 'up';
  const client = await pool.connect();
  try {
    console.log(`Running migration 004: ${direction.toUpperCase()}`);
    await client.query(direction === 'up' ? UP : DOWN);
    console.log(`Migration 004 ${direction} completed successfully.`);
  } catch (err) {
    console.error('Migration 004 failed:', err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

run();
