import { createHmac, timingSafeEqual } from 'node:crypto';
import { config } from '../config';

/**
 * v0 auth: HMAC-SHA256 over `${timestamp}.${rawBody}` with session-jwt-signing-key.
 * Timestamp must be within config.hmacFreshnessWindowSec of server time.
 *
 * The signature MUST cover the timestamp, not just the body, otherwise an
 * attacker who captures one request can replay it indefinitely by changing
 * the header to "now".
 *
 * TODO: replace with Cloud Identity Platform before any prod traffic.
 *
 * Returns null on success, or a short error-code string on failure.
 */
export function verifyHmac(opts: {
  rawBody: string;
  timestampHeader: string | undefined;
  signatureHeader: string | undefined;
  key: string;
}): string | null {
  const { rawBody, timestampHeader, signatureHeader, key } = opts;

  if (!timestampHeader) return 'timestamp_missing';
  if (!signatureHeader) return 'signature_missing';

  const ts = Number.parseInt(timestampHeader, 10);
  if (!Number.isFinite(ts)) return 'timestamp_invalid';

  const skew = Math.abs(Math.floor(Date.now() / 1000) - ts);
  if (skew > config.hmacFreshnessWindowSec) return 'timestamp_stale';

  const expectedHex = createHmac('sha256', key)
    .update(`${ts}.${rawBody}`)
    .digest('hex');

  // Hex compare with constant-time check. Reject length mismatch first so
  // timingSafeEqual doesn't throw.
  if (signatureHeader.length !== expectedHex.length) return 'signature_mismatch';

  let sigBuf: Buffer;
  let expectedBuf: Buffer;
  try {
    sigBuf = Buffer.from(signatureHeader, 'hex');
    expectedBuf = Buffer.from(expectedHex, 'hex');
  } catch {
    return 'signature_invalid';
  }
  if (sigBuf.length !== expectedBuf.length) return 'signature_mismatch';
  if (!timingSafeEqual(sigBuf, expectedBuf)) return 'signature_mismatch';

  return null;
}
