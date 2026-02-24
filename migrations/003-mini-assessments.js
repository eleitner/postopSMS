/**
 * Migration: Mini-Assessments, Nurse Dispositions, Procedure Configs
 * 
 * Adds:
 *   - mini_assessments — AI scribe intake sessions between alert and nurse
 *   - nurse_dispositions — structured log of nurse template responses
 *   - scheduled_followups — auto-scheduled photo requests, pain checks, etc.
 *   - procedure_configs JSONB column on surgeons table
 *   - pt_ot fields on patients table
 * 
 * Run: node migrations/003-mini-assessments.js
 * Rollback: node migrations/003-mini-assessments.js down
 */
const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
});

const UP = `
-- ═══════════════════════════════════════════════
-- MINI-ASSESSMENTS — AI scribe intake layer
-- ═══════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS mini_assessments (
  id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  patient_id          UUID NOT NULL REFERENCES patients(id),
  checkin_session_id  UUID REFERENCES checkin_sessions(id),
  assessment_type     TEXT NOT NULL,
  trigger_key         TEXT NOT NULL,
  trigger_severity    TEXT NOT NULL,
  trigger_reason      TEXT,
  status              TEXT NOT NULL DEFAULT 'active',
  checklist_items     JSONB DEFAULT '[]',
  skipped_items       JSONB DEFAULT '[]',
  current_item_index  INTEGER DEFAULT 0,
  responses           JSONB DEFAULT '{}',
  nurse_summary       TEXT,
  data_points         INTEGER DEFAULT 0,
  started_at          TIMESTAMPTZ,
  completed_at        TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_ma_patient ON mini_assessments(patient_id);
CREATE INDEX IF NOT EXISTS idx_ma_status ON mini_assessments(status) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_ma_type ON mini_assessments(assessment_type);
CREATE INDEX IF NOT EXISTS idx_ma_session ON mini_assessments(checkin_session_id);

-- Trigger for updated_at
DROP TRIGGER IF EXISTS trg_mini_assessments_updated ON mini_assessments;
CREATE TRIGGER trg_mini_assessments_updated 
  BEFORE UPDATE ON mini_assessments 
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ═══════════════════════════════════════════════
-- NURSE DISPOSITIONS — structured response log
-- ═══════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS nurse_dispositions (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  alert_id          UUID REFERENCES alerts(id),
  patient_id        UUID NOT NULL REFERENCES patients(id),
  template_key      TEXT NOT NULL,
  disposition_key   TEXT NOT NULL,
  message_sent      TEXT NOT NULL,
  nurse_note        TEXT,
  auto_followup     JSONB,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_nd_alert ON nurse_dispositions(alert_id);
CREATE INDEX IF NOT EXISTS idx_nd_patient ON nurse_dispositions(patient_id);
CREATE INDEX IF NOT EXISTS idx_nd_disposition ON nurse_dispositions(disposition_key);

-- ═══════════════════════════════════════════════
-- SCHEDULED FOLLOWUPS — auto-triggered by dispositions
-- ═══════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS scheduled_followups (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  patient_id      UUID NOT NULL REFERENCES patients(id),
  type            TEXT NOT NULL,
  prompt          TEXT NOT NULL,
  trigger_at      TIMESTAMPTZ NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending',
  sent_at         TIMESTAMPTZ,
  response        TEXT,
  responded_at    TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_sf_pending ON scheduled_followups(trigger_at) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_sf_patient ON scheduled_followups(patient_id);

-- ═══════════════════════════════════════════════
-- SURGEON PROCEDURE CONFIGS — per-surgeon overrides
-- ═══════════════════════════════════════════════
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                 WHERE table_name = 'surgeons' AND column_name = 'procedure_configs') THEN
    ALTER TABLE surgeons ADD COLUMN procedure_configs JSONB DEFAULT '{}';
    COMMENT ON COLUMN surgeons.procedure_configs IS 
      'Per-surgeon procedure config overrides. Keys match procedure_config.js defaults. Partial overrides OK — system merges with defaults.';
  END IF;
END $$;

-- ═══════════════════════════════════════════════
-- PATIENT PT/OT TRACKING
-- ═══════════════════════════════════════════════
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                 WHERE table_name = 'patients' AND column_name = 'pt_ot_expected') THEN
    ALTER TABLE patients ADD COLUMN pt_ot_expected BOOLEAN;
    COMMENT ON COLUMN patients.pt_ot_expected IS 
      'Inferred from procedure type. NULL = not yet determined. True = PT/OT tracking active.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                 WHERE table_name = 'patients' AND column_name = 'pt_started') THEN
    ALTER TABLE patients ADD COLUMN pt_started BOOLEAN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                 WHERE table_name = 'patients' AND column_name = 'pt_started_date') THEN
    ALTER TABLE patients ADD COLUMN pt_started_date DATE;
  END IF;
END $$;

-- ═══════════════════════════════════════════════
-- LINK ALERTS TO MINI-ASSESSMENTS
-- ═══════════════════════════════════════════════
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                 WHERE table_name = 'alerts' AND column_name = 'mini_assessment_id') THEN
    ALTER TABLE alerts ADD COLUMN mini_assessment_id UUID REFERENCES mini_assessments(id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                 WHERE table_name = 'alerts' AND column_name = 'nurse_disposition_id') THEN
    ALTER TABLE alerts ADD COLUMN nurse_disposition_id UUID REFERENCES nurse_dispositions(id);
  END IF;
END $$;

-- ═══════════════════════════════════════════════
-- ANALYTICS VIEW: Mini-Assessment Outcomes
-- ═══════════════════════════════════════════════
CREATE OR REPLACE VIEW v_mini_assessment_outcomes AS
SELECT 
  ma.assessment_type,
  ma.trigger_severity,
  ma.data_points,
  ma.status as ma_status,
  nd.disposition_key,
  nd.template_key,
  p.procedure_name,
  p.surgeon_name,
  EXTRACT(EPOCH FROM (ma.completed_at - ma.started_at))/60 as duration_minutes
FROM mini_assessments ma
JOIN patients p ON p.id = ma.patient_id
LEFT JOIN alerts a ON a.mini_assessment_id = ma.id
LEFT JOIN nurse_dispositions nd ON nd.alert_id = a.id;

-- ═══════════════════════════════════════════════
-- ANALYTICS VIEW: Disposition Outcomes
-- ═══════════════════════════════════════════════
CREATE OR REPLACE VIEW v_disposition_outcomes AS
SELECT 
  nd.template_key,
  nd.disposition_key,
  a.severity,
  a.reason,
  p.procedure_name,
  p.surgeon_name,
  nd.created_at
FROM nurse_dispositions nd
JOIN alerts a ON a.id = nd.alert_id
JOIN patients p ON p.id = nd.patient_id;
`;

