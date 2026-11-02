"""M3: results with bootstrap intervals, recorded pilot values match the pilot's own results, and the API contract."""

import json
import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from mosaic.analysis import metrics, recorded
from mosaic.api.app import create_app
from mosaic.compute import gcp

ROOT = Path(__file__).resolve().parent.parent
FEATURE = 3


@pytest.fixture(scope="module")
def client(tmp_path_factory):
    return TestClient(create_app(tmp_path_factory.mktemp("home")))


@pytest.fixture(scope="module")
def fork(client):
    cfg = (ROOT / "configs" / "test_32.yaml").read_text().replace("id: test-32", "id: m3") + "\n"
    assert client.post("/experiments", json={"yaml": cfg}).status_code == 200
    spec = {"experiment_id": "m3", "snapshot_step": 1, "replicates": 10, "watch_feature": FEATURE,
            "interventions": [{"agents": ["A001"], "layer": 2, "op": "clamp", "feature": FEATURE, "value": 40.0}]}
    r = client.post("/forks", json=spec)
    assert r.status_code == 200, r.text
    fid = r.json()["fork_id"]
    for _ in range(600):
        s = client.get(f"/forks/{fid}").json()
        if s["status"] in ("complete", "failed"):
            break
        time.sleep(0.5)
    assert s["status"] == "complete", s
    return fid


def test_bootstrap_interval_contains_the_mean():
    m, lo, hi = metrics.bootstrap_ci([1.0, 2.0, 3.0, 4.0, 5.0])
    assert m == 3.0 and lo < m < hi


def test_divergence_time_uses_first_difference():
    c = {"m0001-A": {"sender": "A", "step": 1, "tokens": [1]}, "m0002-A": {"sender": "A", "step": 2, "tokens": [2]}}
    t = {"m0001-A": {"sender": "A", "step": 1, "tokens": [1]}, "m0002-A": {"sender": "A", "step": 2, "tokens": [9]}}
    assert metrics.divergence_times(c, t) == {"A": 2}


def test_m3_acceptance_results(client, fork):
    res = client.get(f"/forks/{fork}/results").json()
    assert res["replicates"] == 10
    assert res["is_test_model"] is True
    assert len(res["front"]["treatment"]) == len(res["steps"])
    assert res["front"]["treatment"][-1] > 0, "the intervention reached no agent"
    assert res["front"]["noise_floor_measured"] and all(x == 0 for x in res["front"]["noise_floor"])
    assert res["log_verification"]["all_ok"]
    assert res["hop_effects"][0]["hop"] == "0"
    assert res["hop_effects"][0]["overall"]["ci"][0] is not None
    assert res["outcomes"]


def test_clamped_agent_reads_the_target_in_results(client, fork):
    res = client.get(f"/forks/{fork}/results?feature={FEATURE}").json()
    assert res["hop_effects"][0]["overall"]["estimate"] > 1


def test_agent_comparison(client, fork):
    r = client.get(f"/forks/{fork}/agents/A001").json()
    assert r["first_divergence"] is not None and r["control"] and r["trace"]


def test_websocket_reports_completion(client, fork):
    with client.websocket_connect(f"/forks/{fork}/progress") as ws:
        assert ws.receive_json()["status"] == "complete"


def test_contagion_replay_measures_an_edge(client, fork):
    g = client.get(f"/contagion/m3/graph?feature={FEATURE}").json()
    assert g["edges"] == []
    node = next(n for n in g["nodes"] if n["agent"] == "A001" and n["step"] >= 1)
    res = client.post("/contagion/m3/ablate", json={"fork_id": fork, "message_id": node["id"], "recipient": node["recipients"][0],
                                                    "feature": FEATURE, "replicates": 2})
    assert res.status_code == 200, res.text
    assert isinstance(res.json()["weight"], float)
    g2 = client.get(f"/contagion/m3/graph?feature={FEATURE}").json()
    assert len(g2["edges"]) == 1


def test_steer_chat_changes_output_only_when_steered(client):
    r = client.post("/steer/chat", json={"prompt": "hello", "vector_id": "test-vector", "strength": 300.0, "max_new_tokens": 16}).json()
    assert r["is_test_model"] and not r["identical"]


def test_concept_page_live(client):
    c = client.get("/concepts/test-tiny-gemma3/sae-random-256/3").json()
    assert c["neighbours"] and c["logits"]["positive"] and c["explanations"] == []
    t = client.post("/concepts/test-tiny-gemma3/sae-random-256/3/test", json={"text": "abc"}).json()
    assert len(t["tokens"]) == len(t["activations"])
    s = client.get("/concepts/search", params={"mode": "inference", "text": "hello team"}).json()
    assert s["tokens"]


