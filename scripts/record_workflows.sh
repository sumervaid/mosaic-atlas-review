#!/usr/bin/env bash
# Refresh docs/screenshots and docs/gifs from a production build.
# The API starts from a copy of the code in /tmp and a brand-new MOSAIC_HOME, so saved settings, credentials,
# and home directory paths stay out of every frame. Credentials here are fake, written fresh on each start.
# Needs Google Chrome and the screenshots extra: uv pip install --python .venv/bin/python -e ".[screenshots]"
set -euo pipefail
REPO="$(cd "$(dirname "$0")/.." && pwd)"
SRC=/tmp/atlas-src
HOME_DIR=/tmp/atlas-gifs
DEMO=/tmp/atlas-demo
FRAMES=/tmp/atlas-frames
API_PORT="${API_PORT:-8000}"
WEB_PORT="${WEB_PORT:-3000}"
API_URL="http://127.0.0.1:${API_PORT}"
WEB_URL="http://127.0.0.1:${WEB_PORT}"
# Refuse a busy port. An API already listening could hold real settings, and it must stay out of the capture.
for port in "$API_PORT" "$WEB_PORT"; do
  if [ -n "$(lsof -ti "tcp:$port" -sTCP:LISTEN)" ]; then
    echo "Port $port is in use. Stop that server, or set API_PORT and WEB_PORT."
    exit 1
  fi
done

stop_servers() {
  for port in "$API_PORT" "$WEB_PORT"; do
    lsof -ti "tcp:$port" -sTCP:LISTEN | xargs kill 2>/dev/null || true
  done
}
trap stop_servers EXIT

rm -rf "$SRC" "$HOME_DIR" "$DEMO" "$FRAMES"
mkdir -p "$SRC" "$HOME_DIR" "$DEMO" "$FRAMES"
cp -R "$REPO/mosaic" "$REPO/configs" "$REPO/data" "$SRC/"

( umask 077
  cat > "$DEMO/key.json" <<'KEY'
{"type": "service_account", "client_email": "demo@demo-project.iam.gserviceaccount.com", "project_id": "demo-project", "private_key": "FAKE"}
KEY
  printf 'FAKE' > "$DEMO/token" )
chmod 600 "$DEMO/key.json" "$DEMO/token"
export DEMO_KEY_PATH="$DEMO/key.json" DEMO_TOKEN_PATH="$DEMO/token" API_URL WEB_URL

start_api() {
  (cd "$SRC" && MOSAIC_HOME="$HOME_DIR" PYTHONPATH="$SRC" "$REPO/.venv/bin/python" -m uvicorn mosaic.api.app:app --host 127.0.0.1 --port "$API_PORT" >"$HOME_DIR/api.log" 2>&1) &
  until curl -sf "$API_URL/health" >/dev/null 2>&1; do sleep 1; done
}

start_api
cd "$REPO/web"
NEXT_PUBLIC_API_URL="$API_URL" pnpm exec next build >/dev/null
NEXT_PUBLIC_API_URL="$API_URL" pnpm exec next start -p "$WEB_PORT" >"$HOME_DIR/web.log" 2>&1 &
until curl -s -o /dev/null "$WEB_URL"; do sleep 1; done

if [ "${SKIP_SCREENSHOTS:-}" != "1" ]; then
  node scripts/screenshots.mjs
fi

# The recordings start clean: no forks, no measured edges, and no saved settings from the screenshots above.
rm -rf "$HOME_DIR/experiments" "$HOME_DIR/gcp_settings.json"
FRAMES_DIR="$FRAMES" node scripts/record-workflows.mjs "$@"
"$REPO/.venv/bin/python" "$REPO/scripts/make_gifs.py" "$FRAMES" "$REPO/docs/gifs" "$@"