const DOWN = `
DROP VIEW IF EXISTS v_disposition_outcomes CASCADE;
DROP VIEW IF EXISTS v_mini_assessment_outcomes CASCADE;
DROP TABLE IF EXISTS scheduled_followups CASCADE;
DROP TABLE IF EXISTS nurse_dispositions CASCADE;
DROP TABLE IF EXISTS mini_assessments CASCADE;

-- Remove added columns (safe — only if they exist)
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'surgeons' AND column_name = 'procedure_configs') THEN
    ALTER TABLE surgeons DROP COLUMN procedure_configs;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'patients' AND column_name = 'pt_ot_expected') THEN
    ALTER TABLE patients DROP COLUMN pt_ot_expected;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'patients' AND column_name = 'pt_started') THEN
    ALTER TABLE patients DROP COLUMN pt_started;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'patients' AND column_name = 'pt_started_date') THEN
    ALTER TABLE patients DROP COLUMN pt_started_date;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'alerts' AND column_name = 'mini_assessment_id') THEN
    ALTER TABLE alerts DROP COLUMN mini_assessment_id;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'alerts' AND column_name = 'nurse_disposition_id') THEN
    ALTER TABLE alerts DROP COLUMN nurse_disposition_id;
  END IF;
END $$;
`;

async function run() {
  const direction = process.argv[2] === 'down' ? 'down' : 'up';
  const client = await pool.connect();
  try {
    console.log(`Running migration 003: ${direction.toUpperCase()}`);
    await client.query(direction === 'up' ? UP : DOWN);
    console.log(`Migration 003 ${direction} completed successfully.`);
  } catch (err) {
    console.error('Migration 003 failed:', err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

run();
