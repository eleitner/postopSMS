const { Pool } = require('pg');

async function run() {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
  });

  try {
    console.log('Migration 006: Adding enrollment_method to patients...');
    await pool.query("ALTER TABLE patients ADD COLUMN IF NOT EXISTS enrollment_method VARCHAR(20) DEFAULT NULL");
    console.log('  + enrollment_method column added');
    const updated = await pool.query("UPDATE patients SET enrollment_method = 'clinician_sms' WHERE enrollment_method IS NULL");
    console.log('  + Backfilled ' + updated.rowCount + ' existing patients as clinician_sms');
    console.log('Migration 006 complete.');
  } catch (err) {
    console.error('Migration 006 failed:', err.message);
    throw err;
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  run().then(() => process.exit(0)).catch(() => process.exit(1));
}

module.exports = { run };
