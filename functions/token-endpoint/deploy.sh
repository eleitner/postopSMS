#!/usr/bin/env bash
# Deploy the dnc-token-endpoint Cloud Function (Gen 2).
# DO NOT run until the infrastructure prerequisites in README.md are satisfied.
#
# Intentionally exits immediately if invoked without an explicit "--really" flag,
# to avoid an accidental deploy from an automation context.

set -euo pipefail

if [[ "${1:-}" != "--really" ]]; then
  echo "Refusing to deploy without --really. Read README.md first."
  exit 1
fi

PROJECT=core-waters-493614-n3
REGION=us-east4
INSTANCE_CONN="${PROJECT}:${REGION}:dnc-postgres-prod"
SA="dnc-token-endpoint-sa@${PROJECT}.iam.gserviceaccount.com"
CONNECTOR="projects/${PROJECT}/locations/${REGION}/connectors/dnc-connector"

RETELL_SECRET="projects/${PROJECT}/secrets/retell-api-key-production/versions/latest"
HMAC_SECRET="projects/${PROJECT}/secrets/session-jwt-signing-key/versions/latest"

gcloud functions deploy dnc-token-endpoint \
  --project="${PROJECT}" \
  --region="${REGION}" \
  --gen2 \
  --runtime=nodejs20 \
  --source=. \
  --entry-point=createSession \
  --trigger-http \
  --allow-unauthenticated \
  --service-account="${SA}" \
  --vpc-connector="${CONNECTOR}" \
  --vpc-egress=private-ranges-only \
  --memory=512MiB \
  --timeout=30s \
  --max-instances=10 \
  --set-env-vars="DB_INSTANCE_CONNECTION_NAME=${INSTANCE_CONN},DB_NAME=dnc_platform,DB_SCHEMA=dnc,DB_USER=${SA%.gserviceaccount.com},RETELL_AGENT_ID=agent_c48583425b1693edbcd88f1f49,RETELL_API_KEY_SECRET=${RETELL_SECRET},HMAC_SIGNING_KEY_SECRET=${HMAC_SECRET}"
