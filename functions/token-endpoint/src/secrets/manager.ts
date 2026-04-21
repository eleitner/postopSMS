import { SecretManagerServiceClient } from '@google-cloud/secret-manager';
import { logInfo } from '../log';

let client: SecretManagerServiceClient | null = null;
const cache = new Map<string, string>();

function getClient(): SecretManagerServiceClient {
  if (!client) client = new SecretManagerServiceClient();
  return client;
}

/**
 * Fetch a Secret Manager secret by resource name
 * (e.g. projects/<proj>/secrets/<name>/versions/latest).
 *
 * Cached in memory for the life of the instance. Rotation requires a new
 * instance; acceptable for v0. If we need hot rotation, replace this with
 * a TTL-based cache.
 */
export async function accessSecret(resourceName: string): Promise<string> {
  const hit = cache.get(resourceName);
  if (hit !== undefined) return hit;

  const [version] = await getClient().accessSecretVersion({ name: resourceName });
  const payload = version.payload?.data;
  if (!payload) throw new Error(`Secret ${resourceName} has no payload`);

  const value =
    typeof payload === 'string' ? payload : Buffer.from(payload).toString('utf8');

  cache.set(resourceName, value);
  logInfo('secret_loaded', { resource: resourceName });
  return value;
}
