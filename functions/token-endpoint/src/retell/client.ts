import { config } from '../config';
import type { DynamicVariables, RetellRegisterResponse } from '../types';

/**
 * Register a phone call with Retell. The returned call_id is the identifier
 * that will be matched when the SIP INVITE arrives via Telnyx after the MA's
 * softphone issues SIP REFER to `sip:{call_id}@sip.retellai.com`.
 *
 * Retell docs: https://docs.retellai.com/api-references/register-phone-call
 *
 * TODO(pre-deploy): verify the exact request + response schema against the
 * current Retell API docs. This scaffold assumes:
 *   - POST /v2/register-phone-call
 *   - Bearer auth
 *   - Body: { agent_id, retell_llm_dynamic_variables, metadata }
 *   - Response contains a `call_id` string
 */
export async function registerPhoneCall(args: {
  apiKey: string;
  dynamicVariables: DynamicVariables;
  metadata: Record<string, string>;
}): Promise<{ response: RetellRegisterResponse; latencyMs: number }> {
  const started = Date.now();

  const res = await fetch(`${config.retellApiBase}/v2/register-phone-call`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${args.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      agent_id: config.retellAgentId,
      retell_llm_dynamic_variables: args.dynamicVariables,
      metadata: args.metadata,
    }),
  });

  const latencyMs = Date.now() - started;

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Retell ${res.status}: ${text.slice(0, 300)}`);
  }

  const json = (await res.json()) as RetellRegisterResponse;
  if (!json || typeof json.call_id !== 'string' || !json.call_id) {
    throw new Error('Retell response missing call_id');
  }
  return { response: json, latencyMs };
}

export function sipUriForCall(callId: string): string {
  return `sip:${callId}@sip.retellai.com`;
}

/**
 * Pull an expiry, in seconds, out of the Retell response if one is present.
 * Keeps frontend + backend aligned on how long the call_id is valid.
 *
 * TODO(pre-deploy): verify the actual field name in Retell docs and trim
 * this candidate list to whichever Retell really returns.
 */
export function extractExpiresInSeconds(
  response: RetellRegisterResponse,
): number | null {
  const candidates = ['expires_in_seconds', 'expires_in', 'ttl_seconds', 'ttl'];
  for (const k of candidates) {
    const v = response[k];
    if (typeof v === 'number' && Number.isFinite(v) && v > 0) {
      return Math.floor(v);
    }
  }
  return null;
}
