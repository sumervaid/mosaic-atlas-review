"""The MOSAIC Atlas API. Every response comes from a real run or a recorded run, or says that no data exists."""

from __future__ import annotations

import asyncio
import json
import re
import threading
from dataclasses import asdict
from pathlib import Path

import duckdb
import numpy as np
import torch
import yaml
from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from mosaic.analysis import recorded
from mosaic.api.store import Store
from mosaic.compute import gcp
from mosaic.engine.sim import Simulation
from mosaic.engine.topology import build_agents
from mosaic.schemas import ExperimentConfig, ForkSpec, load_config
from mosaic.serve.backend import GenRequest, Op

ROOT = Path(__file__).resolve().parents[2]
TEST_MODEL = "test-tiny-gemma3"
RECORDED_MODEL = "gemma-3-4b-it"
RECORDED_SOURCE = "pilot-directions"
NEEDS_MODEL = "This needs a loaded model. Start a live backend from the Setup screen. The recorded pilot runs hold no model weights."


class CreateExperiment(BaseModel):
    template: str | None = None
    yaml: str | None = None


class SnapshotRequest(BaseModel):
    step: int


class TextRequest(BaseModel):
    text: str


class SteerRequest(BaseModel):
    prompt: str
    feature: int | None = None
    vector_id: str | None = None
    strength: float = 1.0
    temperature: float = 0.8
    max_new_tokens: int = 48
    seed: int = 0
    model: str = TEST_MODEL


class VectorRequest(BaseModel):
    vector_id: str
    positive: list[str]
    negative: list[str]
    model: str | None = None


class AblateRequest(BaseModel):
    fork_id: str
    message_id: str
    recipient: str
    feature: int
    replicates: int = 1


class GcpSettings(BaseModel):
    key_path: str | None = None
    project: str | None = None
    zone: str | None = None
    instance: str | None = None
    profile: str | None = None
    hf_token_path: str | None = None


class GcpAction(BaseModel):
    dry_run: bool = True


