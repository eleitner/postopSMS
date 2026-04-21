import { randomUUID } from 'node:crypto';
import type { Request, Response } from '@google-cloud/functions-framework';

import { config, MA_FIRSTNAME_LOOKUP } from './config';
import { applyCors, handlePreflight, isAllowedOrigin } from './http/cors';
import { sendError } from './http/errors';
import { validateRequestBody } from './http/validate';
import { verifyHmac } from './auth/hmac';
import { accessSecret } from './secrets/manager';
import { getPool } from './db/pool';
import {
  getPatientState,
  insertHandoffAndEvent,
  updateHandoffStatus,
} from './db/repo';
import {
  assertNoPhi,
  buildDynamicVariables,
  hashPayload,
} from './deident/payload';
import {
  extractExpiresInSeconds,
  registerPhoneCall,
  sipUriForCall,
} from './retell/client';
import { logError, logInfo } from './log';
import type { DynamicVariables } from './types';

/**
 * POST /create-session
 *
 * Mints a Retell register-phone-call session. Returns { call_id, sip_uri,
 * handoff_id, expires_in_seconds }. The React softphone uses sip_uri as the
 * SIP REFER target to hand off its Telnyx WebRTC call to Retell.
 *
 * v0 auth: HMAC + X-DNC-Timestamp. See auth/hmac.ts and README.md.
 */
export async function handleCreateSession(req: Request, res: Response): Promise<void> {
  const requestId =
    req.header('x-cloud-trace-context')?.split('/')[0] ?? randomUUID();
  const startedAt = Date.now();

  if (handlePreflight(req, res)) return;

  if (req.method !== 'POST') {
    applyCors(req, res);
    return sendError(res, 405, 'method_not_allowed', req.method);
  }

  if (!isAllowedOrigin(req.header('origin'))) {
    return sendError(res, 403, 'origin_not_allowed', req.header('origin'));
  }
  applyCors(req, res);

  const contentType = req.header('content-type') ?? '';
  if (!contentType.toLowerCase().includes('application/json')) {
    return sendError(res, 415, 'unsupported_media_type', contentType);
  }

  // Functions Framework exposes the raw body as `rawBody` on the request.
  // We need the exact bytes because HMAC is computed over them.
  const rawBuf: Buffer | undefined = (req as unknown as { rawBody?: Buffer }).rawBody;
  const rawBody = rawBuf ? rawBuf.toString('utf8') : '';
  if (!rawBody) {
    return sendError(res, 400, 'body_empty', null);
  }
  if (rawBody.length > config.maxBodyBytes) {
    return sendError(res, 413, 'body_too_large', rawBody.length);
  }

  // HMAC verification first, before any DB / Retell work.
  let hmacKey: string;
  try {
    hmacKey = await accessSecret(config.hmacSigningKeySecret);
  } catch (e) {
    return sendError(res, 500, 'secret_fetch_failed', e);
  }

  const hmacErr = verifyHmac({
    rawBody,
    timestampHeader: req.header('x-dnc-timestamp'),
    signatureHeader: req.header('x-dnc-signature'),
    key: hmacKey,
  });
  if (hmacErr) {
    return sendError(res, 401, 'unauthorized', hmacErr);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return sendError(res, 400, 'body_not_json', null);
  }

  const v = validateRequestBody(parsed);
  if (!v.ok) return sendError(res, 400, v.reason, null);
  const { patient_id, ma_id, call_reason } = v.body;

  // v0 MA auth: hardcoded ma_id -> first name map.
  // TODO: replace with real MA auth (Cloud Identity Platform token claims).
  const ma_firstname = MA_FIRSTNAME_LOOKUP[ma_id];
  if (!ma_firstname) {
    return sendError(res, 401, 'unauthorized', `unknown ma_id ${ma_id}`);
  }

  let pool;
  try {
    pool = await getPool();
  } catch (e) {
    return sendError(res, 500, 'db_unavailable', e);
  }

  const client = await pool.connect();
  let handoffId: string;
  let dynamicVariables: DynamicVariables;

  try {
    await client.query('BEGIN');

    const patient = await getPatientState(client, patient_id);
    if (!patient) {
      await client.query('ROLLBACK');
      client.release();
      return sendError(res, 404, 'patient_not_found', patient_id);
    }

    dynamicVariables = buildDynamicVariables(patient, call_reason, ma_firstname);
    assertNoPhi(dynamicVariables as unknown as Record<string, unknown>);

    const handoff = await insertHandoffAndEvent(client, {
      patientId: patient_id,
      deidentToken: patient.study_id,
      inputsHash: hashPayload(dynamicVariables),
      payload: dynamicVariables,
      eventType: 'token_minted',
      maId: ma_id,
      callReason: call_reason,
      ttlSec: config.cacheTtlSec,
    });
    handoffId = handoff.id;

    await client.query('COMMIT');
  } catch (e) {
    try {
      await client.query('ROLLBACK');
    } catch {
      /* noop */
    }
    client.release();
    return sendError(res, 500, 'db_transaction_failed', e);
  }

  client.release();

  // Retell call (outside the DB transaction).
  let retellApiKey: string;
  try {
    retellApiKey = await accessSecret(config.retellApiKeySecret);
  } catch (e) {
    await updateHandoffStatus(pool, handoffId, 'error', {
      error_detail: 'secret_fetch_failed',
    }).catch(() => {
      /* swallow */
    });
    return sendError(res, 500, 'secret_fetch_failed', e);
  }

  let retellCallId: string;
  let retellLatencyMs: number;
  let retellResponse;
  try {
    const r = await registerPhoneCall({
      apiKey: retellApiKey,
      dynamicVariables,
      metadata: {
        patient_id,
        ma_id,
        call_reason,
        handoff_id: handoffId,
      },
    });
    retellCallId = r.response.call_id;
    retellLatencyMs = r.latencyMs;
    retellResponse = r.response;
  } catch (e) {
    // Error path: fire-and-forget cache status update. Frontend already gets
    // the failure; Retell didn't accept the call, so cache consistency is
    // less critical here.
    const msg = e instanceof Error ? e.message : String(e);
    void updateHandoffStatus(pool, handoffId, 'error', {
      error_detail: msg.slice(0, 500),
    }).catch(() => {
      /* swallow — logged inside if needed */
    });
    return sendError(res, 502, 'retell_register_failed', e);
  }

  // Success path: block on the cache UPDATE so the row doesn't get stuck in
  // 'pending'. If the UPDATE itself fails, log loudly but still return success
  // to the frontend — the call IS registered with Retell, which is what
  // matters operationally.
  try {
    await updateHandoffStatus(pool, handoffId, 'success', {
      latency_ms: retellLatencyMs,
      response: { call_id: retellCallId },
    });
  } catch (e) {
    logError('handoff_status_update_failed_on_success', e, {
      request_id: requestId,
      handoff_id: handoffId,
      retell_call_id: retellCallId,
    });
  }

  const sip_uri = sipUriForCall(retellCallId);
  const expires_in_seconds =
    extractExpiresInSeconds(retellResponse) ?? config.cacheTtlSec;
  const durationMs = Date.now() - startedAt;

  logInfo('session_created', {
    request_id: requestId,
    patient_id,
    ma_id,
    call_reason,
    handoff_id: handoffId,
    retell_call_id: retellCallId,
    duration_ms: durationMs,
    outcome: 'success',
  });

  res.status(200).json({
    call_id: retellCallId,
    sip_uri,
    handoff_id: handoffId,
    expires_in_seconds,
  });
}
