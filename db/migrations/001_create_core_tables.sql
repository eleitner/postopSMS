-- 001_create_core_tables.sql
-- DNC platform: core schema.
--
-- Tables (all in the `dnc` schema):
--   dnc.patient_state       — one row per patient; authoritative lifecycle state.
--   dnc.patient_events      — append-only event log (visits, consents, sensory, AI).
--   dnc.ai_handoff_cache    — de-identified context blobs cached for Claude calls.
--   dnc.schema_migrations   — applied-migration tracking.
--
-- Assumptions (flag for review before second migration):
--   • patient_state holds PHI. The HIPAA boundary is enforced by only ever
--     reading ai_handoff_cache.payload into Claude prompts — never patient_state.
--   • Events are immutable; updated_at is tracked anyway for operational
--     consistency with the other two tables.
--   • Target: Google Cloud SQL for Postgres 16.
--
-- Forward-only. Rollback = DROP SCHEMA dnc CASCADE.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE SCHEMA IF NOT EXISTS dnc;


-- ─────────────────────────────────────────────────────────────
-- Migration tracking.
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS dnc.schema_migrations (
  version     TEXT PRIMARY KEY,
  applied_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);


-- ─────────────────────────────────────────────────────────────
-- Shared trigger: keep updated_at current on UPDATE.
-- ─────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION dnc.set_updated_at() RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;


