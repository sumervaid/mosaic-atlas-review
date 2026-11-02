"""Continue paired control and treatment branches from one saved state."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Callable

from mosaic.engine.sim import Simulation, fresh_dir
from mosaic.schemas import ExperimentConfig, ForkSpec
from mosaic.serve.backend import Backend


def run_fork(cfg: ExperimentConfig, backend: Backend, spec: ForkSpec, fork_dir: str | Path, snapshot: dict,
             progress: Callable[[dict], None] | None = None, stop_flag: Callable[[], bool] | None = None) -> dict:
    """Run every replicate pair, then one extra control for replicate 0 as the noise floor."""
    fork_dir = fresh_dir(fork_dir)
    watch = sorted(set(cfg.watch_features) | ({spec.watch_feature} if spec.watch_feature is not None else set())
                   | {iv.feature for iv in spec.interventions if iv.feature is not None})
    (fork_dir / "spec.json").write_text(spec.model_dump_json(), encoding="utf-8")
    branches = []
    plan = []
    for r in range(spec.replicates):
        plan.append((f"r{r:03d}-control", r, []))
        plan.append((f"r{r:03d}-treatment", r, spec.interventions))
    plan.append(("r000-control2", 0, []))
    total = len(plan)
    for done, (name, r, ivs) in enumerate(plan):
        if stop_flag and stop_flag():
            break
        seed_rep = r if spec.shared_seeds else (r * 2 + (1 if ivs else 0))
        sim = Simulation(cfg, backend, fork_dir / name, branch_id=name, replicate=seed_rep, interventions=ivs,
                         batch_invariant=spec.batch_invariant, watch=watch)
        sim.restore(snapshot)
        sim.run(on_step=(lambda s, n=name, d=done: progress({"branch": n, "branch_step": s, "steps": cfg.steps,
                                                            "branches_done": d, "branches_total": total})
                         ) if progress else None)
        branches.append(name)
        if progress:
            progress({"branch": name, "branch_step": cfg.steps, "steps": cfg.steps, "branches_done": done + 1,
                      "branches_total": total})
    summary = {"branches": branches, "replicates": spec.replicates}
    (fork_dir / "fork.json").write_text(json.dumps(summary), encoding="utf-8")
    return summary
