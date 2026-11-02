"""Check a Gemma Scope 2 SAE, clamp precision, and batch invariance on real activations. Needs a GPU and model access."""
import json

import torch

from mosaic.schemas import load_config
from mosaic.serve.backend import GenRequest, Op, _hidden, backend_from_config

cfg = load_config("configs/gemma4b_small.yaml")
be = backend_from_config(cfg.model, cfg.layer)
sae = be.sae
out = {"sae": sae.source, "shape": list(sae.w_enc.shape), "dtype_model": str(next(be.model.parameters()).dtype), "device": str(be.hook_device),
       "thr_quantiles": [float(x) for x in torch.quantile(sae.threshold.float(), torch.tensor([.01,.5,.99]).to(sae.threshold.device))],
       "gain_quantiles": [float(x) for x in torch.quantile(sae.gain.float(), torch.tensor([.01,.5,.99]).to(sae.gain.device))],
       "dec_norm_median": float(sae.w_dec.norm(dim=-1).median()), "b_dec_norm": float(sae.b_dec.norm())}
texts = ["The team reviewed the plan and found a serious flaw in the schedule.", "Rain fell over the harbor while the ferry waited for the morning tide.",
         "This plan is a disaster and I am furious about it.", "The capital of France is Paris, a city on the river Seine."]
def resid(layer, text):
    enc = be.tok(be.chat(text), return_tensors="pt", add_special_tokens=False)
    store = []
    h = be.layers[layer].register_forward_hook(lambda m,i,o: store.append(_hidden(o).detach().float()))
    with torch.no_grad(): be.model(**{k: v.to(be.device) for k, v in enc.items()})
    h.remove()
    return store[0][0], enc["input_ids"][0]
def fvu(x):
    f = sae.encode(x)
    rec = f @ sae.w_dec + sae.b_dec
    return float(((x-rec)**2).sum()/((x-x.mean(0))**2).sum()), float((f>0).float().sum(-1).mean()), float(x.norm(dim=-1).mean())
rows = {}
for layer in (13, 14, 15):
    xs = torch.cat([resid(layer, t)[0][1:] for t in texts]).to(sae.w_enc.device)
    rows[layer] = dict(zip(("fvu","l0","norm"), fvu(xs)))
out["by_layer_excluding_bos"] = rows
x, ids = resid(14, texts[0])
out["bos_norm_vs_rest"] = [float(x[0].norm()), float(x[1:].norm(dim=-1).mean())]
big = torch.topk(x[1:].abs().mean(0), 3); out["largest_dims"] = [[int(i), float(v)] for v, i in zip(big.values, big.indices)]
# clamp accuracy on real activations, at targets above the threshold
f_all = sae.encode(x[1:].to(sae.w_enc.device)); peak = f_all.max(0).values; feat = int(torch.argsort(peak, descending=True)[50])
thr = float(sae.threshold[feat]); targets = [thr*1.5, thr*3]
prompts = [be.chat(texts[0]), be.chat(texts[0])]
clamp = []
for tgt in targets:
    cap = []
    be.forward_logits(prompts, [[Op("clamp", feature=feat, value=tgt)], []], capture=cap)
    got = sae.encode(cap[0][0].float().to(sae.w_enc.device), torch.tensor([feat]).to(sae.w_enc.device))[:, 0]
    clamp.append({"target": tgt, "max_abs_error": float((got[1:]-tgt).abs().max()), "relative": float((got[1:]-tgt).abs().max()/tgt)})
out["clamp"] = {"feature": feat, "threshold": thr, "peak": float(peak[feat]), "results": clamp}
plain = be.forward_logits(prompts); hooked = be.forward_logits(prompts, [[Op("clamp", feature=feat, value=targets[1])], []])
out["untargeted_row_identical"] = bool(torch.equal(plain[1], hooked[1])); out["targeted_row_changed"] = not bool(torch.equal(plain[0], hooked[0]))
# batch invariance on the GPU
a = be.chat("Hello team, please review the plan.")
b = be.chat("Hello team, please review the file.")
alone = be.generate([GenRequest("a", a, seed=7)], max_new_tokens=30, temperature=0.8)[0]
pair = be.generate([GenRequest("a", a, seed=7), GenRequest("b", b, seed=8)], max_new_tokens=30, temperature=0.8)
out["same_length"] = len(be.tok(a)["input_ids"]) == len(be.tok(b)["input_ids"])
out["batch_invariant_tokens"] = alone.tokens == pair[0].tokens
rerun = be.generate([GenRequest("a", a, seed=7)], max_new_tokens=30, temperature=0.8)[0]
out["rerun_identical"] = alone.tokens == rerun.tokens
out["peak_gpu_mib"] = int(torch.cuda.max_memory_allocated()/2**20)
print(json.dumps(out, indent=1))
# Clamp precision with the model in float32, where bf16 rounding of the residual is absent.
if torch.cuda.is_available():
    import gc
    del be; gc.collect(); torch.cuda.empty_cache()
    cfg.model.dtype = "float32"
    be = backend_from_config(cfg.model, cfg.layer); sae = be.sae
    x, ids = resid(14, texts[0])
    f_all = sae.encode(x[1:].to(sae.w_enc.device)); peak = f_all.max(0).values; feat = int(torch.argmax(peak)); thr = float(sae.threshold[feat])
    res = []
    prompts = [be.chat(texts[0]), be.chat(texts[0])]
    for tgt in (thr*1.5, thr*3):
        cap = []
        be.forward_logits(prompts, [[Op("clamp", feature=feat, value=tgt)], []], capture=cap)
        got = sae.encode(cap[0][0].float().to(sae.w_enc.device), torch.tensor([feat]).to(sae.w_enc.device))[:, 0]
        res.append({"target": tgt, "max_abs_error": float((got[1:]-tgt).abs().max())})
    print(json.dumps({"float32_clamp": {"feature": feat, "threshold": thr, "results": res}, "fvu_l0_norm_float32": fvu(x[1:].to(sae.w_enc.device))}, indent=1))
