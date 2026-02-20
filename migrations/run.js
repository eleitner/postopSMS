/**
 * Database Migration — PostOp SMS Protocol
 * Run: npm run migrate
 * Rollback: npm run migrate:down
 */
const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
});

const UP = `
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- PATIENTS
CREATE TABLE IF NOT EXISTS patients (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  first_name      TEXT NOT NULL,
  last_name       TEXT NOT NULL,
  phone           TEXT NOT NULL,
  phone_hash      TEXT NOT NULL,
  surgeon_name    TEXT NOT NULL,
  procedure_name  TEXT NOT NULL,
  surgery_date    DATE NOT NULL,
  pre_surgical_goal TEXT,
  asa_class       INTEGER,
  age_at_surgery  INTEGER,
  status          TEXT NOT NULL DEFAULT 'enrolled',
  enrolled_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at    TIMESTAMPTZ,
  withdrawn_at    TIMESTAMPTZ,
  withdraw_reason TEXT,
  consent_verbal  BOOLEAN NOT NULL DEFAULT TRUE,
  consent_date    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_patients_phone_hash ON patients(phone_hash);
CREATE INDEX IF NOT EXISTS idx_patients_status ON patients(status);
CREATE INDEX IF NOT EXISTS idx_patients_surgery_date ON patients(surgery_date);

-- CHECK-IN SESSIONS
CREATE TABLE IF NOT EXISTS checkin_sessions (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  patient_id      UUID NOT NULL REFERENCES patients(id),
  phase           TEXT NOT NULL,
  pod             INTEGER NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending',
  scheduled_at    TIMESTAMPTZ NOT NULL,
  started_at      TIMESTAMPTZ,
  completed_at    TIMESTAMPTZ,
  expired_at      TIMESTAMPTZ,
  current_question_index INTEGER DEFAULT 0,
  responses       JSONB DEFAULT '{}',
  ai_summary      TEXT,
  ai_severity     TEXT,
  ai_processed_at TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_sessions_patient ON checkin_sessions(patient_id);
CREATE INDEX IF NOT EXISTS idx_sessions_status ON checkin_sessions(status);
CREATE INDEX IF NOT EXISTS idx_sessions_scheduled ON checkin_sessions(scheduled_at) WHERE status = 'pending';

-- INDIVIDUAL RESPONSES
CREATE TABLE IF NOT EXISTS responses (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  session_id      UUID NOT NULL REFERENCES checkin_sessions(id),
  patient_id      UUID NOT NULL REFERENCES patients(id),
  question_key    TEXT NOT NULL,
  question_text   TEXT NOT NULL,
  response_raw    TEXT NOT NULL,
  response_parsed TEXT,
  response_type   TEXT NOT NULL,
  phase           TEXT NOT NULL,
  pod             INTEGER NOT NULL,
  alert_triggered BOOLEAN DEFAULT FALSE,
  alert_severity  TEXT,
  alert_reason    TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_responses_session ON responses(session_id);
CREATE INDEX IF NOT EXISTS idx_responses_patient ON responses(patient_id);
CREATE INDEX IF NOT EXISTS idx_responses_key ON responses(question_key);
CREATE INDEX IF NOT EXISTS idx_responses_alerts ON responses(alert_triggered) WHERE alert_triggered = TRUE;

-- TRIAGE ALERTS
CREATE TABLE IF NOT EXISTS alerts (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  session_id      UUID REFERENCES checkin_sessions(id),
  patient_id      UUID NOT NULL REFERENCES patients(id),
  response_id     UUID REFERENCES responses(id),
  severity        TEXT NOT NULL,
  reason          TEXT NOT NULL,
  source          TEXT NOT NULL DEFAULT 'protocol',
  status          TEXT NOT NULL DEFAULT 'open',
  acknowledged_by TEXT,
  acknowledged_at TIMESTAMPTZ,
  resolved_by     TEXT,
  resolved_at     TIMESTAMPTZ,
  resolution_note TEXT,
  callback_made   BOOLEAN DEFAULT FALSE,
  callback_at     TIMESTAMPTZ,
  callback_outcome TEXT,
  nurse_notified_at TIMESTAMPTZ,
  nurse_sms_sid   TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_alerts_status ON alerts(status) WHERE status = 'open';
CREATE INDEX IF NOT EXISTS idx_alerts_patient ON alerts(patient_id);
CREATE INDEX IF NOT EXISTS idx_alerts_severity ON alerts(severity);

-- SMS LOG
CREATE TABLE IF NOT EXISTS sms_log (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  patient_id      UUID REFERENCES patients(id),
  session_id      UUID REFERENCES checkin_sessions(id),
  direction       TEXT NOT NULL,
  phone_to        TEXT NOT NULL,
  phone_from      TEXT NOT NULL,
  body            TEXT NOT NULL,
  twilio_sid      TEXT,
  twilio_status   TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_sms_patient ON sms_log(patient_id);

-- AUDIT LOG (HIPAA)
CREATE TABLE IF NOT EXISTS audit_log (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  actor           TEXT NOT NULL,
  action          TEXT NOT NULL,
  resource_type   TEXT,
  resource_id     UUID,
  detail          JSONB,
  ip_address      TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_log(action);
CREATE INDEX IF NOT EXISTS idx_audit_time ON audit_log(created_at);

-- DASHBOARD USERS
CREATE TABLE IF NOT EXISTS users (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  email           TEXT UNIQUE NOT NULL,
  password_hash   TEXT NOT NULL,
  name            TEXT NOT NULL,
  role            TEXT NOT NULL DEFAULT 'viewer',
  active          BOOLEAN DEFAULT TRUE,
  last_login_at   TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ANALYTICS VIEWS
CREATE OR REPLACE VIEW v_pain_trajectory AS
SELECT r.patient_id, p.procedure_name, p.surgeon_name, r.pod, r.phase,
  CASE WHEN r.response_type = 'num' THEN r.response_parsed::INTEGER ELSE NULL END as pain_score,
  r.response_parsed as pain_value, r.created_at
FROM responses r JOIN patients p ON p.id = r.patient_id
WHERE r.question_key IN ('pain', 'pain_trend')
ORDER BY r.patient_id, r.pod;

CREATE OR REPLACE VIEW v_opioid_trajectory AS
SELECT r.patient_id, p.procedure_name, r.pod, r.phase, r.question_key, r.response_parsed, r.created_at
FROM responses r JOIN patients p ON p.id = r.patient_id
WHERE r.question_key IN ('opioids', 'still_opioids')
ORDER BY r.patient_id, r.pod;

CREATE OR REPLACE VIEW v_alert_summary AS
SELECT a.severity, a.reason, a.status, a.source, a.callback_outcome,
  p.procedure_name, p.surgeon_name, cs.phase, cs.pod
FROM alerts a JOIN patients p ON p.id = a.patient_id
LEFT JOIN checkin_sessions cs ON cs.id = a.session_id;

-- Updated_at triggers
CREATE OR REPLACE FUNCTION update_updated_at() RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_patients_updated ON patients;
CREATE TRIGGER trg_patients_updated BEFORE UPDATE ON patients FOR EACH ROW EXECUTE FUNCTION update_updated_at();
DROP TRIGGER IF EXISTS trg_sessions_updated ON checkin_sessions;
CREATE TRIGGER trg_sessions_updated BEFORE UPDATE ON checkin_sessions FOR EACH ROW EXECUTE FUNCTION update_updated_at();
`;

const DOWN = `
DROP VIEW IF EXISTS v_alert_summary CASCADE;
DROP VIEW IF EXISTS v_opioid_trajectory CASCADE;
DROP VIEW IF EXISTS v_pain_trajectory CASCADE;
DROP TABLE IF EXISTS audit_log CASCADE;
DROP TABLE IF EXISTS sms_log CASCADE;
DROP TABLE IF EXISTS alerts CASCADE;
DROP TABLE IF EXISTS responses CASCADE;
DROP TABLE IF EXISTS checkin_sessions CASCADE;
DROP TABLE IF EXISTS users CASCADE;
DROP TABLE IF EXISTS patients CASCADE;
DROP FUNCTION IF EXISTS update_updated_at CASCADE;
`;

async function run() {
  const direction = process.argv[2] === 'down' ? 'down' : 'up';
  const client = await pool.connect();
  try {
    console.log(`Running migration: ${direction.toUpperCase()}`);
    await client.query(direction === 'up' ? UP : DOWN);
    console.log(`Migration ${direction} completed successfully.`);
  } catch (err) {
    console.error('Migration failed:', err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

run();
