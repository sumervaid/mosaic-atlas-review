"""Divergence front, hop effects, and outcome estimates from paired branches."""

from __future__ import annotations

import json
from pathlib import Path

import duckdb
import numpy as np

from mosaic.engine.log import verify
from mosaic.engine.topology import hop_distances

HOP_LABELS = ["0", "1", "2", "3", "4+"]
N_BOOT = 10_000


def bootstrap_ci(values, n_boot: int = N_BOOT, seed: int = 0) -> tuple[float, float, float]:
    """Mean with a 95% percentile interval, resampling replicates (or seeds) with replacement."""
    x = np.asarray(values, dtype=float)
    x = x[~np.isnan(x)]
    if x.size == 0:
        return (float("nan"), float("nan"), float("nan"))
    rng = np.random.default_rng(seed)
    means = x[rng.integers(0, x.size, size=(n_boot, x.size))].mean(axis=1)
    return float(x.mean()), float(np.percentile(means, 2.5)), float(np.percentile(means, 97.5))


def clean(v):
    return None if v is None or (isinstance(v, float) and (np.isnan(v) or np.isinf(v))) else v


def estimate(values, seed=0) -> dict:
    m, lo, hi = bootstrap_ci(values, seed=seed)
    return {"estimate": clean(m), "ci": [clean(lo), clean(hi)], "n": int(np.sum(~np.isnan(np.asarray(values, dtype=float))))}


def load_messages(branch: Path) -> dict[str, dict]:
    with (branch / "messages.jsonl").open(encoding="utf-8") as f:
        return {m["id"]: m for m in map(json.loads, f)}


def load_outcomes(branch: Path) -> list[dict]:
    p = branch / "outcomes.jsonl"
    if not p.exists():
        return []
    with p.open(encoding="utf-8") as f:
        return [json.loads(line) for line in f]


def divergence_times(control: dict[str, dict], treatment: dict[str, dict]) -> dict[str, int]:
    """First step at which an agent's generated tokens differ between two paired branches."""
    out: dict[str, int] = {}
    ids = sorted(set(control) | set(treatment), key=lambda k: (int(k[1:5]), k))
    for mid in ids:
        c, t = control.get(mid), treatment.get(mid)
        agent = (c or t)["sender"]
        if agent in out:
            continue
        ctok = c.get("tokens", c.get("text")) if c else None
        ttok = t.get("tokens", t.get("text")) if t else None
        if ctok != ttok:
            out[agent] = (c or t)["step"]
    return out


def readings_by(fork_dir: Path, branch: str, source: str, feature: int) -> dict[tuple[int, str], float]:
    p = fork_dir / branch / "readings.parquet"
    if not p.exists():
        return {}
    # One connection per query. The module-level default connection is not safe across API threads.
    with duckdb.connect() as con:
        rows = con.execute(
            f"select step, agent, avg(mean_act) from read_parquet('{p}') where source = ? and feature = ? group by 1, 2",
            [source, feature]).fetchall()
    return {(int(s), a): float(v) for s, a, v in rows}


