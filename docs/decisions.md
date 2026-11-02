# Decisions

Numbered choices that differ from the design brief or fill a gap in the brief.

1. Gemma Scope 2 has no 65k residual SAE at layer 32. The 65k residual SAEs sit at layers 12, 24, 31, and 41. Layer 32 exists under `resid_post_all` at 16k and 262k, in `l0_small` and `l0_big` only. The 12B configuration uses `resid_post_all/layer_32_width_16k_l0_small`, which matches the natural language autoencoder layer and fits beside the model. Checked against the release file list and the safetensors header on 2026-11-01.
2. The clamp formula in the design brief moves from the encoded activation. A JumpReLU encodes zero below threshold while the linear output stays nonzero, so that formula misses the target and fails the acceptance test for serving. The edit here moves from the pre-activation and divides by the feature's encoder-decoder gain.
3. An ablation edits a position only when the feature is above threshold there. Below threshold the feature already reads zero.
4. Gemma 3 12B in bf16 holds about 24 GB of weights, so one NVIDIA L4 cannot hold the model and its activations. The `12b` profile uses two L4s. The `4b` profile uses one and matches the pilot.
5. The checker is a deterministic stand-in for Lean 4. It evaluates closed arithmetic comparisons only, as the design brief allows.
6. Natural language autoencoder readouts are not wired in. The said versus represented gap is reported as not measured, and no value is ever shown for it.
7. Serving uses Hugging Face `transformers` with a forward hook. The vLLM or SGLang path for high-throughput serving is planned.
8. Batch-invariant mode batches only prompts of one length, so no row is padded. Tested on the CPU. It has not been tested on a GPU, where kernel choice can change results.
9. Entries in the signed log carry no wall-clock time, so branches that do identical work have identical hash chains. This makes the determinism test stronger.
10. When a replay withholds a recipient's only incoming message, the recipient stays silent. The edge weight counts the missing activation as zero and records how many replicates this happened in.
11. The test backend is a tiny random Gemma 3 on the CPU. Its text is noise, and every screen that shows it says so. It exists to prove the software works with no GPU, no download, and no credentials.
12. Recorded pilot runs are imported read only. Tests check that the importer reproduces the pilot's published estimates.
13. Each recorded seed draws its own named personas, so per-agent maps and comparisons use one seed at a time.
14. Live models start with no steering vectors. `POST /vectors` builds a persona vector from contrastive statements on the loaded model, since the add operation needs one.
15. A project's global GPU quota, `GPUS_ALL_REGIONS`, often starts at one. The first real provisioning attempt reached this limit, so the user guide documents the limit.
16. The encoder first subtracted the decoder bias, against the Gemma Scope definition of x @ W_enc + b_enc. The random test dictionary has a zero bias, which hid the error. A check on real Gemma 3 4B activations exposed the error, with a fraction of variance unexplained near 2,000 and about 1,400 active features per token. After the fix, the same check gave 0.022 and about 21 active features at layer 14, with worse fits at layers 13 and 15. `scripts/sae_check.py` repeats this check, and `tests/test_m0_m1.py` now covers a nonzero decoder bias.
17. Clamp precision depends on model precision. In bf16 on Gemma 3 4B, clamps landed within about 2 activation units, or 0.5% to 1.2%, because the residual norm near 27,000 exceeds bf16 resolution. In float32, clamps landed within about 0.001. Experiments requiring the tighter bound should set `dtype: float32`, at about 16 GB for Gemma 3 4B.
18. A clamp at twice the observed peak of a feature can produce empty text from the clamped AI agent, seen in the live check. Researchers should validate clamp strengths on a single AI agent before a fork.
19. NVIDIA L4 capacity varies by zone. On 2026-11-01, three `us-central1` and five `us-east` zones reported a stockout, and `us-west1-a` had capacity. `us-central1-f` lacks the `g2-standard-12` machine type.
20. The dictionary reconstructs Gemma 3 4B activations at layer 14, and the meaning of individual features remains unvalidated. Top neighbours on the concept page reach decoder cosines above 0.9, with logits often on unused tokens. Dimension 443 dominates the residual norm, and the reconstruction check leaves this dimension in place, which could flatter the 2.2% figure.
