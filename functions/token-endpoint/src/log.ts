/**
 * Structured JSON logging to stdout. Cloud Run / Cloud Functions captures stdout
 * into Cloud Logging.
 *
 * Rule: NEVER log request/response bodies, headers, or anything PHI-shaped.
 * Allowed: request_id, patient_id (opaque UUID), ma_id, call_reason,
 * handoff_id, retell_call_id, duration_ms, outcome.
 */

export interface LogContext {
  request_id?: string;
  patient_id?: string;
  ma_id?: string;
  call_reason?: string;
  handoff_id?: string;
  retell_call_id?: string;
  duration_ms?: number;
  outcome?: string;
  [k: string]: unknown;
}

function emit(severity: string, message: string, ctx?: LogContext): void {
  const entry = {
    severity,
    message,
    timestamp: new Date().toISOString(),
    ...(ctx ?? {}),
  };
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(entry));
}

export const logInfo = (msg: string, ctx?: LogContext): void => emit('INFO', msg, ctx);

export const logWarn = (msg: string, ctx?: LogContext): void => emit('WARNING', msg, ctx);

export const logError = (msg: string, detail: unknown, ctx?: LogContext): void => {
  const err =
    detail instanceof Error
      ? { error_message: detail.message, error_stack: detail.stack }
      : { error_detail: detail === undefined || detail === null ? null : String(detail) };
  emit('ERROR', msg, { ...(ctx ?? {}), ...err });
};
