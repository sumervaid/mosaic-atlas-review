#!/usr/bin/env bash
# Runs on the Google Cloud machine. Installs MOSAIC Atlas, loads the configured model once, and starts the API.
# The API listens on localhost only, so researchers reach it through an SSH tunnel.
set -euo pipefail
CONFIG="${1:-configs/gemma4b_small.yaml}"
cd "$HOME/mosaic-atlas"

until nvidia-smi >/dev/null 2>&1; do echo "Waiting for the GPU driver."; sleep 10; done

command -v uv >/dev/null 2>&1 || curl -LsSf https://astral.sh/uv/install.sh | sh
export PATH="$HOME/.local/bin:$PATH"
uv venv --python 3.11 .venv
uv pip install --python .venv/bin/python -e .

export HF_TOKEN="$(cat "$HOME/.mosaic_hf_token")"
.venv/bin/python - "$CONFIG" <<'PY'
import sys
from mosaic.schemas import load_config
from mosaic.serve.backend import backend_from_config

cfg = load_config(sys.argv[1])
be = backend_from_config(cfg.model, cfg.layer)
print(f"Loaded {be.name}. Layer {be.layer}. SAE: {be.sae.source if be.sae else 'none'}.")
PY

nohup .venv/bin/python -m uvicorn mosaic.api.app:app --host 127.0.0.1 --port 8000 > "$HOME/mosaic-api.log" 2>&1 < /dev/null &
echo "API started on the machine, port 8000. Log: ~/mosaic-api.log"
