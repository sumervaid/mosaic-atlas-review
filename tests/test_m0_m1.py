"""M0: configs load into typed objects. M1: clamp, ablate, and add behave as specified on the test backend."""

from pathlib import Path

import pytest
import torch

from mosaic.schemas import ExperimentConfig, ForkSpec, Intervention, load_config
from mosaic.serve.backend import Backend, GenRequest, Op

ROOT = Path(__file__).resolve().parent.parent


@pytest.fixture(scope="module")
def be():
    return Backend.test()


@pytest.mark.parametrize("name", ["test_32.yaml", "test_256.yaml", "gemma_256.yaml"])
def test_configs_load(name):
    assert isinstance(load_config(ROOT / "configs" / name), ExperimentConfig)


def test_population_matches_spec():
    p = load_config(ROOT / "configs" / "test_256.yaml").population
    assert p.coordinator + p.teams * (1 + p.provers_per_team + p.verifiers_per_team) == 256


def test_fork_spec_types():
    spec = ForkSpec(experiment_id="x", interventions=[Intervention(agents=["A001"], op="add", vector_id="v", alpha=1.0)])
    assert spec.replicates == 20 and spec.shared_seeds


PROMPTS = ["the quick brown fox", "jumps over the lazy", "a stable team plans"]


@pytest.mark.parametrize("target", [0.5, 2.0, 7.5])
def test_clamp_reaches_target(be, target):
    cap = []
    be.forward_logits(PROMPTS, [[Op("clamp", feature=3, value=target)], [], []], capture=cap)
    f = be.sae.encode(cap[0][0], torch.tensor([3]))[:, 0]
    assert torch.allclose(f, torch.full_like(f, target), atol=1e-3)


def test_ablate_reaches_zero(be):
    cap = []
    be.forward_logits(PROMPTS, [[Op("ablate", feature=5)], [], []], capture=cap)
    f = be.sae.encode(cap[0][0], torch.tensor([5]))[:, 0]
    assert float(f.abs().max()) <= 1e-3


def test_add_moves_along_vector(be):
    base, moved = [], []
    be.forward_logits(PROMPTS, capture=base)
    be.forward_logits(PROMPTS, [[Op("add", vector_id="test-vector", alpha=3.0)], [], []], capture=moved)
    delta = (moved[0][0] - base[0][0]).float() @ be.vectors["test-vector"]
    assert torch.allclose(delta, torch.full_like(delta, 3.0), atol=1e-3)


def test_untargeted_rows_are_identical(be):
    plain = be.forward_logits(PROMPTS)
    hooked = be.forward_logits(PROMPTS, [[Op("clamp", feature=3, value=9.0)], [], []])
    assert torch.equal(plain[1:], hooked[1:])
    assert not torch.equal(plain[0], hooked[0])


def test_clamp_keeps_other_features_error(be):
    """Only the targeted contribution changes: the edit is a multiple of one decoder row."""
    base, moved = [], []
    be.forward_logits(PROMPTS, capture=base)
    be.forward_logits(PROMPTS, [[Op("clamp", feature=3, value=2.0)], [], []], capture=moved)
    delta = (moved[0][0] - base[0][0]).float()
    d = be.sae.w_dec[3]
    residual = delta - (delta @ d)[:, None] * d / (d @ d)
    assert float(residual.abs().max()) < 1e-4


def test_seed_determines_tokens_across_batch_mates(be):
    target = GenRequest("a", be.chat("hello team"), seed=11)
    alone = be.generate([target], max_new_tokens=6)[0]
    mate = GenRequest("b", be.chat("hello mate"), seed=99)  # equal length, so the two rows batch together
    together = be.generate([target, mate], max_new_tokens=6)[0]
    assert alone.tokens == together.tokens


def test_steered_mate_leaves_row_unchanged(be):
    target = GenRequest("a", be.chat("hello team"), seed=11)
    plain = be.generate([target, GenRequest("b", be.chat("hello mate"), seed=99)], max_new_tokens=6)[0]
    steered = be.generate([target, GenRequest("b", be.chat("hello mate"), seed=99,
                                              ops=[Op("add", vector_id="test-vector", alpha=50.0)])], max_new_tokens=6)
    assert plain.tokens == steered[0].tokens


def test_steering_changes_tokens(be):
    req = be.chat("hello team")
    plain = be.generate([GenRequest("a", req, seed=11)], max_new_tokens=12)[0]
    moved = be.generate([GenRequest("a", req, seed=11, ops=[Op("add", vector_id="test-vector", alpha=200.0)])],
                        max_new_tokens=12)[0]
    assert plain.tokens != moved.tokens


def test_watch_list_readout(be):
    res = be.generate([GenRequest("a", be.chat("hello team"), seed=1, ops=[Op("clamp", feature=2, value=5.0)])],
                      max_new_tokens=4, watch=[2], watch_vectors=["test-vector"])[0]
    assert abs(res.readings[2][0] - 5.0) < 1e-3
    assert "test-vector" in res.projections


def test_encoder_keeps_decoder_bias_out_of_encoding():
    """Gemma Scope encodes as x @ W_enc + b_enc. A random SAE has a zero decoder bias, which would hide this bug."""
    from mosaic.interp.sae import JumpReLUSAE

    w = torch.eye(4)
    sae = JumpReLUSAE(w, w, torch.zeros(4), torch.full((4,), 100.0), torch.zeros(4), source="test")
    x = torch.tensor([[1.0, 2.0, 3.0, 4.0]])
    assert torch.equal(sae.encode(x), x)
