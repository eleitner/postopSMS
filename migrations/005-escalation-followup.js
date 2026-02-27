/**
 * Migration 005: Escalation Outcome Follow-Up
 * 
 * Adds:
 *   - metadata JSONB column to scheduled_followups (tracks branching state)
 *   - escalation_outcome_responses table (logs each step of the outcome conversation)
 */
const { Pool } = require('pg');

async function up() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  
  try {
    // Add metadata column to scheduled_followups if it doesn't exist
    await pool.query(`
      ALTER TABLE scheduled_followups 
      ADD COLUMN IF NOT EXISTS metadata JSONB
    `);

    // Create escalation outcome responses table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS escalation_outcome_responses (
        id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        followup_id     UUID REFERENCES scheduled_followups(id),
        patient_id      UUID NOT NULL REFERENCES patients(id),
        step            TEXT NOT NULL,
        response_text   TEXT,
        parsed_value    TEXT,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    await pool.query(`CREATE INDEX IF NOT EXISTS idx_eor_followup ON escalation_outcome_responses(followup_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_eor_patient ON escalation_outcome_responses(patient_id)`);

    console.log('Migration 005 complete: escalation outcome follow-up tables ready');
  } catch (err) {
    console.error('Migration 005 failed:', err.message);
    throw err;
  } finally {
    await pool.end();
  }
}

async function down() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  try {
    await pool.query(`DROP TABLE IF EXISTS escalation_outcome_responses CASCADE`);
    await pool.query(`ALTER TABLE scheduled_followups DROP COLUMN IF EXISTS metadata`);
    console.log('Migration 005 rolled back');
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  const direction = process.argv[2];
  if (direction === 'down') {
    down().catch(e => { console.error(e); process.exit(1); });
  } else {
    up().catch(e => { console.error(e); process.exit(1); });
  }
}

module.exports = { up, down };
