"""Batched generation in which every request carries its own intervention list.

Requests with no intervention share a batch with steered requests, so cost scales with the number of
agents. Interventions run in a forward hook on one decoder block. Each row samples from its own seeded
generator, so a row's tokens depend on its seed and its activations, never on its neighbours in the batch.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Sequence

import torch

from mosaic.interp.sae import JumpReLUSAE

CHAT_TEMPLATE = (
    "<bos>{% for m in messages %}<start_of_turn>{{ m['role'] }}\n{{ m['content'] }}<end_of_turn>\n"
    "{% endfor %}{% if add_generation_prompt %}<start_of_turn>model\n{% endif %}"
)
SPECIALS = ["<pad>", "<eos>", "<bos>", "<unk>", "<start_of_turn>", "<end_of_turn>"]


@dataclass
class Op:
    kind: str  # clamp, ablate, add
    feature: int | None = None
    value: float | None = None
    vector_id: str | None = None
    alpha: float | None = None
    positions: str = "all"


@dataclass
class GenRequest:
    rid: str
    prompt: str
    seed: int = 0
    ops: list[Op] = field(default_factory=list)


@dataclass
class GenResult:
    rid: str
    text: str
    tokens: list[int]
    readings: dict[int, tuple[float, float]]  # feature -> (max, mean) over generated positions
    projections: dict[str, float]  # vector id -> mean projection over generated positions


def find_layers(model: torch.nn.Module) -> torch.nn.ModuleList:
    best = None
    for name, module in model.named_modules():
        if isinstance(module, torch.nn.ModuleList) and name.endswith("layers") and "vision" not in name:
            if best is None or len(module) > len(best):
                best = module
    if best is None:
        raise ValueError("no decoder layer list found")
    return best


def _hidden(output):
    return output[0] if isinstance(output, tuple) else output


def _replace(output, hidden):
    return (hidden,) + tuple(output[1:]) if isinstance(output, tuple) else hidden


def tiny_tokenizer():
    from tokenizers import Tokenizer, decoders, models, pre_tokenizers
    from transformers import PreTrainedTokenizerFast
    from transformers.convert_slow_tokenizer import bytes_to_unicode

    vocab = {tok: i for i, tok in enumerate(SPECIALS)}
    for ch in bytes_to_unicode().values():
        vocab[ch] = len(vocab)
    core = Tokenizer(models.BPE(vocab=vocab, merges=[], unk_token="<unk>"))
    core.pre_tokenizer = pre_tokenizers.ByteLevel(add_prefix_space=False, use_regex=False)
    core.decoder = decoders.ByteLevel()
    tok = PreTrainedTokenizerFast(
        tokenizer_object=core, pad_token="<pad>", eos_token="<eos>", bos_token="<bos>", unk_token="<unk>",
        additional_special_tokens=["<start_of_turn>", "<end_of_turn>"],
    )
    tok.chat_template = CHAT_TEMPLATE
    return tok


class Backend:
    """One loaded model, one SAE, and any number of named steering vectors."""

    def __init__(self, model, tokenizer, layer: int, sae: JumpReLUSAE | None, device="cpu", name="test",
                 vectors: dict[str, torch.Tensor] | None = None, is_test: bool = False):
        self.model = model.eval()
        self.tok = tokenizer
        self.tok.padding_side = "left"
        self.device = torch.device(device)
        self.layers = find_layers(model)
        self.layer = layer
        # With a model split across GPUs, tensors the hook touches must live beside the hooked block.
        self.hook_device = next(self.layers[layer].parameters()).device
        self.sae = sae.to(self.hook_device) if sae is not None else None
        self.name = name
        self.is_test = is_test
        self.vectors = {k: v.to(self.hook_device).float() for k, v in (vectors or {}).items()}
        cfg = model.config.get_text_config() if hasattr(model.config, "get_text_config") else model.config
        self.d_model = cfg.hidden_size
        gen = getattr(model, "generation_config", None)
        eos = getattr(gen, "eos_token_id", None)
        ids = set([eos] if isinstance(eos, int) else (eos or []))
        if tokenizer.eos_token_id is not None:
            ids.add(tokenizer.eos_token_id)
        end_turn = tokenizer.convert_tokens_to_ids("<end_of_turn>")
        if isinstance(end_turn, int) and end_turn != tokenizer.unk_token_id:
            ids.add(end_turn)
        self.eos_ids = sorted(ids)

    @classmethod
    def test(cls, layer: int = 2, seed: int = 0, n_features: int = 256) -> "Backend":
        """A tiny random Gemma 3 on the CPU, no download. Verifies the software. Its text has no meaning."""
        from transformers import Gemma3ForCausalLM, Gemma3TextConfig

        tok = tiny_tokenizer()
        torch.manual_seed(seed)
        cfg = Gemma3TextConfig(
            vocab_size=len(tok), hidden_size=32, intermediate_size=64, num_hidden_layers=4, num_attention_heads=2,
            num_key_value_heads=1, head_dim=16, max_position_embeddings=32768, sliding_window=64,
            pad_token_id=tok.pad_token_id, bos_token_id=tok.bos_token_id, eos_token_id=tok.eos_token_id,
        )
        model = Gemma3ForCausalLM(cfg).to(torch.float32)
        model.generation_config.eos_token_id = tok.eos_token_id
        sae = JumpReLUSAE.random(32, n_features=n_features, seed=seed)
        g = torch.Generator().manual_seed(seed + 1)
        vec = torch.randn(32, generator=g)
        vectors = {"test-vector": vec / vec.norm()}
        return cls(model, tok, layer, sae, name="test", vectors=vectors, is_test=True)

    @classmethod
    def huggingface(cls, repo: str, layer: int, sae_repo: str | None, sae_path: str | None, revision=None,
                    dtype="bfloat16", device="cuda", name=None) -> "Backend":
        from transformers import AutoModelForCausalLM, AutoTokenizer

        tok = AutoTokenizer.from_pretrained(repo, revision=revision)
        model = AutoModelForCausalLM.from_pretrained(repo, revision=revision, dtype=getattr(torch, dtype),
                                                     device_map=device)
        sae = JumpReLUSAE.load(sae_repo, sae_path, device="cpu") if sae_repo and sae_path else None
        return cls(model, tok, layer, sae, device=model.device, name=name or repo.split("/")[-1])

    def chat(self, text: str) -> str:
        return self.tok.apply_chat_template([{"role": "user", "content": text}], tokenize=False,
                                            add_generation_prompt=True)

    def _edit_row(self, h: torch.Tensor, row: int, ops: Sequence[Op], first_pass: bool) -> None:
        """Apply one request's ops in place. Only the targeted contribution changes, so SAE error survives."""
        for op in ops:
            if op.positions == "generated" and first_pass:
                pos = torch.tensor([h.shape[1] - 1], device=h.device)
            else:
                pos = torch.arange(h.shape[1], device=h.device)
            seg = h[row, pos].float()
            if op.kind == "add":
                seg = seg + float(op.alpha) * self.vectors[op.vector_id]
            else:
                f_idx = torch.tensor([op.feature], device=h.device)
                # The edit starts from the pre-activation. A JumpReLU reads zero below threshold even when the
                # linear encoder output is nonzero, and moving from zero would miss the clamp target.
                pre = self.sae.pre(seg, f_idx)[:, 0]
                if op.kind == "ablate":
                    delta = -pre * (pre > self.sae.threshold[op.feature])
                else:
                    delta = float(op.value) - pre
                seg = seg + (delta / self.sae.gain[op.feature])[:, None] * self.sae.w_dec[op.feature]
            h[row, pos] = seg.to(h.dtype)

    def _groups(self, n: int, lengths: list[int], batch_size: int, invariant: bool) -> list[list[int]]:
        order = sorted(range(n), key=lambda i: (lengths[i], i))
        if not invariant:
            return [order[i:i + batch_size] for i in range(0, n, batch_size)]
        # Batch-invariant mode: rows of one batch have one length, so no row is ever padded.
        groups, cur = [], []
        for i in order:
            if cur and (lengths[cur[0]] != lengths[i] or len(cur) >= batch_size):
                groups.append(cur)
                cur = []
            cur.append(i)
        return groups + ([cur] if cur else [])

    @torch.no_grad()
    def generate(self, requests: Sequence[GenRequest], max_new_tokens: int = 48, temperature: float = 0.8,
                 watch: Sequence[int] = (), watch_vectors: Sequence[str] = (), batch_size: int = 32,
                 batch_invariant: bool = True) -> list[GenResult]:
        enc = [self.tok(r.prompt, add_special_tokens=False)["input_ids"] for r in requests]
        results: list[GenResult | None] = [None] * len(requests)
        for group in self._groups(len(requests), [len(e) for e in enc], batch_size, batch_invariant):
            batch = self._generate_group([requests[i] for i in group], [enc[i] for i in group], max_new_tokens,
                                         temperature, watch, watch_vectors)
            for i, res in zip(group, batch):
                results[i] = res
        return results  # type: ignore[return-value]

    def _generate_group(self, reqs, enc, max_new_tokens, temperature, watch, watch_vectors) -> list[GenResult]:
        b = len(reqs)
        width = max(len(e) for e in enc)
        pad = self.tok.pad_token_id
        ids = torch.tensor([[pad] * (width - len(e)) + e for e in enc], device=self.device)
        mask = torch.tensor([[0] * (width - len(e)) + [1] * len(e) for e in enc], device=self.device)
        gens = [torch.Generator(device="cpu").manual_seed(int(r.seed) % (2**63)) for r in reqs]
        steered = [i for i, r in enumerate(reqs) if r.ops]
        w_idx = torch.tensor(list(watch), device=self.hook_device, dtype=torch.long) if len(watch) else None
        w_max = torch.zeros(b, len(watch), device=self.hook_device)
        w_sum = torch.zeros(b, len(watch), device=self.hook_device)
        p_sum = {v: torch.zeros(b, device=self.hook_device) for v in watch_vectors}
        state = {"first": True}

        def hook(_m, _i, output):
            h = _hidden(output)
            if steered:
                h = h.clone()
                for row in steered:
                    self._edit_row(h, row, reqs[row].ops, state["first"])
            last = h[:, -1, :]
            if w_idx is not None and self.sae is not None:
                a = self.sae.encode(last, w_idx)
                w_max.copy_(torch.maximum(w_max, a))
                w_sum.add_(a)
            for v in watch_vectors:
                p_sum[v].add_(last.float() @ self.vectors[v])
            return _replace(output, h) if steered else output

        handle = self.layers[self.layer].register_forward_hook(hook)
        tokens: list[list[int]] = [[] for _ in range(b)]
        done = [False] * b
        past = None
        steps_done = 0
        try:
            inp = ids
            attn = mask
            pos = (mask.cumsum(1) - 1).clamp(min=0)
            for _ in range(max_new_tokens):
                out = self.model(input_ids=inp, attention_mask=attn, position_ids=pos, past_key_values=past,
                                 use_cache=True)
                past = out.past_key_values
                state["first"] = False
                steps_done += 1
                logits = out.logits[:, -1, :].float()
                nxt = []
                for i in range(b):
                    if done[i]:
                        nxt.append(pad)
                        continue
                    if temperature > 0:
                        probs = torch.softmax(logits[i] / temperature, dim=-1).cpu()
                        t = int(torch.multinomial(probs, 1, generator=gens[i]))
                    else:
                        t = int(logits[i].argmax())
                    tokens[i].append(t)
                    if t in self.eos_ids:
                        done[i] = True
                    nxt.append(t)
                if all(done):
                    break
                inp = torch.tensor(nxt, device=self.device)[:, None]
                attn = torch.cat([attn, torch.ones(b, 1, device=self.device, dtype=attn.dtype)], dim=1)
                pos = pos[:, -1:] + 1
        finally:
            handle.remove()
        out_rows = []
        for i, r in enumerate(reqs):
            n = max(1, len(tokens[i]))
            readings = {int(f): (float(w_max[i, j]), float(w_sum[i, j]) / n) for j, f in enumerate(watch)}
            proj = {v: float(p_sum[v][i]) / n for v in watch_vectors}
            text = self.tok.decode(tokens[i], skip_special_tokens=True).strip()
            out_rows.append(GenResult(r.rid, text, tokens[i], readings, proj))
        return out_rows

    @torch.no_grad()
    def forward_logits(self, prompts: Sequence[str], ops_by_row: Sequence[Sequence[Op]] | None = None,
                       capture: list | None = None) -> torch.Tensor:
        """Last-position logits for equal-length prompts, with optional per-row ops, for acceptance tests."""
        enc = self.tok(list(prompts), return_tensors="pt", padding=True, add_special_tokens=False)
        ops_by_row = ops_by_row or [[] for _ in prompts]

        def hook(_m, _i, output):
            h = _hidden(output).clone()
            for row, ops in enumerate(ops_by_row):
                self._edit_row(h, row, ops, True)
            if capture is not None:
                capture.append(h.detach().clone())
            return _replace(output, h)

        handle = self.layers[self.layer].register_forward_hook(hook)
        try:
            out = self.model(**{k: v.to(self.device) for k, v in enc.items()})
        finally:
            handle.remove()
        return out.logits[:, -1, :].float()

    @torch.no_grad()
    def token_activations(self, text: str, feature: int | None = None, vector_id: str | None = None) -> dict:
        """Per-token activation of one SAE feature or one vector on arbitrary text."""
        enc = self.tok(text, return_tensors="pt", add_special_tokens=False)
        store = []

        def hook(_m, _i, output):
            store.append(_hidden(output).detach().float())

        handle = self.layers[self.layer].register_forward_hook(hook)
        try:
            self.model(**{k: v.to(self.device) for k, v in enc.items()})
        finally:
            handle.remove()
        h = store[0][0]
        if vector_id is not None:
            acts = h @ self.vectors[vector_id]
        else:
            acts = self.sae.encode(h, torch.tensor([feature], device=self.hook_device))[:, 0]
        toks = [self.tok.decode([t]) for t in enc["input_ids"][0].tolist()]
        return {"tokens": toks, "activations": [float(a) for a in acts]}

    @torch.no_grad()
    def active_features(self, text: str, top_k: int = 20) -> list[dict]:
        """Features most active on text, per token, for search via inference."""
        enc = self.tok(text, return_tensors="pt", add_special_tokens=False)
        store = []

        def hook(_m, _i, output):
            store.append(_hidden(output).detach().float())

        handle = self.layers[self.layer].register_forward_hook(hook)
        try:
            self.model(**{k: v.to(self.device) for k, v in enc.items()})
        finally:
            handle.remove()
        acts = self.sae.encode(store[0][0])
        peak, where = acts.max(dim=0)
        top = torch.topk(peak, min(top_k, peak.shape[0]))
        toks = [self.tok.decode([t]) for t in enc["input_ids"][0].tolist()]
        return [{"feature": int(i), "max_act": float(v), "token_index": int(where[i]), "token": toks[int(where[i])]}
                for v, i in zip(top.values, top.indices) if float(v) > 0]

    @torch.no_grad()
    def contrastive_vector(self, positive: Sequence[str], negative: Sequence[str], vector_id: str) -> torch.Tensor:
        """Persona vector by the contrastive method: mean residual on positive minus negative statements."""
        def mean_resid(prompts):
            rows = []
            for p in prompts:
                enc = self.tok(p, return_tensors="pt", add_special_tokens=False)
                store = []

                def hook(_m, _i, output):
                    store.append(_hidden(output).detach().float())

                handle = self.layers[self.layer].register_forward_hook(hook)
                try:
                    self.model(**{k: v.to(self.device) for k, v in enc.items()})
                finally:
                    handle.remove()
                rows.append(store[0][0].mean(0))
            return torch.stack(rows).mean(0)

        vec = mean_resid(positive) - mean_resid(negative)
        vec = (vec / vec.norm()).to(self.hook_device)
        self.vectors[vector_id] = vec
        return vec


def ops_for(interventions, agent: str, step: int) -> list[Op]:
    """The ops active for one agent at one step, from a list of Intervention records."""
    ops = []
    for iv in interventions:
        start, end = iv.window
        if agent in iv.agents and step >= start and (end is None or step <= end):
            ops.append(Op(kind=iv.op, feature=iv.feature, value=iv.value, vector_id=iv.vector_id, alpha=iv.alpha,
                          positions=iv.positions))
    return ops


def backend_from_config(model_cfg, layer: int) -> Backend:
    if model_cfg.backend == "test":
        return Backend.test(layer=layer)
    return Backend.huggingface(model_cfg.hf_repo, layer, model_cfg.sae_repo, model_cfg.sae_path, model_cfg.revision,
                               model_cfg.dtype, model_cfg.device, model_cfg.model_id)
