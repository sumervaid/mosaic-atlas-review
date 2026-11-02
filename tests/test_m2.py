"""M2: a 32-agent experiment completes 500 steps, the log detects edits, and paired controls are token-identical."""

import json
from pathlib import Path

import pytest

from mosaic.engine import checker
from mosaic.engine import log as eventlog
from mosaic.engine.fork import run_fork
from mosaic.engine.sim import Simulation
from mosaic.engine.topology import build_agents, build_edges, hop_distances
from mosaic.schemas import ExperimentConfig, ForkSpec, Intervention, Population, load_config
from mosaic.serve.backend import Backend

ROOT = Path(__file__).resolve().parent.parent


@pytest.fixture(scope="module")
def be():
    return Backend.test()


@pytest.fixture()
def cfg():
    c = load_config(ROOT / "configs" / "test_32.yaml")
    c.task_set = str(ROOT / c.task_set)
    return c


def tokens(sim):
    return [(m["id"], m["tokens"]) for m in sim.messages]


def test_population_of_32(cfg):
    assert len(build_agents(cfg)) == 32


def test_256_population():
    c = load_config(ROOT / "configs" / "test_256.yaml")
    agents = build_agents(c)
    assert len(agents) == 256
    roles = [a.role for a in agents]
    assert roles.count("Coordinator") == 1 and roles.count("Lead") == 15
    assert roles.count("Prover") == 150 and roles.count("Verifier") == 90


@pytest.mark.parametrize("kind", ["hierarchy", "hub", "ring", "small_world", "full"])
def test_topologies_connect_everyone(kind):
    cfg = ExperimentConfig(id="x", population=Population(teams=2, provers_per_team=3, verifiers_per_team=2), topology=kind)
    agents = build_agents(cfg)
    dist = hop_distances(build_edges(agents, kind), [agents[0].id])
    assert len(dist) == len(agents)


def test_control_branches_are_token_identical(be, cfg, tmp_path):
    cfg.steps = 12
    a = Simulation(cfg, be, tmp_path / "a", "a")
    b = Simulation(cfg, be, tmp_path / "b", "b")
    a.run()
    b.run()
    assert tokens(a) == tokens(b)
    assert a.log.head == b.log.head


def test_control_identical_after_fork_from_snapshot(be, cfg, tmp_path):
    cfg.steps = 10
    base = Simulation(cfg, be, tmp_path / "base", "base")
    base.run(until=4)
    snap = json.loads(json.dumps(base.snapshot()))
    straight = Simulation(cfg, be, tmp_path / "straight", "s")
    straight.run()
    resumed = Simulation(cfg, be, tmp_path / "resumed", "r")
    resumed.restore(snap)
    resumed.run()
    later = [t for t in tokens(straight) if int(t[0][1:5]) >= 4]
    assert later == tokens(resumed)
    assert resumed.log.head == straight.log.head


def test_treatment_diverges_only_from_the_intervened_agent(be, cfg, tmp_path):
    cfg.steps = 6
    agents = build_agents(cfg)
    target = agents[1].id
    iv = Intervention(agents=[target], layer=2, op="add", vector_id="test-vector", alpha=200.0, window=(0, None))
    ctl = Simulation(cfg, be, tmp_path / "c", "c")
    trt = Simulation(cfg, be, tmp_path / "t", "t", interventions=[iv])
    ctl.run()
    trt.run()
    c = {m["id"]: m["tokens"] for m in ctl.messages}
    t = {m["id"]: m["tokens"] for m in trt.messages}
    first = sorted(k for k in c if k in t and c[k] != t[k])
    assert first, "the intervention changed nothing"
    assert first[0].endswith(target)
    # Everyone beyond one hop stays identical at the first step the target speaks.
    step0 = int(first[0][1:5])
    assert all(k.endswith(target) for k in first if int(k[1:5]) == step0)


def test_log_verifies_and_detects_edits(be, cfg, tmp_path):
    cfg.steps = 4
    sim = Simulation(cfg, be, tmp_path / "x", "x")
    sim.run()
    assert sim.verify_log()["ok"]
    path = tmp_path / "x" / "log.jsonl"
    lines = path.read_text().splitlines()
    for idx in (0, len(lines) // 2, len(lines) - 1):
        tampered = list(lines)
        entry = json.loads(tampered[idx])
        entry["payload"]["text"] = "edited"
        tampered[idx] = json.dumps(entry)
        path.write_text("\n".join(tampered) + "\n")
        result = sim.verify_log()
        assert not result["ok"] and result["first_bad_line"] == idx + 1
    path.write_text("\n".join(lines) + "\n")
    assert sim.verify_log()["ok"]


def test_forged_signature_is_detected(be, cfg, tmp_path):
    cfg.steps = 2
    sim = Simulation(cfg, be, tmp_path / "x", "x")
    sim.run()
    path = tmp_path / "x" / "log.jsonl"
    lines = path.read_text().splitlines()
    entry = json.loads(lines[0])
    other = eventlog.agent_key(cfg.seed, cfg.id, "A999")
    entry["signature"] = other.sign(bytes.fromhex(entry["hash"])).hex()
    lines[0] = json.dumps(entry)
    path.write_text("\n".join(lines) + "\n")
    assert sim.verify_log()["reason"] == "signature"


def test_fork_runs_pairs_with_noise_floor(be, cfg, tmp_path):
    cfg.steps = 3
    base = Simulation(cfg, be, tmp_path / "b", "b")
    base.run(until=1)
    spec = ForkSpec(experiment_id=cfg.id, snapshot_step=1, replicates=2,
                    interventions=[Intervention(agents=["A000"], layer=2, op="clamp", feature=1, value=4.0)])
    events = []
    summary = run_fork(cfg, be, spec, tmp_path / "f", base.snapshot(), progress=events.append)
    assert summary["branches"] == ["r000-control", "r000-treatment", "r001-control", "r001-treatment", "r000-control2"]
    assert events[-1]["branches_done"] == 5


@pytest.mark.parametrize("claim,expected", [("3**2 + 4**2 == 25", True), ("1 + 1 == 3", False), ("import os", None),
                                            ("__import__('os')", None), ("2**99999 > 1", None), ("1/0 == 1", None)])
def test_checker(claim, expected):
    assert checker.check_claim(claim) == expected


@pytest.mark.slow
def test_m2_acceptance_32_agents_500_steps(be, cfg, tmp_path):
    cfg.steps = 500
    cfg.max_new_tokens = 2
    cfg.inbox_chars = 16
    a = Simulation(cfg, be, tmp_path / "a", "a")
    b = Simulation(cfg, be, tmp_path / "b", "b")
    a.run()
    b.run()
    assert a.step == 500
    assert tokens(a) == tokens(b)
    assert a.verify_log()["ok"]
