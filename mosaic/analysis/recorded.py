"""Results for recorded pilot comparisons, in the same shape as a live fork."""

from __future__ import annotations

import gzip
import json
from functools import lru_cache
from pathlib import Path

import numpy as np

from mosaic.analysis.metrics import HOP_LABELS, clean, estimate

ROOT = Path(__file__).resolve().parents[2]
IMPORTED = ROOT / "data" / "imported"
LABELS = {
    "affect": "Reported affect of unsteered agents (1 to 7)",
    "negative_affect": "Reported negative affect of unsteered agents (1 to 7)",
    "positive_affect": "Reported positive affect of unsteered agents (1 to 7)",
    "message_tone": "Judged message tone of unsteered agents (1 to 7)",
    "decision_accuracy": "Decision accuracy of the team",
    "holder_voice": "Reveal holder raises the flaw",
}
TEAM_LEVEL = {"decision_accuracy", "holder_voice"}


@lru_cache(maxsize=1)
def manifest() -> dict:
    p = IMPORTED / "manifest.json"
    return json.loads(p.read_text()) if p.exists() else {"comparisons": {}}


@lru_cache(maxsize=16)
def load_config(name: str) -> dict:
    with gzip.open(IMPORTED / f"{name}.json.gz", "rt", encoding="utf-8") as f:
        return {r["seed"]: r for r in json.load(f)["runs"]}


def _manipulated(comparison: dict, seeds: dict) -> str:
    run = next(iter(seeds.values()))
    if comparison["treatment"].endswith(("_peer",)):
        return run["reveal_holder"]
    return next(a["id"] for a in run["agents"] if a["role"] == "Lead")


def recorded_results(fork_id: str) -> dict:
    comp = manifest()["comparisons"][fork_id]
    ctl, trt = load_config(comp["control"]), load_config(comp["treatment"])
    seeds = sorted(set(ctl) & set(trt))
    # Each seed draws its own named personas, so roster, map, and comparisons follow one seed at a time.
    first = trt[seeds[0]]
    agents = first["agents"]
    target = _manipulated(comp, trt)
    steps = sorted({m["step"] for m in first["messages"]})
    ids = [a["id"] for a in agents]
    hop = {a: ("0" if a == target else "1") for a in ids}

    fronts, per_agent, hop_by_seed = [], {}, {"0": {s: [] for s in steps}, "1": {s: [] for s in steps}}
    outcome = {}
    verified = []
    map_c: dict[int, dict[str, float]] = {s: {} for s in steps}
    map_t: dict[int, dict[str, float]] = {s: {} for s in steps}
    for seed in seeds:
        c, t = ctl[seed], trt[seed]
        verified += [c["chain"]["ok"], t["chain"]["ok"]]
        seed_target = _manipulated(comp, {seed: t})
        mc = {m["id"]: m for m in c["messages"]}
        mt = {m["id"]: m for m in t["messages"]}
        div: dict[str, int] = {}
        for mid in sorted(set(mc) & set(mt), key=lambda k: (int(k[1:5]), k)):
            sender = mc[mid]["sender"]
            if sender not in div and mc[mid]["text"] != mt[mid]["text"]:
                div[sender] = mc[mid]["step"]
        seed_ids = [a["id"] for a in t["agents"]]
        fronts.append([np.mean([a in div and div[a] <= s for a in seed_ids]) for s in steps])
        if seed == seeds[0]:
            for a, v in div.items():
                per_agent[a] = v
        rc = {(r["step"], r["agent"]): r["projection"] for r in c["readings"]}
        rt = {(r["step"], r["agent"]): r["projection"] for r in t["readings"]}
        for s in steps:
            vals0, vals1 = [], []
            for a in seed_ids:
                if (s, a) in rc and (s, a) in rt:
                    d = rt[(s, a)] - rc[(s, a)]
                    (vals0 if a == seed_target else vals1).append(d)
            hop_by_seed["0"][s].append(float(np.mean(vals0)) if vals0 else float("nan"))
            hop_by_seed["1"][s].append(float(np.mean(vals1)) if vals1 else float("nan"))
        if seed == seeds[0]:
            for (s, a), v in rc.items():
                map_c[s][a] = v
            for (s, a), v in rt.items():
                map_t[s][a] = v
        for name in LABELS:
            def mean_of(run, tgt):
                if name in TEAM_LEVEL:
                    vals = [o["value"] for o in run["outcomes"] if o["name"] == name]
                else:
                    vals = [o["value"] for o in run["outcomes"] if o["name"] == name and o["agent"] != tgt]
                return float(np.mean(vals)) if vals else float("nan")
            outcome.setdefault(name, []).append((mean_of(c, seed_target), mean_of(t, seed_target)))

    outcomes = []
    for name, pairs in outcome.items():
        cv, tv = np.array([p[0] for p in pairs]), np.array([p[1] for p in pairs])
        if np.all(np.isnan(cv)) and np.all(np.isnan(tv)):
            continue
        d = estimate(tv - cv)
        lo, hi = d["ci"]
        outcomes.append({"name": name, "label": LABELS[name], "control": clean(float(np.nanmean(cv))),
                         "treatment": clean(float(np.nanmean(tv))), "difference": d,
                         "excludes_zero": bool(lo is not None and hi is not None and (lo > 0 or hi < 0))})
    outcomes.append({"name": "said_represented_gap", "label": "Said versus represented gap", "control": None,
                     "treatment": None, "difference": None, "excludes_zero": False,
                     "not_measured": "Needs natural language autoencoder readouts, which the pilot did not record."})
    hop_effects = []
    for h in ("0", "1"):
        grid = np.array([hop_by_seed[h][s] for s in steps])
        by_rep = [float(np.nanmean(col)) if np.any(~np.isnan(col)) else float("nan") for col in grid.T]
        hop_effects.append({"hop": h, "agents": sum(1 for a in ids if hop[a] == h), "overall": estimate(by_rep),
                            "by_step": {str(s): estimate(hop_by_seed[h][s]) for s in steps}})
    return {
        "fork_id": fork_id, "status": "complete", "recorded": True, "description": comp["description"],
        "model": manifest()["model"], "replicates": len(seeds), "steps": steps, "agents": agents, "targets": [target],
        "hop": hop, "concept": {"source": "pilot-directions", "feature": 0, "label": manifest()["concept"]["label"]},
        "front": {"treatment": [float(x) for x in np.mean(fronts, axis=0)], "noise_floor": None, "noise_floor_measured": False},
        "divergence": {a: {"median": v, "iqr": [v, v], "diverged_in": 1, "replicates": 1} for a, v in per_agent.items()},
        "hop_effects": hop_effects, "outcomes": outcomes,
        "map": {"control": {str(s): v for s, v in map_c.items() if v}, "treatment": {str(s): v for s, v in map_t.items() if v}},
        "log_verification": {"branches_checked": len(verified), "all_ok": all(verified), "kind": "hash chain"},
        "map_seed": seeds[0], "hop_levels": HOP_LABELS[:2],
        "rosters": {str(seed): [a["id"] for a in trt[seed]["agents"]] for seed in seeds},
    }


