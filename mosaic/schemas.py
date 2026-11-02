"""Typed records shared by the engine, the analysis, and the API."""

from __future__ import annotations

from pathlib import Path
from typing import Literal

import yaml
from pydantic import BaseModel, Field


class Agent(BaseModel):
    id: str
    role: Literal["Coordinator", "Lead", "Prover", "Verifier", "Member"]
    team: int
    model: str
    persona: str


class Message(BaseModel):
    id: str
    step: int
    sender: str
    recipients: list[str]
    text: str


class LogEntry(BaseModel):
    seq: int
    step: int
    agent: str
    kind: Literal["message", "tool_call", "rationale", "intervention"]
    payload: dict
    prev_hash: str
    hash: str
    signature: str


class Intervention(BaseModel):
    agents: list[str]
    layer: int = 32
    op: Literal["clamp", "ablate", "add"]
    feature: int | None = None
    value: float | None = None
    vector_id: str | None = None
    alpha: float | None = None
    window: tuple[int, int | None] = (0, None)
    positions: Literal["all", "generated"] = "all"


class ForkSpec(BaseModel):
    experiment_id: str
    snapshot_step: int = 0
    replicates: int = 20
    interventions: list[Intervention]
    shared_seeds: bool = True
    batch_invariant: bool = True
    watch_feature: int | None = None


class ConceptReading(BaseModel):
    branch_id: str
    replicate: int
    step: int
    agent: str
    message_id: str
    layer: int
    feature: int
    max_act: float
    mean_act: float


class Population(BaseModel):
    coordinator: int = 1
    teams: int = 15
    provers_per_team: int = 10
    verifiers_per_team: int = 6


class ModelConfig(BaseModel):
    backend: Literal["test", "hf"] = "test"
    model_id: str = "gemma-3-12b-it"
    hf_repo: str = "google/gemma-3-12b-it"
    revision: str | None = None
    sae_repo: str | None = "google/gemma-scope-2-12b-it"
    sae_path: str | None = "resid_post_all/layer_32_width_16k_l0_small"
    dtype: str = "bfloat16"
    device: str = "cuda"


class ExperimentConfig(BaseModel):
    id: str
    description: str = ""
    model: ModelConfig = Field(default_factory=ModelConfig)
    population: Population = Field(default_factory=Population)
    topology: Literal["hierarchy", "hub", "ring", "small_world", "full"] = "hierarchy"
    steps: int = 20
    seed: int = 0
    temperature: float = 0.8
    max_new_tokens: int = 48
    memory_messages: int = 3
    inbox_chars: int = 400
    layer: int = 32
    watch_features: list[int] = Field(default_factory=list)
    batch_size: int = 32
    task_set: str = "configs/tasks/lemmas.yaml"


def load_config(path: str | Path) -> ExperimentConfig:
    with Path(path).open(encoding="utf-8") as f:
        return ExperimentConfig.model_validate(yaml.safe_load(f))
