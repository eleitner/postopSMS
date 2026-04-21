import type { Response } from '@google-cloud/functions-framework';
import { logError } from '../log';

/**
 * Send a JSON error response with a generic code. Full error detail is logged
 * server-side only. Client never sees stack traces or internal strings.
 */
export function sendError(
  res: Response,
  status: number,
  code: string,
  detail: unknown,
): void {
  logError(code, detail);
  res.status(status).json({ error: code });
}