-- ─────────────────────────────────────────────────────────────
-- patient_state — one row per patient.
-- ─────────────────────────────────────────────────────────────
CREATE TABLE dnc.patient_state (
  patient_id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Identity (PHI)
  first_name        TEXT NOT NULL,
  last_name         TEXT NOT NULL,
  dob               DATE,
  phone             TEXT,
  phone_normalized  TEXT,   -- last-10-digit form, for lookup
  email             TEXT,
  address           TEXT,
  city              TEXT,
  state             TEXT,
  zip               TEXT,

  -- De-identified study linkage (shown to AI + exposed on dashboards)
  study_id          TEXT NOT NULL UNIQUE,

  -- Clinical snapshot
  diabetes_type     TEXT CHECK (diabetes_type IN ('Type 1','Type 2','Other') OR diabetes_type IS NULL),
  diabetes_duration_years INTEGER,
  age               INTEGER,
  sex               TEXT CHECK (sex IN ('M','F','X') OR sex IS NULL),

  -- Lifecycle
  lifecycle_stage   TEXT NOT NULL DEFAULT 'enrolled'
                      CHECK (lifecycle_stage IN (
                        'enrolled','preauth_pending','preauth_approved',
                        'scheduled_d0','d0_implanted','d20_explanted',
                        'd90_followup','complete','withdrawn'
                      )),
  withdrawn_at      TIMESTAMPTZ,
  withdraw_reason   TEXT,

  -- Insurance / payer tier (green | yellow | red | neutral)
  payer_tier        TEXT CHECK (payer_tier IN ('green','yellow','red','neutral') OR payer_tier IS NULL),
  payer_primary     TEXT,
  payer_secondary   TEXT,

  -- Consents (dates = time of signature; NULL = not yet signed)
  consent_procedure_at TIMESTAMPTZ,
  consent_data_at      TIMESTAMPTZ,
  consent_social_at    TIMESTAMPTZ,

  -- Timestamps of last visits, for quick dashboard reads
  last_visit_at     TIMESTAMPTZ,
  d0_visit_at       TIMESTAMPTZ,
  d20_visit_at      TIMESTAMPTZ,
  d90_visit_at      TIMESTAMPTZ,

  -- Flexible bucket for rarely-queried data (diagnosis codes, contraindications,
  -- device serials, etc.). Promote fields out of here when they need indexing.
  state_data        JSONB NOT NULL DEFAULT '{}'::jsonb,

  -- Audit
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_patient_state_phone_norm ON dnc.patient_state(phone_normalized);
CREATE INDEX idx_patient_state_lifecycle   ON dnc.patient_state(lifecycle_stage);
CREATE INDEX idx_patient_state_payer_tier  ON dnc.patient_state(payer_tier);
CREATE INDEX idx_patient_state_last_visit  ON dnc.patient_state(last_visit_at DESC NULLS LAST);
CREATE INDEX idx_patient_state_data_gin    ON dnc.patient_state USING GIN (state_data);

CREATE TRIGGER trg_patient_state_updated
  BEFORE UPDATE ON dnc.patient_state
  FOR EACH ROW EXECUTE FUNCTION dnc.set_updated_at();


-- ─────────────────────────────────────────────────────────────
-- patient_events — append-only event log.
-- ─────────────────────────────────────────────────────────────
CREATE TABLE dnc.patient_events (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id      UUID NOT NULL REFERENCES dnc.patient_state(patient_id) ON DELETE RESTRICT,

  event_type      TEXT NOT NULL,   -- e.g. visit_started, sensory_recorded, consent_signed,
                                   -- photo_uploaded, ai_query, ai_response, alert_raised
  event_subtype   TEXT,            -- free-form refinement (e.g. 'd0', 'd20', 'left_foot')

  -- Actor (who/what produced the event)
  actor_type      TEXT CHECK (actor_type IN ('clinician','patient','system','ai') OR actor_type IS NULL),
  actor_id        TEXT,            -- clinician UUID, 'scheduler', Claude request id, etc.

  -- Optional link to the AI handoff that produced / consumed this event
  handoff_id      UUID,            -- FK added after ai_handoff_cache is created below

  payload         JSONB NOT NULL DEFAULT '{}'::jsonb,

  occurred_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_patient_events_patient_time
  ON dnc.patient_events (patient_id, occurred_at DESC);
CREATE INDEX idx_patient_events_type
  ON dnc.patient_events (event_type);
CREATE INDEX idx_patient_events_handoff
  ON dnc.patient_events (handoff_id) WHERE handoff_id IS NOT NULL;
CREATE INDEX idx_patient_events_payload_gin
  ON dnc.patient_events USING GIN (payload);

CREATE TRIGGER trg_patient_events_updated
  BEFORE UPDATE ON dnc.patient_events
  FOR EACH ROW EXECUTE FUNCTION dnc.set_updated_at();


-- ─────────────────────────────────────────────────────────────
-- ai_handoff_cache — de-identified snapshots passed to Claude.
-- ─────────────────────────────────────────────────────────────
CREATE TABLE dnc.ai_handoff_cache (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id      UUID NOT NULL REFERENCES dnc.patient_state(patient_id) ON DELETE CASCADE,

  -- Opaque token the AI sees in place of identifiers.
  deident_token   TEXT NOT NULL,

  -- Cache key over the exact inputs: lets us dedupe identical calls.
  inputs_hash     TEXT NOT NULL,

  -- De-identified input payload (clinical fields only; no PHI).
  payload         JSONB NOT NULL,

  -- What we got back.
  model           TEXT,
  response        JSONB,
  tokens_in       INTEGER,
  tokens_out      INTEGER,
  latency_ms      INTEGER,
  status          TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending','success','error','expired')),
  error_detail    TEXT,

  -- TTL
  expires_at      TIMESTAMPTZ,

  -- Audit
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Dedupe identical successful calls per patient.
CREATE UNIQUE INDEX idx_ai_handoff_patient_inputs_success
  ON dnc.ai_handoff_cache (patient_id, inputs_hash)
  WHERE status = 'success';
CREATE INDEX idx_ai_handoff_token       ON dnc.ai_handoff_cache (deident_token);
CREATE INDEX idx_ai_handoff_status      ON dnc.ai_handoff_cache (status);
CREATE INDEX idx_ai_handoff_expires     ON dnc.ai_handoff_cache (expires_at)
  WHERE expires_at IS NOT NULL;
CREATE INDEX idx_ai_handoff_payload_gin ON dnc.ai_handoff_cache USING GIN (payload);

CREATE TRIGGER trg_ai_handoff_cache_updated
  BEFORE UPDATE ON dnc.ai_handoff_cache
  FOR EACH ROW EXECUTE FUNCTION dnc.set_updated_at();


-- ─────────────────────────────────────────────────────────────
-- Deferred FK: patient_events.handoff_id → ai_handoff_cache.id
-- ─────────────────────────────────────────────────────────────
ALTER TABLE dnc.patient_events
  ADD CONSTRAINT fk_patient_events_handoff
  FOREIGN KEY (handoff_id) REFERENCES dnc.ai_handoff_cache(id) ON DELETE SET NULL;


-- ─────────────────────────────────────────────────────────────
-- Record this migration.
-- ─────────────────────────────────────────────────────────────
INSERT INTO dnc.schema_migrations (version) VALUES ('001');

COMMIT;