def fork_results(fork_dir: str | Path, adj: dict[str, list[str]], agents: list[dict], steps: int,
                 interventions: list[dict], source: str = "sae", feature: int = 0, seed: int = 0,
                 extra_outcomes=None, labels: dict | None = None) -> dict:
    fork_dir = Path(fork_dir)
    reps = sorted({p.name.split("-")[0] for p in fork_dir.glob("r*-treatment")})
    targets = sorted({a for iv in interventions for a in iv["agents"]})
    dist = hop_distances(adj, targets)
    ids = [a["id"] for a in agents]
    bucket = {a: HOP_LABELS[min(dist.get(a, 4), 4)] for a in ids}
    step_axis = list(range(steps))

    tdivs: list[dict[str, int]] = []
    maps_c: dict[int, dict[str, list[float]]] = {s: {} for s in step_axis}
    maps_t: dict[int, dict[str, list[float]]] = {s: {} for s in step_axis}
    hop_vals: dict[str, dict[int, list[list[float]]]] = {h: {s: [] for s in step_axis} for h in HOP_LABELS}
    outcome_pairs: dict[str, list[tuple[float, float]]] = {}
    verified = []
    for r in reps:
        ctl, trt = fork_dir / f"{r}-control", fork_dir / f"{r}-treatment"
        mc, mt = load_messages(ctl), load_messages(trt)
        tdivs.append(divergence_times(mc, mt))
        rc = readings_by(fork_dir, f"{r}-control", source, feature)
        rt = readings_by(fork_dir, f"{r}-treatment", source, feature)
        per = {h: {s: [] for s in step_axis} for h in HOP_LABELS}
        for (s, a), v in rc.items():
            if s in maps_c:
                maps_c[s].setdefault(a, []).append(v)
        for (s, a), v in rt.items():
            if s in maps_t:
                maps_t[s].setdefault(a, []).append(v)
            if (s, a) in rc and s in maps_t:
                per[bucket.get(a, "4+")][s].append(v - rc[(s, a)])
        for h in HOP_LABELS:
            for s in step_axis:
                hop_vals[h][s].append(float(np.mean(per[h][s])) if per[h][s] else float("nan"))
        oc, ot = load_outcomes(ctl), load_outcomes(trt)
        names = {o["name"] for o in oc} | {o["name"] for o in ot}
        for n in names:
            vc = [o["value"] for o in oc if o["name"] == n]
            vt = [o["value"] for o in ot if o["name"] == n]
            outcome_pairs.setdefault(n, []).append((float(np.mean(vc)) if vc else float("nan"),
                                                    float(np.mean(vt)) if vt else float("nan")))
        for b in (ctl, trt):
            meta = json.loads((b / "branch.json").read_text())
            if (b / "log.jsonl").exists():
                verified.append(verify(b / "log.jsonl", meta["public_keys"], meta.get("start_head", "0" * 64))["ok"])

    front = []
    for s in step_axis:
        shares = [np.mean([a in td and td[a] <= s for a in ids]) for td in tdivs]
        front.append(float(np.mean(shares)) if shares else 0.0)
    noise = None
    ctl2 = fork_dir / "r000-control2"
    if ctl2.exists() and (fork_dir / "r000-control").exists():
        td = divergence_times(load_messages(fork_dir / "r000-control"), load_messages(ctl2))
        noise = [float(np.mean([a in td and td[a] <= s for a in ids])) for s in step_axis]

    agent_div = {}
    for a in ids:
        vals = [td[a] for td in tdivs if a in td]
        if vals:
            agent_div[a] = {"median": float(np.median(vals)), "iqr": [float(np.percentile(vals, 25)), float(np.percentile(vals, 75))],
                            "diverged_in": len(vals), "replicates": len(tdivs)}

    def agg(m):
        return {str(s): {a: float(np.mean(v)) for a, v in m[s].items()} for s in step_axis if m[s]}

    labels = labels or {"objection": "Objection rate", "deference": "Deference rate", "proof_accuracy": "Proof accuracy"}
    outcomes = []
    for n, pairs in sorted(outcome_pairs.items()):
        c = np.array([p[0] for p in pairs])
        t = np.array([p[1] for p in pairs])
        d = estimate(t - c, seed=seed)
        lo, hi = d["ci"]
        outcomes.append({"name": n, "label": labels.get(n, n), "control": clean(float(np.nanmean(c))) if c.size else None,
                         "treatment": clean(float(np.nanmean(t))) if t.size else None, "difference": d,
                         "excludes_zero": bool(lo is not None and hi is not None and (lo > 0 or hi < 0))})
    outcomes.append({"name": "said_represented_gap", "label": "Said versus represented gap", "control": None,
                     "treatment": None, "difference": None, "excludes_zero": False,
                     "not_measured": "Needs natural language autoencoder readouts, which are not configured."})

    hop_effects = []
    for h in HOP_LABELS:
        n = sum(1 for a in ids if bucket[a] == h)
        if not n:
            continue
        grid = np.array([hop_vals[h][s] for s in step_axis])  # [steps, replicates]
        overall_by_rep = [float(np.nanmean(col)) if np.any(~np.isnan(col)) else float("nan") for col in grid.T]
        row = {"hop": h, "agents": n, "overall": estimate(overall_by_rep, seed=seed),
               "by_step": {str(s): estimate(hop_vals[h][s], seed=seed) for s in step_axis
                           if np.sum(~np.isnan(hop_vals[h][s]))}}
        hop_effects.append(row)

    return {
        "replicates": len(reps), "steps": step_axis, "agents": agents, "targets": targets, "hop": bucket,
        "concept": {"source": source, "feature": feature},
        "front": {"treatment": front, "noise_floor": noise, "noise_floor_measured": noise is not None},
        "divergence": agent_div, "hop_effects": hop_effects, "outcomes": outcomes,
        "map": {"control": agg(maps_c), "treatment": agg(maps_t)},
        "log_verification": {"branches_checked": len(verified), "all_ok": bool(verified) and all(verified)} if verified else None,
    }


def agent_comparison(fork_dir: str | Path, agent: str, replicate: int = 0, source: str = "sae", feature: int = 0) -> dict:
    fork_dir = Path(fork_dir)
    r = f"r{replicate:03d}"
    mc, mt = load_messages(fork_dir / f"{r}-control"), load_messages(fork_dir / f"{r}-treatment")
    tdiv = divergence_times(mc, mt).get(agent)
    rc = readings_by(fork_dir, f"{r}-control", source, feature)
    rt = readings_by(fork_dir, f"{r}-treatment", source, feature)
    steps = sorted({s for s, a in list(rc) + list(rt) if a == agent})
    def pick(m):
        return [{"step": x["step"], "text": x["text"], "id": x["id"]} for x in m.values() if x["sender"] == agent]
    ctl, trt = pick(mc), pick(mt)
    return {"agent": agent, "replicate": replicate, "first_divergence": tdiv,
            "control": sorted(ctl, key=lambda x: x["step"]), "treatment": sorted(trt, key=lambda x: x["step"]),
            "trace": [{"step": s, "control": rc.get((s, agent)), "treatment": rt.get((s, agent))} for s in steps]}
