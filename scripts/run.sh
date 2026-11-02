#!/usr/bin/env bash
# Start the API and the web interface on this machine. Stop both with Ctrl-C.
# Set API_URL to use an API elsewhere, such as a tunnel to a Google Cloud machine. The local API then stays off.
set -euo pipefail
cd "$(dirname "$0")/.."

WEB_PORT="${WEB_PORT:-3000}"
API_URL="${API_URL:-}"
pids=()
trap 'kill "${pids[@]}" 2>/dev/null || true' EXIT

if [ -z "$API_URL" ]; then
  API_PORT="${API_PORT:-8000}"
  API_URL="http://127.0.0.1:${API_PORT}"
  .venv/bin/python -m uvicorn mosaic.api.app:app --host 127.0.0.1 --port "$API_PORT" &
  pids+=($!)
fi

(cd web && NEXT_PUBLIC_API_URL="$API_URL" pnpm exec next build >/dev/null && NEXT_PUBLIC_API_URL="$API_URL" pnpm exec next start -p "$WEB_PORT") &
pids+=($!)

echo "Starting. The first start can take a minute."
until curl -sf "${API_URL}/health" >/dev/null 2>&1; do sleep 1; done
until curl -s -o /dev/null "http://127.0.0.1:${WEB_PORT}"; do sleep 1; done
echo "MOSAIC Atlas is ready at http://127.0.0.1:${WEB_PORT}"
wait
