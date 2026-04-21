import type { RequestBody } from '../types';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_MA_ID_LEN = 64;
const MAX_CALL_REASON_LEN = 64;

export type ValidationResult =
  | { ok: true; body: RequestBody }
  | { ok: false; reason: string };

export function validateRequestBody(raw: unknown): ValidationResult {
  if (!raw || typeof raw !== 'object') return { ok: false, reason: 'body_not_object' };
  const r = raw as Record<string, unknown>;

  if (typeof r.patient_id !== 'string' || !UUID_RE.test(r.patient_id)) {
    return { ok: false, reason: 'patient_id_invalid' };
  }
  if (typeof r.ma_id !== 'string' || !r.ma_id || r.ma_id.length > MAX_MA_ID_LEN) {
    return { ok: false, reason: 'ma_id_invalid' };
  }
  if (
    typeof r.call_reason !== 'string' ||
    !r.call_reason ||
    r.call_reason.length > MAX_CALL_REASON_LEN
  ) {
    return { ok: false, reason: 'call_reason_invalid' };
  }

  return {
    ok: true,
    body: {
      patient_id: r.patient_id,
      ma_id: r.ma_id,
      call_reason: r.call_reason,
    },
  };
}
