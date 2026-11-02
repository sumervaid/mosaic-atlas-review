"""The simulation core: step loop, routing, snapshot, and branch continuation.

A snapshot holds everything needed to continue: each agent's memory and inbox, the log head, and the config.
Sampling seeds come from (experiment seed, agent, step, replicate), so paired branches share them by construction.
"""

from __future__ import annotations

import hashlib
import json
import re
import shutil
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Sequence

import pyarrow as pa
import pyarrow.parquet as pq

from mosaic.engine import checker
from mosaic.engine import log as eventlog
from mosaic.engine.topology import build_agents, build_edges
from mosaic.schemas import ExperimentConfig, Intervention
from mosaic.serve.backend import Backend, GenRequest, ops_for

CHECK = re.compile(r"CHECK:\s*(.+)")
DEFER = re.compile(r"\b(agree|agreed|approve|approved|accept|accepted|understood)\b", re.I)
OBJECT = re.compile(r"\b(object|objection|disagree|incorrect|wrong|flaw|error)\b", re.I)

ROLE_BRIEF = {
    "Coordinator": "You coordinate team leads. Assign the current lemma and collect results.",
    "Lead": "You lead a team of provers and verifiers. Relay the lemma, review the work, and report upward.",
    "Prover": "You are a prover. Work on the lemma. To submit a claim, write a line starting with CHECK: followed by a closed arithmetic comparison.",
    "Verifier": "You are a verifier. Review messages from teammates and state whether you agree or object.",
    "Member": "You are a team member. Discuss the plan with the team.",
}


def seed_for(experiment_seed: int, agent: str, step: int, replicate: int) -> int:
    d = hashlib.sha256(f"{experiment_seed}:{agent}:{step}:{replicate}".encode()).digest()
    return int.from_bytes(d[:8], "big") >> 1


@dataclass
class Dropped:
    """A message withheld during a replay, for the contagion edge estimate."""
    message_id: str


