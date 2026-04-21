# dnc-token-endpoint

Cloud Function (Gen 2, Node 20, TypeScript) that mints Retell `register-phone-call` sessions for the DNC MA softphone running at https://www.thednc.org/assess/.

**Status:** v0 prototype. Scaffolded but not deployed.

## Flow

React softphone -> `POST /create-session` -> this function:

1. Verifies `X-DNC-Signature` + `X-DNC-Timestamp` (HMAC-SHA256 over `timestamp + "." + rawBody`, 30s freshness).
2. Looks up `dnc.patient_state` by `patient_id`. PHI stays in the DB.
3. Writes an `ai_handoff_cache` row (60s TTL, status=pending) + a `patient_events` row (`event_type='token_minted'`) in one Postgres transaction.
4. Calls Retell `/v2/register-phone-call` with de-identified `retell_llm_dynamic_variables`.
5. Returns `{ call_id, sip_uri, handoff_id, expires_in_seconds }` where `sip_uri = "sip:{call_id}@sip.retellai.com"`.
6. Flips cache row to `success` or `error` after the Retell call settles.

## Local dev

```bash
npm install
npm run dev
```

The function expects Cloud SQL + Secret Manager connectivity; local runs won't reach the private DB without an Auth Proxy. The scaffold is designed for the deployed environment.

## Deploy

Infrastructure prerequisites (one-time; NOT done by this scaffold):

- Service account `dnc-token-endpoint-sa@core-waters-493614-n3.iam.gserviceaccount.com`
- IAM on the service account:
  - `roles/cloudsql.client`
  - `roles/cloudsql.instanceUser`
  - `roles/secretmanager.secretAccessor` scoped *per-secret* to `retell-api-key-production` and `session-jwt-signing-key` (not project-wide)
- Serverless VPC Access connector `dnc-connector` in `dnc-vpc`, egress reachable to `10.121.0.3`
- Cloud SQL IAM DB user:
  ```
  gcloud sql users create dnc-token-endpoint-sa@core-waters-493614-n3.iam \
    --instance=dnc-postgres-prod \
    --type=cloud_iam_service_account
  ```
- Postgres grants (run as an existing Postgres admin):
  ```sql
  GRANT USAGE ON SCHEMA dnc TO "dnc-token-endpoint-sa@core-waters-493614-n3.iam";
  GRANT SELECT ON dnc.patient_state TO "dnc-token-endpoint-sa@core-waters-493614-n3.iam";
  GRANT INSERT, UPDATE ON dnc.ai_handoff_cache TO "dnc-token-endpoint-sa@core-waters-493614-n3.iam";
  GRANT INSERT ON dnc.patient_events TO "dnc-token-endpoint-sa@core-waters-493614-n3.iam";
  ```

Then see `deploy.sh` for the gcloud command. Do not run until the above is in place.

## Auth (v0 only)

HMAC-SHA256 over `${timestamp}.${rawBody}` with `session-jwt-signing-key`. The React app sends `X-DNC-Signature` (hex) and `X-DNC-Timestamp` (unix seconds). The endpoint is deployed `--allow-unauthenticated`; HMAC + timestamp freshness is the entire auth layer. Replace with Cloud Identity Platform (or similar) before any prod traffic.
