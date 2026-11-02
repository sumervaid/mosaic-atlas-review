"""Experiments, forks, loaded models, and the single background worker that runs them."""

from __future__ import annotations

import json
import os
import threading
import time
import traceback
import uuid
from pathlib import Path

import yaml

from mosaic.analysis.metrics import agent_comparison, fork_results
from mosaic.engine.fork import run_fork
from mosaic.engine.sim import Simulation, fresh_dir
from mosaic.engine.topology import build_agents, build_edges
from mosaic.schemas import ExperimentConfig, ForkSpec
from mosaic.serve.backend import Backend, backend_from_config

ROOT = Path(__file__).resolve().parents[2]


def git_sha() -> str | None:
    head = ROOT / ".git" / "HEAD"
    try:
        ref = head.read_text().strip()
        if ref.startswith("ref:"):
            return (ROOT / ".git" / ref.split(" ", 1)[1]).read_text().strip()
        return ref
    except OSError:
        return None


class Store:
    def __init__(self, home: str | Path | None = None):
        self.home = Path(home or os.environ.get("MOSAIC_HOME", ROOT / "runs"))
        self.home.mkdir(parents=True, exist_ok=True)
        self.backends: dict[str, Backend] = {}
        self.lock = threading.Lock()
        self.jobs: dict[str, dict] = {}
        self.configs_dir = ROOT / "configs"

    def backend(self, cfg: ExperimentConfig) -> Backend:
        key = f"{cfg.model.backend}:{cfg.model.model_id}:{cfg.layer}"
        with self.lock:
            if key not in self.backends:
                self.backends[key] = backend_from_config(cfg.model, cfg.layer)
            return self.backends[key]

    def loaded(self) -> list[Backend]:
        return list(self.backends.values())

    def exp_dir(self, exp_id: str) -> Path:
        return self.home / "experiments" / exp_id

    def create_experiment(self, cfg: ExperimentConfig) -> dict:
        if not Path(cfg.task_set).is_absolute():
            cfg.task_set = str(ROOT / cfg.task_set)
        d = self.exp_dir(cfg.id)
        d.mkdir(parents=True, exist_ok=True)
        (d / "config.yaml").write_text(yaml.safe_dump(cfg.model_dump(mode="json")), encoding="utf-8")
        rec = {"id": cfg.id, "created": time.time(), "git_sha": git_sha(), "description": cfg.description}
        (d / "record.json").write_text(json.dumps(rec), encoding="utf-8")
        return rec

    def config(self, exp_id: str) -> ExperimentConfig:
        return ExperimentConfig.model_validate(yaml.safe_load((self.exp_dir(exp_id) / "config.yaml").read_text()))

    def experiments(self) -> list[dict]:
        root = self.home / "experiments"
        if not root.exists():
            return []
        out = []
        for d in sorted(root.iterdir()):
            if (d / "record.json").exists():
                rec = json.loads((d / "record.json").read_text())
                cfg = self.config(d.name)
                out.append(dict(rec, model=cfg.model.model_id, backend=cfg.model.backend, agents=len(build_agents(cfg)),
                                steps=cfg.steps, snapshots=self.snapshots(d.name), forks=self.forks(d.name)))
        return out

    def experiment_detail(self, exp_id: str) -> dict:
        cfg = self.config(exp_id)
        agents = build_agents(cfg)
        return {"id": exp_id, "config": cfg.model_dump(mode="json"), "agents": [a.model_dump() for a in agents],
                "edges": build_edges(agents, cfg.topology, cfg.seed), "snapshots": self.snapshots(exp_id),
                "forks": self.forks(exp_id)}

    def snapshots(self, exp_id: str) -> list[int]:
        d = self.exp_dir(exp_id) / "snapshots"
        return sorted(int(p.stem.split("_")[1]) for p in d.glob("step_*.json")) if d.exists() else []

    def forks(self, exp_id: str) -> list[str]:
        d = self.exp_dir(exp_id) / "forks"
        return sorted(p.name for p in d.iterdir()) if d.exists() else []

    def latest_complete_fork(self, exp_id: str) -> str | None:
        """The most recently finished fork. Fork ids are random, so order comes from the completion file."""
        d = self.exp_dir(exp_id) / "forks"
        done = [p for p in d.iterdir() if (p / "fork.json").exists()] if d.exists() else []
        return max(done, key=lambda p: (p / "fork.json").stat().st_mtime).name if done else None

    def make_snapshot(self, exp_id: str, step: int) -> dict:
        cfg = self.config(exp_id)
        be = self.backend(cfg)
        d = self.exp_dir(exp_id) / "snapshots"
        d.mkdir(parents=True, exist_ok=True)
        path = d / f"step_{step}.json"
        if path.exists():
            return json.loads(path.read_text())
        sim = Simulation(cfg, be, fresh_dir(d / f"base_{step}"), "base")
        sim.run(until=step)
        return sim.save_snapshot(path)

    def job(self, job_id: str) -> dict | None:
        return self.jobs.get(job_id)

    def start_fork(self, spec: ForkSpec) -> str:
        fork_id = f"f{uuid.uuid4().hex[:8]}"
        job = {"fork_id": fork_id, "experiment_id": spec.experiment_id, "status": "queued", "branches_done": 0,
               "branches_total": spec.replicates * 2 + 1, "branch": None, "branch_step": 0, "steps": None, "error": None,
               "spec": spec.model_dump(mode="json")}
        self.jobs[fork_id] = job
        threading.Thread(target=self._run_fork, args=(fork_id, spec), daemon=True).start()
        return fork_id

    def _run_fork(self, fork_id: str, spec: ForkSpec) -> None:
        job = self.jobs[fork_id]
        try:
            job["status"] = "running"
            cfg = self.config(spec.experiment_id)
            job["steps"] = cfg.steps
            snap = self.make_snapshot(spec.experiment_id, spec.snapshot_step)
            be = self.backend(cfg)

            def progress(p):
                job.update(p)

            with self.lock:  # one model, one forward pass at a time
                run_fork(cfg, be, spec, self.exp_dir(spec.experiment_id) / "forks" / fork_id, snap, progress=progress)
            job["status"] = "complete"
        except Exception as exc:  # the UI shows this message
            job["status"] = "failed"
            job["error"] = f"{type(exc).__name__}: {exc}"
            traceback.print_exc()

    def fork_dir(self, fork_id: str) -> Path | None:
        root = self.home / "experiments"
        for d in root.glob(f"*/forks/{fork_id}") if root.exists() else []:
            return d
        return None

    def fork_results(self, fork_id: str, feature: int | None = None, source: str = "sae") -> dict | None:
        d = self.fork_dir(fork_id)
        if d is None or not (d / "fork.json").exists():
            return None
        exp_id = d.parent.parent.name
        cfg = self.config(exp_id)
        spec = json.loads((d / "spec.json").read_text())
        agents = build_agents(cfg)
        feat = feature
        if feat is None:
            feat = spec.get("watch_feature")
        if feat is None:
            feats = [iv["feature"] for iv in spec["interventions"] if iv.get("feature") is not None]
            feat = feats[0] if feats else (cfg.watch_features[0] if cfg.watch_features else 0)
        res = fork_results(d, build_edges(agents, cfg.topology, cfg.seed), [a.model_dump() for a in agents],
                           cfg.steps, spec["interventions"], source=source, feature=feat)
        res.update(fork_id=fork_id, experiment_id=exp_id, status="complete", recorded=False, model=cfg.model.model_id,
                   is_test_model=cfg.model.backend == "test", spec=spec)
        return res

    def fork_agent(self, fork_id: str, agent: str, replicate: int = 0, feature: int = 0, source: str = "sae") -> dict | None:
        d = self.fork_dir(fork_id)
        return agent_comparison(d, agent, replicate, source, feature) if d else None
