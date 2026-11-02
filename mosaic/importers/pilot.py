"""Import recorded pilot runs into Atlas storage.

The pilot ran six to fifty agents on Gemma 3 4B and recorded every message, survey, and mean residual vector.
This importer re-verifies each log's hash chain, keeps the text and survey data, and turns each captured
activation into a projection on the negative affect direction. The projection drops massive activation
dimensions exactly as the pilot's analysis does. No value is invented: a field the pilot did not record stays absent.
"""

from __future__ import annotations

import gzip
import json
import sys
from pathlib import Path

import numpy as np

BRANCH_SETS = {
    "pilot-negative-lead": ("pilot_control", "pilot_affect_down_lead", "Six agents. Lead steered toward negative affect."),
    "pilot-negative-peer": ("pilot_control", "pilot_affect_down_peer", "Six agents. Reveal holder steered toward negative affect."),
    "pilot-positive-lead": ("pilot_control", "pilot_affect_up_lead", "Six agents. Lead steered toward positive affect."),
    "pilot-random-lead": ("pilot_control", "pilot_random_lead", "Six agents. Lead steered in a random direction of equal norm."),
    "pilot-prompted-lead": ("pilot_control", "pilot_prompt_matched_lead", "Six agents. Lead instructed to be gloomy, no steering."),
    "scale-50-negative-lead": ("scale_n50_control", "scale_n50_affect_down_lead", "Fifty agents. Lead steered toward negative affect."),
    "scale-50-random-lead": ("scale_n50_control", "scale_n50_random_lead", "Fifty agents. Lead steered in a random direction of equal norm."),
}
MESSAGE_PHASES = {"lead_open", "message"}


def _verify_chain(path: Path) -> dict:
    import hashlib

    fields = ("seq", "ts", "run_id", "round", "agent", "event", "payload", "prev_hash")
    prev = "0" * 64
    n = 0
    with path.open(encoding="utf-8") as f:
        for n, line in enumerate(f, start=1):
            r = json.loads(line)
            body = json.dumps({k: r[k] for k in fields}, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
            if r["prev_hash"] != prev or r["hash"] != hashlib.sha256(body.encode()).hexdigest():
                return {"ok": False, "entries": n, "first_bad_line": n}
            prev = r["hash"]
    return {"ok": True, "entries": n, "head": prev}


def _direction(pilot: Path) -> np.ndarray:
    d = np.load(pilot / "data/directions/affect_negative_direction.npy").astype(np.float64)
    files = sorted((pilot / "data/runs/pilot_control").glob("seed_*/activations.npy"))
    acts = np.concatenate([np.load(f).astype(np.float64) for f in files])
    mean_abs = np.abs(acts).mean(axis=0)
    drop = np.flatnonzero(mean_abs > 100 * np.median(mean_abs))
    d = d.copy()
    d[drop] = 0.0
    return d / np.linalg.norm(d), [int(i) for i in drop]


def import_run(folder: Path, direction: np.ndarray) -> dict:
    records = [json.loads(line) for line in (folder / "log.jsonl").open(encoding="utf-8")]
    acts = np.load(folder / "activations.npy").astype(np.float64)
    team = next(r for r in records if r["event"] == "team")["payload"]
    run = json.loads((folder / "run.json").read_text())
    agents = [{"id": a["name"], "role": "Lead" if a["role"] == "lead" else "Member", "team": 1,
               "model": "gemma-3-4b-it", "persona": a["persona"]} for a in team["agents"]]
    messages, readings, outcomes = [], [], []
    steered = None
    by_round: dict[int, int] = {}
    for r in records:
        p, step, agent = r["payload"], r["round"], r["agent"]
        if r["event"] == "round_start" and p.get("steered"):
            steered = p["steered"]
        if r["event"] == "generation":
            proj = float(acts[p["capture_index"]] @ direction)
            if p.get("phase") in MESSAGE_PHASES:
                by_round[step] = by_round.get(step, 0) + 1
                mid = f"m{step:04d}-{agent}"
                messages.append({"id": mid, "step": step, "sender": agent, "recipients": [], "text": p["text"],
                                 "steered": bool(p.get("steered"))})
                readings.append({"step": step, "agent": agent, "message_id": mid, "projection": proj})
        elif r["event"] == "survey" and p.get("parsed"):
            q = p["parsed"]
            for name in ("affect", "negative_affect", "positive_affect"):
                if q.get(name) is not None:
                    outcomes.append({"step": step, "agent": agent, "name": name, "value": float(q[name])})
        elif r["event"] == "decision":
            if p.get("accurate") is not None:
                outcomes.append({"step": step, "agent": agent, "name": "decision_accuracy", "value": float(p["accurate"])})
        elif r["event"] == "tone":
            outcomes.append({"step": step, "agent": agent, "name": "message_tone", "value": float(p["rating"])})
        elif r["event"] == "voice" and p.get("holder"):
            outcomes.append({"step": step, "agent": agent, "name": "holder_voice", "value": float(bool(p["voice"]))})
    return {"agents": agents, "reveal_holder": team.get("reveal_holder"), "seed": run["seed"], "steered": steered,
            "messages": messages, "readings": readings, "outcomes": outcomes, "chain": _verify_chain(folder / "log.jsonl"),
            "rounds": run.get("rounds"), "config": run.get("config"), "steer": (run.get("override") or {}).get("steer")}


def run_import(pilot: Path, out: Path, quiet: bool = False) -> dict:
    """Write one gzipped JSON per recorded configuration and a manifest of the comparisons they support."""
    out.mkdir(parents=True, exist_ok=True)
    direction, dropped = _direction(pilot)
    configs = sorted({c for pair in BRANCH_SETS.values() for c in pair[:2]})
    seeds_by_config = {}
    for cfg in configs:
        runs = []
        for folder in sorted((pilot / "data/runs" / cfg).glob("seed_*"), key=lambda p: int(p.name.split("_")[1])):
            runs.append(import_run(folder, direction))
            if not quiet:
                print(f"imported {cfg}/{folder.name}", file=sys.stderr)
        with gzip.open(out / f"{cfg}.json.gz", "wt", encoding="utf-8") as f:
            json.dump({"config": cfg, "runs": runs}, f, ensure_ascii=False)
        seeds_by_config[cfg] = [r["seed"] for r in runs]
    manifest = {
        "source": "mosaic-pilot", "model": "gemma-3-4b-it", "layer": 14, "dropped_dimensions": dropped,
        "concept": {"source": "pilot-directions", "index": 0, "label": "Negative affect direction",
                    "method": "Contrast of first-person mood statements against neutral statements. Layer 14 of the residual stream."},
        "comparisons": {k: {"control": v[0], "treatment": v[1], "description": v[2], "seeds": seeds_by_config[v[1]]}
                        for k, v in BRANCH_SETS.items()},
    }
    (out / "manifest.json").write_text(json.dumps(manifest, indent=1), encoding="utf-8")
    return manifest


if __name__ == "__main__":
    print(json.dumps(run_import(Path(sys.argv[1]), Path(sys.argv[2])), indent=1)[:400])
