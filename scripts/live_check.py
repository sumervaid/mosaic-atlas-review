"""End-to-end check of a live model through the API. Writes a JSON record of what happened.

Usage: live_check.py API_URL OUTPUT.json
Every check is recorded as it finishes, so a failure still leaves evidence of everything before it.
"""

import json
import sys
import time
from pathlib import Path

import httpx
import yaml

API, OUT = sys.argv[1], Path(sys.argv[2])
c = httpx.Client(base_url=API, timeout=1800)
record: dict = {"started": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "checks": {}}


def save(name, value):
    record["checks"][name] = value
    OUT.write_text(json.dumps(record, indent=1, ensure_ascii=False))
    print(name, json.dumps(value, ensure_ascii=False)[:400], flush=True)


def wait(fork_id):
    while True:
        s = c.get(f"/forks/{fork_id}").json()
        if s["status"] in ("complete", "failed"):
            return s
        print("  ", s.get("branch"), s.get("branch_step"), "of", s.get("steps"), flush=True)
        time.sleep(20)


cfg = yaml.safe_load(Path("configs/gemma4b_small.yaml").read_text())
cfg.update(id="live-check", steps=4, max_new_tokens=40)
assert c.post("/experiments", json={"yaml": yaml.safe_dump(cfg)}).status_code == 200
save("health_before", c.get("/health").json())

# Loading the model happens on first use, through the snapshot.
t = time.time()
snap = c.post("/experiments/live-check/snapshots", json={"step": 1})
save("first_snapshot", {"status": snap.status_code, "seconds": round(time.time() - t), "body": snap.json()})
save("health_loaded", c.get("/health").json())
model = cfg["model"]["model_id"]

vec = c.post("/vectors", json={"model": model, "vector_id": "negative-affect",
    "positive": ["I feel awful and everything is going wrong.", "I am angry and frustrated with this team.", "This is hopeless and I am miserable."],
    "negative": ["The meeting starts at noon in room four.", "The report has three sections and an appendix.", "The train leaves from the second platform."]})
save("create_vector", vec.json())

steer = c.post("/steer/chat", json={"model": model, "prompt": "Write two sentences reviewing a plan to move the office next month.",
    "vector_id": "negative-affect", "strength": 400.0, "max_new_tokens": 60, "seed": 1}).json()
save("steer_add", steer)

search = c.get("/concepts/search", params={"mode": "inference", "model": model, "text": "This plan is a disaster and I am furious about it."}).json()
save("search_inference", {"source": search["results"][0]["source"] if search["results"] else None, "top": search["results"][:5], "is_test_model": search.get("is_test_model")})
feature = search["results"][0]["feature"]
# A clamp target above the observed peak stays above the JumpReLU threshold of the feature.
target = round(2 * search["results"][0]["max_act"], 1)

concept = c.get(f"/concepts/{model}/{search['results'][0]['source']}/{feature}")
save("concept_page", {"status": concept.status_code, "neighbours": concept.json().get("neighbours", [])[:3] if concept.status_code == 200 else concept.text[:300],
                      "logits_positive": concept.json().get("logits", {}).get("positive", [])[:5] if concept.status_code == 200 else None})

iv = {"agents": ["A001"], "layer": cfg["layer"], "op": "clamp", "feature": feature, "value": target}
spec = {"experiment_id": "live-check", "snapshot_step": 1, "replicates": 1, "watch_feature": feature, "interventions": [iv]}
t = time.time()
fid = c.post("/forks", json=spec).json()["fork_id"]
status = wait(fid)
save("fork", {"fork_id": fid, "status": status["status"], "error": status.get("error"), "seconds": round(time.time() - t)})
if status["status"] == "complete":
    res = c.get(f"/forks/{fid}/results").json()
    save("results", {"front": res["front"], "hop_effects": [{k: h[k] for k in ("hop", "agents", "overall")} for h in res["hop_effects"]],
                     "log_verification": res["log_verification"], "is_test_model": res["is_test_model"]})
    agent = c.get(f"/forks/{fid}/agents/A001", params={"feature": feature}).json()
    save("clamp_readout", {"target": target, "first_divergence": agent["first_divergence"], "trace": agent["trace"],
                           "control": [m["text"][:300] for m in agent["control"][:2]], "treatment": [m["text"][:300] for m in agent["treatment"][:2]]})
    g = c.get("/contagion/live-check/graph", params={"feature": feature}).json()
    node = next((n for n in g["nodes"] if n["agent"] == "A001" and n["step"] >= 1), None)
    if node:
        t = time.time()
        edge = c.post("/contagion/live-check/ablate", json={"fork_id": fid, "message_id": node["id"], "recipient": node["recipients"][0],
                                                            "feature": feature, "replicates": 1})
        save("replay_edge", {"status": edge.status_code, "seconds": round(time.time() - t), "body": edge.json()})

record["finished"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
OUT.write_text(json.dumps(record, indent=1, ensure_ascii=False))
print("finished", flush=True)
