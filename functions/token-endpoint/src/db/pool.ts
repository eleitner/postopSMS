import { AuthTypes, Connector, IpAddressTypes } from '@google-cloud/cloud-sql-connector';
import { Pool } from 'pg';
import { config } from '../config';
import { logInfo } from '../log';

let pool: Pool | null = null;
let connector: Connector | null = null;

/**
 * Lazily initialize a pg Pool that connects to Cloud SQL over private IP using
 * IAM database authentication. The service account that runs the Cloud Function
 * must be a Cloud SQL IAM user with schema grants (see README.md).
 *
 * The pool is memoized across warm invocations of the same instance.
 */
export async function getPool(): Promise<Pool> {
  if (pool) return pool;

  connector = new Connector();
  const clientOpts = await connector.getOptions({
    instanceConnectionName: config.dbInstanceConnectionName,
    ipType: IpAddressTypes.PRIVATE,
    authType: AuthTypes.IAM,
  });

  pool = new Pool({
    ...clientOpts,
    database: config.dbName,
    user: config.dbUser,
    max: 5,
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 10_000,
  });

  pool.on('error', (err: Error) => {
    // eslint-disable-next-line no-console
    console.log(
      JSON.stringify({
        severity: 'ERROR',
        message: 'pg_pool_error',
        error_message: err.message,
      }),
    );
  });

  logInfo('pg_pool_initialized');
  return pool;
}
