#!/usr/bin/env bash
set -euo pipefail

: "${GOOGLE_CLOUD_PROJECT:?Set GOOGLE_CLOUD_PROJECT to the staging project ID}"
: "${MATCH_SERVICE_ACCOUNT:?Set MATCH_SERVICE_ACCOUNT to the Match Server service account email}"
: "${DIRECTOR_SERVICE_ACCOUNT:?Set DIRECTOR_SERVICE_ACCOUNT to the Director service account email}"

GOOGLE_CLOUD_REGION="${GOOGLE_CLOUD_REGION:-asia-northeast1}"
GOOGLE_CLOUD_LOCATION="${GOOGLE_CLOUD_LOCATION:-asia-northeast1}"
ARTIFACT_REPOSITORY="${ARTIFACT_REPOSITORY:-dopagaki}"
MATCH_SERVICE="${MATCH_SERVICE:-dopagaki-match-staging}"
DIRECTOR_SERVICE="${DIRECTOR_SERVICE:-dopagaki-director-staging}"
DIRECTOR_MODEL="${DIRECTOR_MODEL:-gemini-flash-latest}"
IMAGE_TAG="${IMAGE_TAG:-$(git rev-parse --short HEAD)}"
ARTIFACT_HOST="${GOOGLE_CLOUD_REGION}-docker.pkg.dev"
MATCH_IMAGE="${ARTIFACT_HOST}/${GOOGLE_CLOUD_PROJECT}/${ARTIFACT_REPOSITORY}/match:${IMAGE_TAG}"
DIRECTOR_IMAGE="${ARTIFACT_HOST}/${GOOGLE_CLOUD_PROJECT}/${ARTIFACT_REPOSITORY}/director:${IMAGE_TAG}"

gcloud artifacts repositories describe "${ARTIFACT_REPOSITORY}" \
  --project="${GOOGLE_CLOUD_PROJECT}" \
  --location="${GOOGLE_CLOUD_REGION}" >/dev/null

gcloud builds submit . \
  --project="${GOOGLE_CLOUD_PROJECT}" \
  --region="${GOOGLE_CLOUD_REGION}" \
  --config=ops/cloudrun/cloudbuild.yaml \
  --substitutions="_MATCH_IMAGE=${MATCH_IMAGE},_DIRECTOR_IMAGE=${DIRECTOR_IMAGE}"

gcloud run deploy "${DIRECTOR_SERVICE}" \
  --project="${GOOGLE_CLOUD_PROJECT}" \
  --region="${GOOGLE_CLOUD_REGION}" \
  --image="${DIRECTOR_IMAGE}" \
  --service-account="${DIRECTOR_SERVICE_ACCOUNT}" \
  --no-allow-unauthenticated \
  --ingress=all \
  --execution-environment=gen2 \
  --port=8080 \
  --cpu=1 \
  --memory=1Gi \
  --concurrency=8 \
  --timeout=30s \
  --min-instances=0 \
  --max-instances=1 \
  --set-env-vars="DIRECTOR_PROVIDER=gemini-adk,DIRECTOR_MODEL=${DIRECTOR_MODEL},GOOGLE_GENAI_USE_ENTERPRISE=TRUE,GOOGLE_CLOUD_PROJECT=${GOOGLE_CLOUD_PROJECT},GOOGLE_CLOUD_LOCATION=${GOOGLE_CLOUD_LOCATION}"

DIRECTOR_URL="$(gcloud run services describe "${DIRECTOR_SERVICE}" \
  --project="${GOOGLE_CLOUD_PROJECT}" \
  --region="${GOOGLE_CLOUD_REGION}" \
  --format='value(status.url)')"

gcloud run services add-iam-policy-binding "${DIRECTOR_SERVICE}" \
  --project="${GOOGLE_CLOUD_PROJECT}" \
  --region="${GOOGLE_CLOUD_REGION}" \
  --member="serviceAccount:${MATCH_SERVICE_ACCOUNT}" \
  --role=roles/run.invoker >/dev/null

gcloud run deploy "${MATCH_SERVICE}" \
  --project="${GOOGLE_CLOUD_PROJECT}" \
  --region="${GOOGLE_CLOUD_REGION}" \
  --image="${MATCH_IMAGE}" \
  --service-account="${MATCH_SERVICE_ACCOUNT}" \
  --allow-unauthenticated \
  --ingress=all \
  --execution-environment=gen2 \
  --no-use-http2 \
  --session-affinity \
  --port=8080 \
  --cpu=1 \
  --memory=1Gi \
  --concurrency=80 \
  --timeout=1800s \
  --min-instances=0 \
  --max-instances=1 \
  --set-env-vars="DIRECTOR_ADAPTER=http,DIRECTOR_URL=${DIRECTOR_URL},DIRECTOR_AUTH=google-id-token,DIRECTOR_AUDIENCE=${DIRECTOR_URL},DIRECTOR_TIMEOUT_MS=8000"

MATCH_URL="$(gcloud run services describe "${MATCH_SERVICE}" \
  --project="${GOOGLE_CLOUD_PROJECT}" \
  --region="${GOOGLE_CLOUD_REGION}" \
  --format='value(status.url)')"

printf 'Match URL: %s\nDirector URL (private): %s\n' "${MATCH_URL}" "${DIRECTOR_URL}"
