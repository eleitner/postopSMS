import type { Pool, PoolClient } from 'pg';
import { config } from '../config';
import type { DynamicVariables, HandoffRow, PatientStateRow } from '../types';

export async function getPatientState(
  client: PoolClient,
  patientId: string,
): Promise<PatientStateRow | null> {
  const q = `
    SELECT patient_id, study_id, age, sex, diabetes_type,
           diabetes_duration_years, lifecycle_stage
      FROM ${config.dbSchema}.patient_state
     WHERE patient_id = $1
  `;
  const { rows } = await client.query(q, [patientId]);
  return (rows[0] as PatientStateRow | undefined) ?? null;
}

/**
 * Insert handoff cache row + patient event row inside a single transaction.
 * Caller owns BEGIN/COMMIT/ROLLBACK.
 */
export async function insertHandoffAndEvent(
  client: PoolClient,
  args: {
    patientId: string;
    deidentToken: string;
    inputsHash: string;
    payload: DynamicVariables;
    eventType: string;
    maId: string;
    callReason: string;
    ttlSec: number;
  },
): Promise<HandoffRow> {
  const insertHandoff = `
    INSERT INTO ${config.dbSchema}.ai_handoff_cache
      (patient_id, deident_token, inputs_hash, payload, status, expires_at)
    VALUES ($1, $2, $3, $4, 'pending', NOW() + make_interval(secs => $5))
    RETURNING id
  `;
  const { rows: hrows } = await client.query(insertHandoff, [
    args.patientId,
    args.deidentToken,
    args.inputsHash,
    args.payload,
    args.ttlSec,
  ]);
  const handoffId: string = hrows[0].id;

  const insertEvent = `
    INSERT INTO ${config.dbSchema}.patient_events
      (patient_id, event_type, event_subtype, actor_type, actor_id,
       handoff_id, payload)
    VALUES ($1, $2, $3, 'clinician', $4, $5, $6)
  `;
  await client.query(insertEvent, [
    args.patientId,
    args.eventType,
    args.callReason,
    args.maId,
    handoffId,
    { call_reason: args.callReason },
  ]);

  return { id: handoffId };
}

/**
 * Best-effort status update on the handoff cache row after the Retell call
 * settles. Runs outside the main transaction. Caller should swallow errors.
 */
export async function updateHandoffStatus(
  pool: Pool,
  handoffId: string,
  status: 'success' | 'error',
  extras: {
    model?: string;
    tokens_in?: number;
    tokens_out?: number;
    latency_ms?: number;
    error_detail?: string;
    response?: unknown;
  } = {},
): Promise<void> {
  const q = `
    UPDATE ${config.dbSchema}.ai_handoff_cache
       SET status       = $2,
           model        = COALESCE($3, model),
           tokens_in    = COALESCE($4, tokens_in),
           tokens_out   = COALESCE($5, tokens_out),
           latency_ms   = COALESCE($6, latency_ms),
           error_detail = COALESCE($7, error_detail),
           response     = COALESCE($8::jsonb, response)
     WHERE id = $1
  `;
  await pool.query(q, [
    handoffId,
    status,
    extras.model ?? null,
    extras.tokens_in ?? null,
    extras.tokens_out ?? null,
    extras.latency_ms ?? null,
    extras.error_detail ?? null,
    extras.response ? JSON.stringify(extras.response) : null,
  ]);
}
