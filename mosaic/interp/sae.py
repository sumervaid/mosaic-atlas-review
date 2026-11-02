"""JumpReLU sparse autoencoder with the parameter layout of the Gemma Scope 2 release."""

from __future__ import annotations

import torch


class JumpReLUSAE:
    def __init__(self, w_enc: torch.Tensor, w_dec: torch.Tensor, b_enc: torch.Tensor, b_dec: torch.Tensor,
                 threshold: torch.Tensor, source: str):
        self.w_enc = w_enc  # [n_features, d_model]
        self.w_dec = w_dec  # [n_features, d_model]
        self.b_enc = b_enc
        self.b_dec = b_dec
        self.threshold = threshold
        self.source = source
        # Encoder and decoder rows are not exact inverses, so a clamp divides by this gain to land on target.
        self.gain = (w_enc * w_dec).sum(-1)

    @property
    def n_features(self) -> int:
        return self.w_enc.shape[0]

    def pre(self, h: torch.Tensor, features: torch.Tensor | None = None) -> torch.Tensor:
        enc = self.w_enc if features is None else self.w_enc[features]
        bias = self.b_enc if features is None else self.b_enc[features]
        # The Gemma Scope encoder is x @ W_enc + b_enc. The decoder bias belongs to reconstruction alone.
        return h.to(enc.dtype) @ enc.T + bias

    def encode(self, h: torch.Tensor, features: torch.Tensor | None = None) -> torch.Tensor:
        pre = self.pre(h, features)
        thr = self.threshold if features is None else self.threshold[features]
        return pre * (pre > thr)

    def to(self, device) -> "JumpReLUSAE":
        for name in ("w_enc", "w_dec", "b_enc", "b_dec", "threshold", "gain"):
            setattr(self, name, getattr(self, name).to(device))
        return self

    @classmethod
    def random(cls, d_model: int, n_features: int = 256, seed: int = 0) -> "JumpReLUSAE":
        """Seeded random dictionary for the test backend. Features have no meaning."""
        g = torch.Generator().manual_seed(seed)
        w = torch.randn(n_features, d_model, generator=g)
        w = w / w.norm(dim=-1, keepdim=True)
        return cls(w.clone(), w.clone(), torch.zeros(n_features), torch.zeros(d_model),
                   torch.full((n_features,), 0.01), source=f"random-{n_features}")

    @classmethod
    def load(cls, repo: str, path: str, device="cpu") -> "JumpReLUSAE":
        from huggingface_hub import hf_hub_download
        from safetensors.torch import load_file

        params = load_file(hf_hub_download(repo, f"{path}/params.safetensors"))
        lookup = {k.lower(): v.float() for k, v in params.items()}
        sae = cls(lookup["w_enc"].T if lookup["w_enc"].shape[0] < lookup["w_enc"].shape[1] else lookup["w_enc"],
                  lookup["w_dec"], lookup["b_enc"], lookup["b_dec"], lookup["threshold"], source=f"{repo}/{path}")
        return sae.to(device)