def test_recorded_screens_read_real_runs(client):
    exps = client.get("/experiments").json()
    assert {e["id"] for e in exps["recorded"]} >= {"pilot-negative-lead", "scale-50-negative-lead"}
    c = client.get("/concepts/gemma-3-4b-it/pilot-directions/0").json()
    assert c["top_activations"] and c["density"]["n"] > 0 and c["logits"] is None
    sw = client.get("/concepts/gemma-3-4b-it/pilot-directions/0/swarm", params={"experiment": "scale-50-negative-lead", "step": 3}).json()
    assert len(sw["agents"]) >= 40
    assert client.post("/concepts/gemma-3-4b-it/pilot-directions/0/test", json={"text": "x"}).status_code == 409
    graph = client.get("/contagion/pilot-negative-lead/graph").json()
    assert graph["edges"] == [] and graph["nodes"] and "ablation" in graph["empty"]


# Values from the pilot's results.json, tag stage2-scale. The importer and analysis must reproduce them.
PILOT = {"pilot-negative-lead": (-0.51, -0.61, -0.42), "pilot-positive-lead": (0.29, 0.24, 0.33),
         "pilot-random-lead": (0.02, -0.01, 0.05), "pilot-prompted-lead": (-0.07, -0.12, -0.01)}


@pytest.mark.parametrize("cid,expected", list(PILOT.items()))
def test_recorded_affect_matches_pilot_results(cid, expected):
    res = recorded.recorded_results(cid)
    aff = next(o for o in res["outcomes"] if o["name"] == "affect")
    assert aff["difference"]["estimate"] == pytest.approx(expected[0], abs=0.006)
    assert aff["difference"]["ci"][0] == pytest.approx(expected[1], abs=0.03)
    assert aff["difference"]["ci"][1] == pytest.approx(expected[2], abs=0.03)


def test_recorded_decision_accuracy_matches_pilot_results():
    res = recorded.recorded_results("pilot-positive-lead")
    d = next(o for o in res["outcomes"] if o["name"] == "decision_accuracy")
    assert d["control"] == pytest.approx(1.0) and d["treatment"] == pytest.approx(0.12, abs=0.006)


def test_recorded_projection_matches_pilot_results():
    res = recorded.recorded_results("pilot-negative-lead")
    h1 = next(h for h in res["hop_effects"] if h["hop"] == "1")
    assert h1["overall"]["estimate"] == pytest.approx(12.4, abs=0.1)


def test_recorded_chains_verify():
    assert recorded.recorded_results("pilot-negative-lead")["log_verification"]["all_ok"]


def test_recorded_fifty_agent_effect():
    res = recorded.recorded_results("scale-50-negative-lead")
    aff = next(o for o in res["outcomes"] if o["name"] == "affect")
    assert aff["difference"]["estimate"] == pytest.approx(-0.98, abs=0.006)


# Google Cloud: the key handling and the plan, with no call to Google.
SECRET = "-----BEGIN PRIVATE KEY-----SHOULD-NEVER-APPEAR"


@pytest.fixture()
def key_setup(tmp_path, monkeypatch):
    monkeypatch.setattr(gcp, "STATE_DIR", tmp_path)
    monkeypatch.setattr(gcp, "SETTINGS", tmp_path / "gcp_settings.json")
    key = tmp_path / "key.json"
    key.write_text(json.dumps({"type": "service_account", "client_email": "a@b.iam.gserviceaccount.com", "project_id": "demo-proj",
                               "private_key": SECRET}))
    key.chmod(0o600)
    hf = tmp_path / "hf"
    hf.write_text("hf_test_token_should_not_appear")
    return key, hf


def test_check_key_returns_no_secret(key_setup):
    info = gcp.check_key(key_setup[0])
    assert SECRET not in json.dumps(info) and info["project_id"] == "demo-proj"


@pytest.mark.parametrize("content,msg", [("not json", "not valid JSON"), ('{"type":"user"}', "service account")])
def test_check_key_rejects_bad_files(tmp_path, content, msg):
    p = tmp_path / "k.json"
    p.write_text(content)
    with pytest.raises(gcp.KeyError_, match=msg):
        gcp.check_key(p)


