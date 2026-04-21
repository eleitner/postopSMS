/**
 * Runtime configuration. All values come from env vars set at deploy time
 * (see ../deploy.sh). Throws at first access if a required var is missing.
 */

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

function optional(name: string, fallback: string): string {
  return process.env[name] ?? fallback;
}

export const config = {
  dbInstanceConnectionName: required('DB_INSTANCE_CONNECTION_NAME'),
  dbName: required('DB_NAME'),
  dbSchema: optional('DB_SCHEMA', 'dnc'),
  dbUser: required('DB_USER'),

  retellAgentId: required('RETELL_AGENT_ID'),
  retellApiBase: optional('RETELL_API_BASE', 'https://api.retellai.com'),
  retellApiKeySecret: required('RETELL_API_KEY_SECRET'),

  hmacSigningKeySecret: required('HMAC_SIGNING_KEY_SECRET'),
  hmacFreshnessWindowSec: 30,

  cacheTtlSec: 60,
  maxBodyBytes: 4096,
};

export const ALLOWED_ORIGINS: readonly string[] = [
  'https://www.thednc.org',
  'https://thednc.org',
  'http://localhost:5173',
  'http://localhost:3000',
];

// TODO: replace with real MA auth (Cloud Identity Platform token claims, etc.).
// v0: hardcoded ma_id -> first name lookup.
export const MA_FIRSTNAME_LOOKUP: Record<string, string> = {
  bradley: 'Bradley',
};