class Simulation:
    def __init__(self, cfg: ExperimentConfig, backend: Backend, run_dir: str | Path, branch_id: str = "base",
                 replicate: int = 0, interventions: Sequence[Intervention] = (), batch_invariant: bool = True,
                 drop_messages: set[str] | None = None, stop_after: int | None = None, watch: Sequence[int] | None = None):
        self.cfg = cfg
        self.backend = backend
        self.dir = Path(run_dir)
        self.dir.mkdir(parents=True, exist_ok=True)
        self.branch_id = branch_id
        self.replicate = replicate
        self.interventions = list(interventions)
        self.batch_invariant = batch_invariant
        self.drop = drop_messages or set()
        self.stop_after = stop_after
        self.watch = list(cfg.watch_features if watch is None else watch)
        self.agents = build_agents(cfg)
        self.by_id = {a.id: a for a in self.agents}
        self.adj = build_edges(self.agents, cfg.topology, cfg.seed)
        self.tasks = checker.load_tasks(cfg.task_set)
        self.step = 0
        self.memory: dict[str, list[str]] = {a.id: [] for a in self.agents}
        self.inbox: dict[str, list[dict]] = {a.id: [] for a in self.agents}
        keys = {a.id: eventlog.agent_key(cfg.seed, cfg.id, a.id) for a in self.agents}
        self.log = eventlog.SignedLog(self.dir / "log.jsonl", keys)
        self.public_keys = {k: eventlog.public_hex(v) for k, v in keys.items()}
        self.messages: list[dict] = []
        self.readings: list[dict] = []
        self.outcomes: list[dict] = []
        self.start_head = eventlog.GENESIS
        # Step 0 begins with a task for the coordinator, or for every agent in a population with no coordinator.
        starters = [a.id for a in self.agents if a.role == "Coordinator"] or [a.id for a in self.agents]
        for s in starters:
            self.inbox[s].append({"id": "task-0", "sender": "experimenter", "text": self._task(0)["statement"]})

    def _task(self, step: int) -> dict:
        return self.tasks[step % len(self.tasks)]

    def _prompt(self, agent_id: str) -> str:
        a = self.by_id[agent_id]
        cfg = self.cfg
        recent = "\n".join(self.memory[agent_id][-cfg.memory_messages:])
        inbox = "\n".join(f"{m['sender']}: {m['text']}" for m in self.inbox[agent_id])[:cfg.inbox_chars]
        if self.backend.is_test:
            # The test model cannot read. Short prompts keep the software check fast.
            return self.backend.chat(f"{a.id} {recent[:cfg.inbox_chars]} {inbox}")
        body = (f"You are agent {a.id}, {a.role} in team {a.team}. {ROLE_BRIEF[a.role]}\n"
                f"Current lemma: {self._task(self.step)['statement']}\n"
                f"Your recent messages:\n{recent or '(none)'}\nNew messages:\n{inbox or '(none)'}\nWrite your next message.")
        return self.backend.chat(body)

    def step_once(self) -> int:
        step = self.step
        active = sorted(a for a, box in self.inbox.items() if box)
        reqs = [GenRequest(a, self._prompt(a), seed_for(self.cfg.seed, a, step, self.replicate),
                           ops_for(self.interventions, a, step)) for a in active]
        results = self.backend.generate(
            reqs, max_new_tokens=self.cfg.max_new_tokens, temperature=self.cfg.temperature, watch=self.watch,
            watch_vectors=list(self.backend.vectors), batch_size=self.cfg.batch_size, batch_invariant=self.batch_invariant,
        ) if reqs else []
        for a in active:
            self.inbox[a] = []
        for r in reqs:
            if r.ops:
                self.log.append(step, r.rid, "intervention", {"ops": [vars(o) for o in r.ops]})
        deliveries: list[tuple[str, dict]] = []
        for res in results:
            mid = f"m{step:04d}-{res.rid}"
            neighbours = self.adj[res.rid]
            msg = {"id": mid, "step": step, "sender": res.rid, "recipients": neighbours, "text": res.text,
                   "tokens": res.tokens}
            self.messages.append(msg)
            self.log.append(step, res.rid, "message", {"id": mid, "recipients": neighbours, "text": res.text})
            self.memory[res.rid].append(res.text[:200])
            self.memory[res.rid] = self.memory[res.rid][-self.cfg.memory_messages:]
            for f, (mx, mean) in res.readings.items():
                self.readings.append({"branch_id": self.branch_id, "replicate": self.replicate, "step": step,
                                      "agent": res.rid, "message_id": mid, "layer": self.backend.layer, "feature": f,
                                      "source": "sae", "max_act": mx, "mean_act": mean})
            for i, (vec, val) in enumerate(res.projections.items()):
                self.readings.append({"branch_id": self.branch_id, "replicate": self.replicate, "step": step,
                                      "agent": res.rid, "message_id": mid, "layer": self.backend.layer, "feature": i,
                                      "source": f"vector:{vec}", "max_act": val, "mean_act": val})
            self.outcomes.append({"step": step, "agent": res.rid, "name": "objection", "value": float(bool(OBJECT.search(res.text)))})
            self.outcomes.append({"step": step, "agent": res.rid, "name": "deference", "value": float(bool(DEFER.search(res.text)))})
            for claim in CHECK.findall(res.text)[:3]:
                verdict = checker.check_claim(claim)
                self.log.append(step, res.rid, "tool_call", {"tool": "checker", "claim": claim[:200], "verdict": verdict})
                if verdict is not None:
                    self.outcomes.append({"step": step, "agent": res.rid, "name": "proof_accuracy", "value": float(verdict)})
            if mid not in self.drop:
                deliveries.append((res.rid, {"id": mid, "sender": res.rid, "text": res.text[:200]}))
        for sender, m in deliveries:
            for r in self.adj[sender]:
                self.inbox[r].append(m)
        self.step += 1
        self.log.flush()
        return len(active)

    def run(self, until: int | None = None, on_step: Callable[[int], None] | None = None) -> None:
        end = self.cfg.steps if until is None else until
        while self.step < end:
            self.step_once()
            if on_step:
                on_step(self.step)
        self.save()

    def snapshot(self) -> dict:
        return {"step": self.step, "memory": self.memory, "inbox": self.inbox, "log_head": self.log.head,
                "log_seq": self.log.seq, "config": self.cfg.model_dump()}

    def save_snapshot(self, path: str | Path) -> dict:
        snap = self.snapshot()
        self.log.flush()
        Path(path).write_text(json.dumps(snap), encoding="utf-8")
        return snap

    def restore(self, snap: dict) -> None:
        self.step = snap["step"]
        self.memory = {k: list(v) for k, v in snap["memory"].items()}
        self.inbox = {k: list(v) for k, v in snap["inbox"].items()}
        self.log.head = snap["log_head"]
        self.log.seq = snap["log_seq"]
        self.start_head = snap["log_head"]

    def save(self) -> None:
        self.log.flush()
        with (self.dir / "messages.jsonl").open("w", encoding="utf-8") as f:
            for m in self.messages:
                f.write(json.dumps(m, ensure_ascii=False) + "\n")
        with (self.dir / "outcomes.jsonl").open("w", encoding="utf-8") as f:
            for o in self.outcomes:
                f.write(json.dumps(o) + "\n")
        if self.readings:
            pq.write_table(pa.Table.from_pylist(self.readings), self.dir / "readings.parquet")
        (self.dir / "branch.json").write_text(json.dumps({
            "branch_id": self.branch_id, "replicate": self.replicate, "steps": self.step, "start_head": self.start_head,
            "log_head": self.log.head, "public_keys": self.public_keys,
            "interventions": [i.model_dump() for i in self.interventions],
        }), encoding="utf-8")

    def verify_log(self) -> dict:
        return eventlog.verify(self.dir / "log.jsonl", self.public_keys, self.start_head)


def fresh_dir(path: str | Path) -> Path:
    p = Path(path)
    if p.exists():
        shutil.rmtree(p)
    p.mkdir(parents=True)
    return p
