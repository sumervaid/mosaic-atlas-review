#!/usr/bin/env bash
# Install MOSAIC Atlas: a Python environment for the API and the packages for the web interface.
# Needs uv and pnpm. Installs CPU or GPU PyTorch, whichever the platform default provides.
set -euo pipefail
cd "$(dirname "$0")/.."

need() { command -v "$1" >/dev/null 2>&1 || { echo "Missing $1. $2"; exit 1; }; }
need uv "Install it from https://docs.astral.sh/uv/."
need node "Install Node 20 or later from https://nodejs.org/."
need pnpm "Install it with: npm install -g pnpm"

uv venv --python 3.11 .venv
uv pip install --python .venv/bin/python -e ".[test]"
(cd web && pnpm install --frozen-lockfile && pnpm build)

echo
echo "Installed. Start MOSAIC Atlas with: ./scripts/run.sh"
