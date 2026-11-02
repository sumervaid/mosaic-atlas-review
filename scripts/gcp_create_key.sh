#!/usr/bin/env bash
# Create the credentials MOSAIC Atlas needs on Google Cloud. Run this yourself, logged in to gcloud as a project owner.
# Usage: ./scripts/gcp_create_key.sh PROJECT_ID
# Writes ~/keys/mosaic-sa.json and ~/keys/hf-token, each readable only by you. Prints no secret.
# Remove the credentials afterward with: ./scripts/gcp_create_key.sh PROJECT_ID --remove
set -euo pipefail
PROJECT="${1:?Usage: gcp_create_key.sh PROJECT_ID [--remove]}"
SA="mosaic-atlas@${PROJECT}.iam.gserviceaccount.com"
KEY="$HOME/keys/mosaic-sa.json"
TOKEN="$HOME/keys/hf-token"

if [ "${2:-}" = "--remove" ]; then
  gcloud iam service-accounts delete "$SA" --project "$PROJECT" --quiet
  rm -f "$KEY" "$TOKEN"
  echo "Removed the service account and the local key and token files."
  exit 0
fi

umask 077
mkdir -p "$HOME/keys"
gcloud services enable compute.googleapis.com --project "$PROJECT"
gcloud iam service-accounts describe "$SA" --project "$PROJECT" >/dev/null 2>&1 \
  || gcloud iam service-accounts create mosaic-atlas --project "$PROJECT" --display-name "MOSAIC Atlas"
for role in roles/compute.admin roles/iam.serviceAccountUser; do
  gcloud projects add-iam-policy-binding "$PROJECT" --member "serviceAccount:$SA" --role "$role" --condition=None --quiet >/dev/null
done
[ -f "$KEY" ] || gcloud iam service-accounts keys create "$KEY" --iam-account "$SA" --project "$PROJECT"
chmod 600 "$KEY"

if [ ! -f "$TOKEN" ]; then
  "$(dirname "$0")/../.venv/bin/python" - "$TOKEN" <<'PY'
import sys
from pathlib import Path
from huggingface_hub import get_token

token = get_token()
if not token:
    sys.exit("No Hugging Face login found. Save a read token alone in ~/keys/hf-token.")
Path(sys.argv[1]).write_text(token)
PY
  chmod 600 "$TOKEN"
fi

echo "Done. Key: $KEY  Token: $TOKEN"