def create_app(home: str | Path | None = None) -> FastAPI:
    app = FastAPI(title="MOSAIC Atlas", version="0.1.1")
    app.add_middleware(CORSMiddleware, allow_origin_regex=r"http://(localhost|127\.0\.0\.1)(:\d+)?", allow_methods=["*"],
                       allow_headers=["*"])
    store = Store(home)
    app.state.store = store
    contagion_lock = threading.Lock()

    def live_backend(model: str | None = None):
        loaded = store.loaded()
        for be in loaded:
            if model is None or be.name == model or (be.is_test and model == TEST_MODEL):
                return be
        if model in (None, TEST_MODEL):
            cfg = load_config(ROOT / "configs" / "test_32.yaml")
            return store.backend(cfg)
        raise HTTPException(409, NEEDS_MODEL)

    @app.get("/health")
    def health():
        return {"ok": True, "gpu": torch.cuda.is_available(), "gpu_count": torch.cuda.device_count(),
                "loaded_models": [b.name for b in store.loaded()]}

    @app.get("/models")
    def models():
        man = recorded.manifest()
        out = [{"id": TEST_MODEL, "kind": "test", "available": True, "live": True,
                "note": "Random weights on the CPU. Verifies the software. Its text and its findings have no meaning.",
                "sources": [{"id": "sae-random-256", "kind": "sae", "layer": 2, "n_features": 256, "note": "Random dictionary"},
                            {"id": "vector", "kind": "vector", "layer": 2, "n_features": 1}]}]
        if man["comparisons"]:
            out.append({"id": RECORDED_MODEL, "kind": "recorded", "available": True, "live": False,
                        "note": "Recorded pilot runs on Gemma 3 4B. Read only, with no model loaded.",
                        "sources": [{"id": RECORDED_SOURCE, "kind": "direction", "layer": man["layer"], "n_features": 1}]})
        for name, repo, source, layer, prof in (
                ("gemma-3-4b-it", "google/gemma-3-4b-it", "gemma-scope-2/resid_post_all/layer_14_width_16k_l0_small", 14, "4b"),
                ("gemma-3-12b-it", "google/gemma-3-12b-it", "gemma-scope-2/resid_post_all/layer_32_width_16k_l0_small", 32, "12b")):
            is_loaded = any(b.name == name and not b.is_test for b in store.loaded())
            out.append({"id": f"{name}-live", "name": name, "kind": "huggingface", "available": is_loaded, "live": True, "repo": repo,
                        "profile": prof, "note": "Needs a GPU and Hugging Face access. Set up from the Setup screen.",
                        "sources": [{"id": source, "kind": "sae", "layer": layer, "n_features": 16384}]})
        return out

    @app.get("/templates")
    def templates():
        out = []
        for p in sorted((ROOT / "configs").glob("*.yaml")):
            cfg = load_config(p)
            out.append({"name": p.stem, "id": cfg.id, "description": cfg.description, "backend": cfg.model.backend,
                        "agents": len(build_agents(cfg)), "steps": cfg.steps, "yaml": p.read_text()})
        return out

    @app.get("/experiments")
    def experiments():
        man = recorded.manifest()
        rec = [{"id": k, "recorded": True, "description": v["description"], "model": man["model"], "fork_id": k,
                "seeds": v["seeds"]} for k, v in man["comparisons"].items()]
        return {"recorded": rec, "live": store.experiments()}

    @app.post("/experiments")
    def create_experiment(body: CreateExperiment):
        if body.template:
            path = ROOT / "configs" / f"{Path(body.template).name}.yaml"
            if not path.exists():
                raise HTTPException(404, f"No template named {body.template}.")
            cfg = load_config(path)
        elif body.yaml:
            try:
                cfg = ExperimentConfig.model_validate(yaml.safe_load(body.yaml))
            except Exception as exc:
                raise HTTPException(422, f"The config did not validate: {exc}") from exc
        else:
            raise HTTPException(422, "Send a template name or a YAML config.")
        if not re.fullmatch(r"[A-Za-z0-9_-]+", cfg.id):
            raise HTTPException(422, "Experiment ids use letters, numbers, dashes, and underscores.")
        return store.create_experiment(cfg)

    @app.get("/experiments/{exp_id}")
    def experiment(exp_id: str):
        if exp_id in recorded.manifest()["comparisons"]:
            res = recorded.recorded_results(exp_id)
            ids = [a["id"] for a in res["agents"]]
            return {"id": exp_id, "recorded": True, "agents": res["agents"], "description": res["description"],
                    "edges": {a: [b for b in ids if b != a] for a in ids}, "forks": [exp_id], "snapshots": [0]}
        if not (store.exp_dir(exp_id) / "config.yaml").exists():
            raise HTTPException(404, f"No experiment named {exp_id}.")
        return store.experiment_detail(exp_id)

    @app.post("/experiments/{exp_id}/snapshots")
    def snapshot(exp_id: str, body: SnapshotRequest):
        if not (store.exp_dir(exp_id) / "config.yaml").exists():
            raise HTTPException(404, f"No experiment named {exp_id}.")
        snap = store.make_snapshot(exp_id, body.step)
        return {"step": snap["step"], "log_head": snap["log_head"]}

    @app.post("/forks")
    def fork(spec: ForkSpec):
        if not (store.exp_dir(spec.experiment_id) / "config.yaml").exists():
            raise HTTPException(404, f"No experiment named {spec.experiment_id}.")
        cfg = store.config(spec.experiment_id)
        known = {a.id for a in build_agents(cfg)}
        for iv in spec.interventions:
            unknown = set(iv.agents) - known
            if unknown:
                raise HTTPException(422, f"Unknown agents: {sorted(unknown)[:5]}.")
            if iv.layer != cfg.layer:
                raise HTTPException(422, f"This experiment's model runs interventions at layer {cfg.layer}.")
            if iv.op in ("clamp", "ablate") and iv.feature is None:
                raise HTTPException(422, "Clamp and ablate need a feature index.")
            if iv.op == "clamp" and iv.value is None:
                raise HTTPException(422, "Clamp needs a target value.")
            if iv.op == "add" and (iv.vector_id is None or iv.alpha is None):
                raise HTTPException(422, "Add needs a vector and a coefficient.")
        # Catch a bad reference now, not partway through a long run.
        be = store.backend(cfg)
        for iv in spec.interventions:
            if iv.op == "add" and iv.vector_id not in be.vectors:
                raise HTTPException(422, f"No vector named {iv.vector_id}. Available: {sorted(be.vectors)}.")
            if iv.op in ("clamp", "ablate"):
                if be.sae is None:
                    raise HTTPException(422, "This model has no sparse autoencoder loaded.")
                if not 0 <= iv.feature < be.sae.n_features:
                    raise HTTPException(422, f"Feature indices run from 0 to {be.sae.n_features - 1}.")
        return {"fork_id": store.start_fork(spec)}

    @app.get("/forks/{fork_id}")
    def fork_status(fork_id: str):
        if fork_id in recorded.manifest()["comparisons"]:
            return {"fork_id": fork_id, "status": "complete", "recorded": True}
        job = store.job(fork_id)
        if job:
            return job
        if store.fork_dir(fork_id):
            return {"fork_id": fork_id, "status": "complete"}
        raise HTTPException(404, f"No fork named {fork_id}.")

    @app.websocket("/forks/{fork_id}/progress")
    async def progress(ws: WebSocket, fork_id: str):
        await ws.accept()
        try:
            while True:
                job = store.job(fork_id)
                if job is None:
                    await ws.send_json({"fork_id": fork_id, "status": "complete" if store.fork_dir(fork_id) else "unknown"})
                    break
                await ws.send_json({k: job.get(k) for k in ("fork_id", "status", "branch", "branch_step", "steps", "branches_done",
                                                            "branches_total", "error")})
                if job["status"] in ("complete", "failed"):
                    break
                await asyncio.sleep(0.25)
        except WebSocketDisconnect:
            return
        await ws.close()

    @app.get("/forks/{fork_id}/results")
    def results(fork_id: str, feature: int | None = None, source: str = "sae"):
        if fork_id in recorded.manifest()["comparisons"]:
            return recorded.recorded_results(fork_id)
        res = store.fork_results(fork_id, feature, source)
        if res is None:
            raise HTTPException(404, "No results yet for this fork.")
        return res

    @app.get("/forks/{fork_id}/agents/{agent}")
    def fork_agent(fork_id: str, agent: str, replicate: int | None = None, feature: int | None = None, source: str = "sae"):
        if fork_id in recorded.manifest()["comparisons"]:
            return recorded.recorded_agent(fork_id, agent, replicate)
        d = store.fork_dir(fork_id)
        if not d:
            raise HTTPException(404, f"No fork named {fork_id}.")
        feat = feature
        if feat is None:
            res = store.fork_results(fork_id, None, source)
            feat = res["concept"]["feature"] if res else 0
        return store.fork_agent(fork_id, agent, replicate or 0, feat, source)

    # Concept pages.
    def recorded_concept():
        man = recorded.manifest()
        return {"model": RECORDED_MODEL, "source": RECORDED_SOURCE, "index": 0, "label": man["concept"]["label"], "layer": man["layer"],
                "n_features": 1, "live": False,
                "explanations": [{"text": man["concept"]["method"], "method": "Constructed by contrast", "score": None}],
                "neighbours": None, "neighbours_note": "A single constructed direction has no dictionary neighbours.",
                "logits": None, "logits_note": NEEDS_MODEL, "density": recorded.recorded_density(),
                "top_activations": recorded.recorded_top_activations(), "dropped_dimensions": man["dropped_dimensions"]}

    def live_concept(model, source, index):
        be = live_backend(model)
        if source == "vector":
            names = list(be.vectors)
            if not 0 <= index < len(names):
                raise HTTPException(404, "No vector at that index.")
            vec = be.vectors[names[index]]
            label = names[index]
            neigh = None
        else:
            if be.sae is None:
                raise HTTPException(409, "This model has no sparse autoencoder loaded.")
            if not 0 <= index < be.sae.n_features:
                raise HTTPException(404, f"Feature indices run from 0 to {be.sae.n_features - 1}.")
            vec = be.sae.w_dec[index]
            label = None
            sims = torch.nn.functional.cosine_similarity(be.sae.w_dec, vec[None], dim=-1)
            sims[index] = -2
            top = torch.topk(sims, 8)
            neigh = [{"index": int(i), "cosine": float(v)} for v, i in zip(top.values, top.indices)]
        head = be.model.get_output_embeddings().weight.detach().float().to(vec.device)
        logit = head @ vec
        def toks(tk):
            return [{"token": be.tok.decode([int(i)]), "value": float(v)} for v, i in zip(tk.values, tk.indices)]
        pos, neg = torch.topk(logit, 10), torch.topk(-logit, 10)
        neg_rows = [{"token": be.tok.decode([int(i)]), "value": -float(v)} for v, i in zip(neg.values, neg.indices)]
        rows = []
        for exp in store.experiments():
            for fid in exp["forks"]:
                d = store.fork_dir(fid)
                for pq_path in list(d.glob("*/readings.parquet"))[:8] if d else []:
                    src = "sae" if source != "vector" else f"vector:{label}"
                    feat = index if source != "vector" else 0
                    q = (f"select step, agent, message_id, max_act from read_parquet('{pq_path}') where source = ? and feature = ? "
                         "order by max_act desc limit 5")
                    msgs = {}
                    mp = pq_path.parent / "messages.jsonl"
                    if mp.exists():
                        msgs = {m["id"]: m["text"] for m in map(json.loads, mp.open(encoding="utf-8"))}
                    with duckdb.connect() as con:
                        found = con.execute(q, [src, feat]).fetchall()
                    for s, a, mid, mx in found:
                        rows.append({"activation": float(mx), "text": msgs.get(mid, ""), "agent": a, "step": int(s), "config": exp["id"]})
        rows.sort(key=lambda r: -r["activation"])
        # Paired branches often hold the identical message, so show each message once.
        seen, unique = set(), []
        for row in rows:
            key = (row["agent"], row["step"], row["text"])
            if key not in seen:
                seen.add(key)
                unique.append(row)
        rows = unique
        return {"model": model, "source": source, "index": index, "label": label, "layer": be.layer,
                "n_features": be.sae.n_features if be.sae is not None else len(be.vectors), "live": True, "is_test_model": be.is_test,
                "explanations": [], "explanations_note": "No explanation has been generated for this feature.",
                "neighbours": neigh, "logits": {"positive": toks(pos), "negative": neg_rows}, "density": None,
                "density_note": "Density needs a reference corpus, which this backend has not computed.",
                "top_activations": rows[:12]}

    @app.get("/concepts/search")
    def concept_search(q: str = "", mode: str = "explanations", text: str | None = None, model: str | None = None):
        if mode == "inference":
            if not text:
                raise HTTPException(422, "Search via inference needs text.")
            be = live_backend(model)
            if be.sae is None:
                raise HTTPException(409, "This model has no sparse autoencoder loaded.")
            enc = be.tok(text, add_special_tokens=False)["input_ids"]
            return {"mode": mode, "model": be.name, "is_test_model": be.is_test, "tokens": [be.tok.decode([t]) for t in enc],
                    "results": [dict(r, source="sae-random-256" if be.is_test else be.sae.source) for r in be.active_features(text)]}
        man = recorded.manifest()
        out = []
        if man["comparisons"]:
            hay = f"{man['concept']['label']} {man['concept']['method']}".lower()
            if q.lower() in hay:
                out.append({"model": RECORDED_MODEL, "source": RECORDED_SOURCE, "index": 0, "label": man["concept"]["label"],
                            "explanation": man["concept"]["method"]})
        return {"mode": mode, "results": out,
                "note": "Only named concepts are searchable. SAE features become searchable once explanations exist for them."}

    @app.get("/concepts/{model}/{source:path}/{index}/swarm")
    def concept_swarm(model: str, source: str, index: int, experiment: str, step: int | None = None):
        if experiment in recorded.manifest()["comparisons"]:
            return recorded.recorded_swarm(experiment, step)
        latest = store.latest_complete_fork(experiment)
        if not latest:
            return {"step": None, "agents": {}, "role_means": {}, "per_step_mean": {}, "empty": "This experiment has no finished fork yet."}
        res = store.fork_results(latest, index if source != "vector" else 0, "sae" if source != "vector" else "vector:test-vector")
        if res is None:
            return {"step": None, "agents": {}, "role_means": {}, "per_step_mean": {}, "empty": "The latest fork has not finished."}
        m = res["map"]["control"]
        roles = {a["id"]: a["role"] for a in res["agents"]}
        per = {s: float(np.mean(list(v.values()))) for s, v in m.items() if v}
        use = str(step) if step is not None and str(step) in m else (sorted(m, key=int)[0] if m else None)
        agents = m.get(use, {}) if use else {}
        by: dict[str, list[float]] = {}
        for a, v in agents.items():
            by.setdefault(roles.get(a, "?"), []).append(v)
        return {"step": int(use) if use else None, "agents": agents, "role_means": {k: float(np.mean(v)) for k, v in by.items()},
                "per_step_mean": per}

    @app.post("/concepts/{model}/{source:path}/{index}/test")
    def concept_test(model: str, source: str, index: int, body: TextRequest):
        if model == RECORDED_MODEL and source == RECORDED_SOURCE:
            raise HTTPException(409, NEEDS_MODEL)
        be = live_backend(model)
        if source == "vector":
            return be.token_activations(body.text, vector_id=list(be.vectors)[index])
        return be.token_activations(body.text, feature=index)

    @app.get("/concepts/{model}/{source:path}/{index}")
    def concept(model: str, source: str, index: int):
        if model == RECORDED_MODEL and source == RECORDED_SOURCE:
            if index != 0:
                raise HTTPException(404, "The pilot recorded one direction.")
            return recorded_concept()
        return live_concept(model, source, index)

    @app.post("/steer/chat")
    def steer_chat(body: SteerRequest):
        be = live_backend(body.model)
        prompt = be.chat(body.prompt)
        if body.vector_id:
            if body.vector_id not in be.vectors:
                raise HTTPException(404, f"No vector named {body.vector_id}.")
            op = Op("add", vector_id=body.vector_id, alpha=body.strength)
        elif body.feature is not None:
            if be.sae is None or not 0 <= body.feature < be.sae.n_features:
                raise HTTPException(404, "No such feature.")
            op = Op("clamp", feature=body.feature, value=body.strength)
        else:
            raise HTTPException(422, "Choose a feature or a vector to steer.")
        args = dict(max_new_tokens=body.max_new_tokens, temperature=body.temperature)
        plain = be.generate([GenRequest("default", prompt, body.seed)], **args)[0]
        moved = be.generate([GenRequest("steered", prompt, body.seed, ops=[op])], **args)[0]
        return {"default": plain.text, "steered": moved.text, "model": be.name, "is_test_model": be.is_test, "seed": body.seed,
                "identical": plain.tokens == moved.tokens}

    @app.post("/vectors")
    def create_vector(body: VectorRequest):
        """Build a persona vector on a loaded model from contrastive statements."""
        if not re.fullmatch(r"[A-Za-z0-9_-]+", body.vector_id):
            raise HTTPException(422, "Vector ids use letters, numbers, dashes, and underscores.")
        if not body.positive or not body.negative:
            raise HTTPException(422, "A vector needs positive and negative statements.")
        be = live_backend(body.model)
        with store.lock:
            be.contrastive_vector(body.positive, body.negative, body.vector_id)
        return {"vector_id": body.vector_id, "model": be.name, "layer": be.layer, "vectors": sorted(be.vectors)}

    @app.get("/vectors")
    def list_vectors(model: str | None = None):
        be = live_backend(model)
        return {"model": be.name, "vectors": sorted(be.vectors), "layer": be.layer}

    @app.get("/steer/recorded")
    def steer_recorded(comparison: str, seed: int | None = None, agent: str | None = None):
        man = recorded.manifest()["comparisons"]
        if comparison not in man:
            raise HTTPException(404, f"No recorded comparison named {comparison}.")
        res = recorded.recorded_results(comparison)
        return recorded.recorded_agent(comparison, agent or res["targets"][0], seed) | {"description": res["description"]}

    # Contagion.
    def contagion_path(exp_id: str) -> Path:
        return store.exp_dir(exp_id) / "contagion.json"

    def contagion_edges(exp_id: str) -> list[dict]:
        p = contagion_path(exp_id)
        return json.loads(p.read_text()) if p.exists() else []

    @app.get("/contagion/{experiment}/graph")
    def contagion_graph(experiment: str, feature: int = 0, prune: float = 0.0, window_start: int | None = None, window_end: int | None = None):
        if experiment in recorded.manifest()["comparisons"]:
            comp = recorded.manifest()["comparisons"][experiment]
            run = recorded.load_config(comp["treatment"])[comp["seeds"][0]]
            nodes = [{"id": m["id"], "agent": m["sender"], "step": m["step"], "text": m["text"]} for m in run["messages"]]
            return {"recorded": True, "agents": run["agents"], "nodes": nodes, "edges": [], "seed": comp["seeds"][0],
                    "empty": "Edge weights come only from message-ablation replays, which need a loaded model. "
                             "These recorded runs show the messages and no causal weights."}
        if not (store.exp_dir(experiment) / "config.yaml").exists():
            raise HTTPException(404, f"No experiment named {experiment}.")
        latest = store.latest_complete_fork(experiment)
        if not latest:
            return {"agents": [], "nodes": [], "edges": [], "empty": "Run a fork first."}
        d = store.fork_dir(latest)
        msgs = []
        p = d / "r000-treatment" / "messages.jsonl"
        if p.exists():
            msgs = [json.loads(line) for line in p.open(encoding="utf-8")]
        nodes = [{"id": m["id"], "agent": m["sender"], "step": m["step"], "text": m["text"], "recipients": m["recipients"]} for m in msgs
                 if (window_start is None or m["step"] >= window_start) and (window_end is None or m["step"] <= window_end)]
        edges = [e for e in contagion_edges(experiment) if e["feature"] == feature and abs(e["weight"]) >= prune]
        cfg = store.config(experiment)
        return {"recorded": False, "is_test_model": cfg.model.backend == "test", "fork_id": latest,
                "agents": [a.model_dump() for a in build_agents(cfg)], "nodes": nodes, "edges": edges,
                "empty": None if edges else "No edge is measured yet. Choose a message and replay without it."}

    @app.post("/contagion/{experiment}/ablate")
    def ablate(experiment: str, body: AblateRequest):
        if experiment in recorded.manifest()["comparisons"]:
            raise HTTPException(409, NEEDS_MODEL)
        d = store.fork_dir(body.fork_id)
        if d is None:
            raise HTTPException(404, f"No fork named {body.fork_id}.")
        cfg = store.config(experiment)
        spec = ForkSpec.model_validate(json.loads((d / "spec.json").read_text()))
        snap = store.make_snapshot(experiment, spec.snapshot_step)
        step = int(body.message_id[1:5])
        if step + 1 >= cfg.steps:
            raise HTTPException(422, "The recipient must read the message before the experiment ends.")
        be = store.backend(cfg)
        deltas = []
        silent = 0
        with contagion_lock, store.lock:
            for r in range(min(body.replicates, spec.replicates)):
                import tempfile
                with tempfile.TemporaryDirectory() as tmp:
                    runs = {}
                    for name, drop in (("kept", set()), ("dropped", {body.message_id})):
                        sim = Simulation(cfg, be, Path(tmp) / name, name, replicate=r, interventions=spec.interventions,
                                         batch_invariant=spec.batch_invariant, drop_messages=drop, watch=[body.feature])
                        sim.restore(snap)
                        sim.run(until=step + 2)
                        got = [x for x in sim.readings if x["step"] == step + 1 and x["agent"] == body.recipient
                               and x["source"] == "sae" and x["feature"] == body.feature]
                        runs[name] = got[0]["mean_act"] if got else None
                    if runs["kept"] is None:
                        continue
                    # A recipient whose only incoming message was withheld stays silent, so no activation occurs.
                    if runs["dropped"] is None:
                        silent += 1
                    deltas.append(runs["kept"] - (runs["dropped"] or 0.0))
        if not deltas:
            raise HTTPException(422, f"{body.recipient} did not speak on the step after this message, so no effect could be read.")
        sender = body.message_id.split("-", 1)[1]
        edge = {"message_id": body.message_id, "from": sender, "to": body.recipient, "step": step, "feature": body.feature,
                "weight": float(np.mean(deltas)), "replicates": len(deltas), "recipient_silent_without_message": silent, "method": "message-ablation replay"}
        edges = [e for e in contagion_edges(experiment) if not (e["message_id"] == body.message_id and e["to"] == body.recipient
                                                                and e["feature"] == body.feature)] + [edge]
        contagion_path(experiment).write_text(json.dumps(edges), encoding="utf-8")
        return edge

    # Setup: Google Cloud.
    def merged(body: GcpSettings | None = None) -> gcp.Settings:
        s = gcp.load_settings()
        if body:
            for k, v in body.model_dump(exclude_none=True).items():
                setattr(s, k, v)
        return s

    @app.get("/compute")
    def compute():
        s = gcp.load_settings()
        key = None
        key_error = None
        if s.key_path:
            try:
                key = gcp.check_key(s.key_path)
            except gcp.KeyError_ as exc:
                key_error = str(exc)
        return {"settings": asdict(s), "key": key, "key_error": key_error, "profiles": gcp.PROFILES,
                "problems": gcp.validate(s), "gpu_here": torch.cuda.is_available(), "loaded_models": [b.name for b in store.loaded()]}

    @app.post("/compute/gcp/configure")
    def gcp_configure(body: GcpSettings):
        s = merged(body)
        if body.key_path:
            try:
                info = gcp.check_key(body.key_path)
            except gcp.KeyError_ as exc:
                raise HTTPException(422, str(exc)) from exc
            s.project = s.project or info["project_id"]
        gcp.save_settings(s)
        return compute()

    @app.post("/compute/gcp/up")
    def gcp_up(body: GcpAction):
        s = gcp.load_settings()
        problems = gcp.validate(s)
        if problems:
            raise HTTPException(422, " ".join(problems))
        result = gcp.run(gcp.up_commands(s), s, dry_run=body.dry_run)
        return result | {"tunnel": " ".join(gcp.tunnel_command(s))}

    @app.post("/compute/gcp/down")
    def gcp_down(body: GcpAction):
        s = gcp.load_settings()
        problems = gcp.validate(s, need_hf=False)
        if problems:
            raise HTTPException(422, " ".join(problems))
        return gcp.run(gcp.down_commands(s), s, dry_run=body.dry_run)

    return app


app = create_app()
