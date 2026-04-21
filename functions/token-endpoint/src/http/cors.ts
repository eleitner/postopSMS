import type { Request, Response } from '@google-cloud/functions-framework';
import { ALLOWED_ORIGINS } from '../config';

const ORIGINS = new Set<string>(ALLOWED_ORIGINS);

export function isAllowedOrigin(origin: string | undefined): boolean {
  return !!origin && ORIGINS.has(origin);
}

export function applyCors(req: Request, res: Response): void {
  const origin = req.header('origin');
  if (isAllowedOrigin(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin as string);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader(
      'Access-Control-Allow-Headers',
      'Content-Type, X-DNC-Signature, X-DNC-Timestamp',
    );
    res.setHeader('Access-Control-Max-Age', '600');
  }
}

export function handlePreflight(req: Request, res: Response): boolean {
  if (req.method !== 'OPTIONS') return false;
  applyCors(req, res);
  if (isAllowedOrigin(req.header('origin'))) {
    res.status(204).send('');
  } else {
    res.status(403).json({ error: 'origin_not_allowed' });
  }
  return true;
}
