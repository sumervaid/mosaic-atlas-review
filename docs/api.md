# API reference

The API listens on `http://127.0.0.1:8000`. Interactive documentation is at `/docs` on a live server. [api-examples](api-examples) contains real responses.

## Status

| Method | Path | Purpose |
|---|---|---|
| GET | `/health` | Server state, GPU count, and loaded models |
| GET | `/models` | Available models and sources |
| GET | `/templates` | Experiment templates from `configs/` |

## Experiments and forks

| Method | Path | Purpose |
|---|---|---|
| GET | `/experiments` | Recorded comparisons and live experiments |
| POST | `/experiments` | Create an experiment from a template name or YAML |
| GET | `/experiments/{id}` | Config, AI agents, edges, snapshots, and forks |
| POST | `/experiments/{id}/snapshots` | Save a snapshot at a step |
| POST | `/forks` | Start a fork from a `ForkSpec` |
| GET | `/forks/{id}` | Status of a fork |
| WS | `/forks/{id}/progress` | Live progress of a fork |
| GET | `/forks/{id}/results` | Divergence front, hop effects, outcomes, and map |
| GET | `/forks/{id}/agents/{agent}` | Paired messages and the concept trace |

## Concepts

| Method | Path | Purpose |
|---|---|---|
| GET | `/concepts/search` | Search by explanation or via inference |
| GET | `/concepts/{model}/{source}/{index}` | One concept page |
| GET | `/concepts/{model}/{source}/{index}/swarm` | Per-agent activation, role means, and per-step means |
| POST | `/concepts/{model}/{source}/{index}/test` | Token-level activations on arbitrary text |

## Steering

| Method | Path | Purpose |
|---|---|---|
| POST | `/vectors` | Build a persona vector from contrastive statements |
| GET | `/vectors` | Vectors on a loaded model |
| POST | `/steer/chat` | Default and steered completions |
| GET | `/steer/recorded` | Default and steered messages from recorded sessions |

## Contagion

| Method | Path | Purpose |
|---|---|---|
| GET | `/contagion/{experiment}/graph` | Messages and measured edges |
| POST | `/contagion/{experiment}/ablate` | Replay with one message removed and measure the edge |

## Compute

| Method | Path | Purpose |
|---|---|---|
| GET | `/compute` | Settings, non-secret key details, and remaining requirements |
| POST | `/compute/gcp/configure` | Save paths, project, zone, and profile |
| POST | `/compute/gcp/up` | Preview or create the machine |
| POST | `/compute/gcp/down` | Preview or delete the machine |