def recorded_agent(fork_id: str, agent: str, seed: int | None = None) -> dict:
    comp = manifest()["comparisons"][fork_id]
    ctl, trt = load_config(comp["control"]), load_config(comp["treatment"])
    seed = seed if seed is not None else sorted(set(ctl) & set(trt))[0]
    c, t = ctl[seed], trt[seed]
    # Each seed draws its own personas. A name from another seed means the manipulated agent of this seed.
    if agent not in {a["id"] for a in t["agents"]}:
        agent = _manipulated(comp, {seed: t})
    pick = lambda run: sorted(({"step": m["step"], "text": m["text"], "id": m["id"]} for m in run["messages"] if m["sender"] == agent),
                              key=lambda x: x["step"])
    cm, tm = pick(c), pick(t)
    first = next((a["step"] for a, b in zip(cm, tm) if a["text"] != b["text"]), None)
    rc = {r["step"]: r["projection"] for r in c["readings"] if r["agent"] == agent}
    rt = {r["step"]: r["projection"] for r in t["readings"] if r["agent"] == agent}
    steps = sorted(set(rc) | set(rt))
    return {"agent": agent, "replicate": seed, "first_divergence": first, "control": cm, "treatment": tm,
            "trace": [{"step": s, "control": rc.get(s), "treatment": rt.get(s)} for s in steps]}


def recorded_swarm(fork_id: str, step: int | None) -> dict:
    res = recorded_results(fork_id)
    roles = {a["id"]: a["role"] for a in res["agents"]}
    m = res["map"]["treatment"]
    per_step = {s: float(np.mean(list(v.values()))) for s, v in m.items() if v}
    use = str(step) if step is not None and str(step) in m else (sorted(m, key=int)[0] if m else None)
    agents = m.get(use, {}) if use else {}
    by_role: dict[str, list[float]] = {}
    for a, v in agents.items():
        by_role.setdefault(roles.get(a, "?"), []).append(v)
    return {"step": int(use) if use else None, "agents": agents, "role_means": {k: float(np.mean(v)) for k, v in by_role.items()},
            "per_step_mean": per_step}


def recorded_top_activations(limit: int = 12) -> list[dict]:
    """The recorded messages with the highest projection across every comparison, for the Concept screen."""
    rows = []
    seen = set()
    for comp_id, comp in manifest()["comparisons"].items():
        for cfg in (comp["treatment"], comp["control"]):
            if cfg in seen:
                continue
            seen.add(cfg)
            for seed, run in load_config(cfg).items():
                text = {m["id"]: m for m in run["messages"]}
                for r in run["readings"]:
                    m = text.get(r["message_id"])
                    if m:
                        rows.append({"activation": r["projection"], "text": m["text"], "agent": r["agent"], "step": r["step"],
                                     "config": cfg, "seed": seed})
    rows.sort(key=lambda x: -x["activation"])
    return rows[:limit]


def recorded_density() -> dict:
    vals = []
    seen = set()
    for comp in manifest()["comparisons"].values():
        for cfg in (comp["treatment"], comp["control"]):
            if cfg in seen:
                continue
            seen.add(cfg)
            for run in load_config(cfg).values():
                vals += [r["projection"] for r in run["readings"]]
    counts, edges = np.histogram(vals, bins=40)
    return {"n": len(vals), "counts": [int(c) for c in counts], "edges": [float(e) for e in edges]}
