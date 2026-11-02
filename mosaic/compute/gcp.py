"""Provision a GPU machine on Google Cloud from a service account key.

Researchers supply the path to a key file. The key's contents never leave this process, are never logged, and are
never returned by the API. gcloud runs against a private config folder, so a researcher's own gcloud login is untouched.
"""

from __future__ import annotations

import json
import os
import shlex
import stat
import subprocess
import time
from dataclasses import asdict, dataclass
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
STATE_DIR = Path(os.environ.get("MOSAIC_HOME", ROOT / "runs"))
SETTINGS = STATE_DIR / "gcp_settings.json"
PROFILES = {
    "4b": {"machine": "g2-standard-12", "gpus": 1, "config": "configs/gemma4b_small.yaml",
           "label": "Gemma 3 4B on one NVIDIA L4, the configuration the pilot used"},
    "12b": {"machine": "g2-standard-24", "gpus": 2, "config": "configs/gemma_256.yaml",
            "label": "Gemma 3 12B on two NVIDIA L4s. Twelve billion bf16 parameters need about 24 GB before activations"},
}


class KeyError_(ValueError):
    pass


def check_key(path: str | Path) -> dict:
    """Validate a service account key file. Returns only non-secret fields."""
    if not str(path).strip():
        raise KeyError_("Point to a Google Cloud service account key file.")
    p = Path(path).expanduser()
    if not p.is_file():
        raise KeyError_(f"No file at {p}.")
    try:
        data = json.loads(p.read_text())
    except (json.JSONDecodeError, UnicodeDecodeError) as exc:
        raise KeyError_("The key file is not valid JSON.") from exc
    if data.get("type") != "service_account":
        raise KeyError_("The key file is not a service account key. Its type must be service_account.")
    for field in ("client_email", "project_id", "private_key"):
        if not data.get(field):
            raise KeyError_(f"The key file is missing {field}.")
    mode = stat.S_IMODE(p.stat().st_mode)
    return {"path": str(p), "client_email": data["client_email"], "project_id": data["project_id"],
            "group_or_world_readable": bool(mode & 0o077)}


@dataclass
class Settings:
    key_path: str = ""
    project: str = ""
    zone: str = "us-central1-a"
    instance: str = "mosaic-atlas"
    profile: str = "4b"
    hf_token_path: str = ""
    image_family: str = "common-cu129-ubuntu-2204-nvidia-580"
    image_project: str = "deeplearning-platform-release"


def load_settings() -> Settings:
    if SETTINGS.exists():
        return Settings(**json.loads(SETTINGS.read_text()))
    return Settings()


def save_settings(s: Settings) -> None:
    SETTINGS.parent.mkdir(parents=True, exist_ok=True)
    SETTINGS.write_text(json.dumps(asdict(s), indent=1))
    SETTINGS.chmod(0o600)


def _env(s: Settings) -> dict:
    env = dict(os.environ)
    env["CLOUDSDK_CONFIG"] = str(STATE_DIR / "gcloud-config")
    env["CLOUDSDK_CORE_DISABLE_PROMPTS"] = "1"
    return env


def up_commands(s: Settings) -> list[list[str]]:
    prof = PROFILES[s.profile]
    base = [f"--project={s.project}", f"--zone={s.zone}"]
    tarball = str(STATE_DIR / "mosaic-atlas.tar.gz")
    return [
        ["gcloud", "auth", "activate-service-account", f"--key-file={s.key_path}"],
        ["gcloud", "compute", "instances", "create", s.instance, *base, f"--machine-type={prof['machine']}",
         f"--accelerator=type=nvidia-l4,count={prof['gpus']}", "--maintenance-policy=TERMINATE",
         f"--image-family={s.image_family}", f"--image-project={s.image_project}", "--boot-disk-size=200GB",
         "--boot-disk-type=pd-ssd"],
        ["git", "-C", str(ROOT), "archive", "--format=tar.gz", "-o", tarball, "HEAD"],
        ["gcloud", "compute", "scp", *base, tarball, f"{s.instance}:~/mosaic-atlas.tar.gz"],
        ["gcloud", "compute", "scp", *base, s.hf_token_path, f"{s.instance}:~/.mosaic_hf_token"],
        ["gcloud", "compute", "ssh", s.instance, *base, "--command",
         f"mkdir -p mosaic-atlas && tar -xzf mosaic-atlas.tar.gz -C mosaic-atlas && chmod 600 ~/.mosaic_hf_token && bash mosaic-atlas/scripts/vm_bootstrap.sh {prof['config']}"],
    ]


def tunnel_command(s: Settings) -> list[str]:
    return ["gcloud", "compute", "ssh", s.instance, f"--project={s.project}", f"--zone={s.zone}", "--",
            "-N", "-L", "8000:localhost:8000"]


def down_commands(s: Settings) -> list[list[str]]:
    return [["gcloud", "compute", "instances", "delete", s.instance, f"--project={s.project}", f"--zone={s.zone}", "--quiet"]]


def status_command(s: Settings) -> list[str]:
    return ["gcloud", "compute", "instances", "describe", s.instance, f"--project={s.project}", f"--zone={s.zone}",
            "--format=value(status)"]


def validate(s: Settings, need_hf: bool = True) -> list[str]:
    problems = []
    try:
        check_key(s.key_path)
    except KeyError_ as exc:
        problems.append(str(exc))
    if not s.project:
        problems.append("Set a Google Cloud project.")
    if s.profile not in PROFILES:
        problems.append(f"Unknown profile {s.profile}.")
    if need_hf and not (s.hf_token_path and Path(s.hf_token_path).expanduser().is_file()):
        problems.append("Point to a file holding a Hugging Face token with access to Gemma 3.")
    return problems


def _run_with_retry(cmd: list[str], s: Settings):
    """SSH refuses connections for the first minutes after a machine boots, so copies and logins retry."""
    is_ssh = cmd[:3] in (["gcloud", "compute", "scp"], ["gcloud", "compute", "ssh"])
    attempts = 20 if is_ssh else 1
    for attempt in range(attempts):
        proc = subprocess.run(cmd, env=_env(s), capture_output=True, text=True)
        if proc.returncode == 0 or attempt == attempts - 1:
            return proc
        time.sleep(15)
    return proc


def run(commands: list[list[str]], s: Settings, dry_run: bool = True, on_line=None) -> dict:
    """Print or run gcloud commands. Each key is passed as a path, so output cannot contain its contents."""
    printable = [" ".join(shlex.quote(c) for c in cmd) for cmd in commands]
    if dry_run:
        return {"dry_run": True, "commands": printable}
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    done = []
    for cmd, text in zip(commands, printable):
        if on_line:
            on_line(text)
        proc = _run_with_retry(cmd, s)
        done.append({"command": text, "returncode": proc.returncode, "stderr": proc.stderr[-1500:]})
        if proc.returncode != 0:
            return {"dry_run": False, "ok": False, "steps": done}
    return {"dry_run": False, "ok": True, "steps": done}


def instance_status(s: Settings) -> str | None:
    if not s.project or not s.key_path:
        return None
    proc = subprocess.run(status_command(s), env=_env(s), capture_output=True, text=True, timeout=30)
    return proc.stdout.strip() or None if proc.returncode == 0 else None