def test_api_configure_and_dry_run_leak_nothing(tmp_path, key_setup):
    key, hf = key_setup
    client = TestClient(create_app(tmp_path / "h"))
    r = client.post("/compute/gcp/configure", json={"key_path": str(key), "hf_token_path": str(hf)})
    assert r.status_code == 200, r.text
    assert r.json()["settings"]["project"] == "demo-proj"
    up = client.post("/compute/gcp/up", json={"dry_run": True})
    assert up.status_code == 200 and up.json()["dry_run"]
    text = r.text + up.text
    assert SECRET not in text and "hf_test_token_should_not_appear" not in text
    joined = "\n".join(up.json()["commands"])
    assert "nvidia-l4" in joined and "activate-service-account" in joined and "g2-standard-12" in joined
    down = client.post("/compute/gcp/down", json={"dry_run": True}).json()
    assert "instances delete" in down["commands"][0]


def test_up_refuses_without_a_key(tmp_path, monkeypatch):
    monkeypatch.setattr(gcp, "STATE_DIR", tmp_path)
    monkeypatch.setattr(gcp, "SETTINGS", tmp_path / "gcp_settings.json")
    client = TestClient(create_app(tmp_path / "h"))
    assert client.post("/compute/gcp/up", json={"dry_run": True}).status_code == 422


def test_real_release_layout_loads(tmp_path, monkeypatch):
    """The Gemma Scope 2 file stores w_enc as [d_model, n_features]. Checked against the release header."""
    import torch
    from safetensors.torch import save_file

    from mosaic.interp.sae import JumpReLUSAE

    d, n = 8, 32
    save_file({"w_enc": torch.randn(d, n), "w_dec": torch.randn(n, d), "b_enc": torch.zeros(n), "b_dec": torch.zeros(d),
               "threshold": torch.zeros(n)}, tmp_path / "params.safetensors")
    monkeypatch.setattr("huggingface_hub.hf_hub_download", lambda repo, name: str(tmp_path / "params.safetensors"))
    sae = JumpReLUSAE.load("repo", "path")
    assert sae.w_enc.shape == (n, d) and sae.encode(torch.zeros(2, d)).shape == (2, n)


def test_concurrent_analysis_reads_do_not_fail(client, fork):
    from concurrent.futures import ThreadPoolExecutor

    with ThreadPoolExecutor(8) as ex:
        codes = list(ex.map(lambda _: client.get(f"/forks/{fork}/results").status_code, range(16)))
    assert codes == [200] * 16


def test_bad_references_are_refused_before_the_run(client):
    base = {"experiment_id": "m3", "snapshot_step": 1, "replicates": 1}
    bad_vec = {"agents": ["A001"], "layer": 2, "op": "add", "vector_id": "no-such-vector", "alpha": 1.0}
    bad_feat = {"agents": ["A001"], "layer": 2, "op": "ablate", "feature": 999999}
    assert "No vector" in client.post("/forks", json=dict(base, interventions=[bad_vec])).json()["detail"]
    assert "Feature indices" in client.post("/forks", json=dict(base, interventions=[bad_feat])).json()["detail"]


def test_latest_complete_fork_ignores_unfinished_forks(client, fork):
    store = client.app.state.store
    unfinished = store.exp_dir("m3") / "forks" / "zzzzzzzz"
    unfinished.mkdir()
    try:
        assert store.latest_complete_fork("m3") != "zzzzzzzz"
        assert client.get("/contagion/m3/graph").json()["fork_id"] != "zzzzzzzz"
    finally:
        unfinished.rmdir()


def test_recorded_agent_follows_each_seed_roster():
    res = recorded.recorded_results("pilot-negative-lead")
    seeds = sorted(int(k) for k in res["rosters"])
    assert len({tuple(res["rosters"][str(s)]) for s in seeds}) > 1, "the seeds share one roster"
    other = next(s for s in seeds if res["targets"][0] not in res["rosters"][str(s)])
    r = recorded.recorded_agent("pilot-negative-lead", res["targets"][0], other)
    assert r["control"] and r["agent"] in res["rosters"][str(other)]


def test_empty_key_path_has_a_plain_message():
    with pytest.raises(gcp.KeyError_, match="Point to a Google Cloud"):
        gcp.check_key("")


def test_vector_created_on_a_loaded_model_can_steer(client):
    r = client.post("/vectors", json={"vector_id": "made-here", "positive": ["awful day"], "negative": ["plain day"]})
    assert r.status_code == 200 and "made-here" in r.json()["vectors"]
    moved = client.post("/steer/chat", json={"prompt": "hello", "vector_id": "made-here", "strength": 300.0, "max_new_tokens": 16}).json()
    assert not moved["identical"]
    assert client.post("/vectors", json={"vector_id": "bad id", "positive": ["a"], "negative": ["b"]}).status_code == 422
