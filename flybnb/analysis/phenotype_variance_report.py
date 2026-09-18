"""FlyBnB pilot, variance components (phenotype_variance.py): individuals x seeds, one run per cell per stimulus.

Two-way crossed layout without replication. The simulator is deterministic, so the residual IS the individual x seed interaction:
  sigma2_ind  = (MS_ind  - MS_res) / S      sigma2_seed = (MS_seed - MS_res) / I      sigma2_res = MS_res
  ICC1  = sigma2_ind / (sigma2_ind + sigma2_seed + sigma2_res)   repeatability of ONE 0.5 s assay under an unknown stimulus train
  ICC_S = sigma2_ind / (sigma2_ind + sigma2_res / S)             repeatability of the S-seed mean (the same trains for everyone)
Every founder's wiring is its genotype, so ICC is the broad-sense heritability of the assay in this population. It says nothing yet
about the narrow-sense heritability under the FLYDELTAv3 cross (that needs parent-offspring pairs)."""
import sys, os, json, numpy as np
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))); D = os.path.join(ROOT, "flybnb/results/pilot")   # the aigg-bnb checkout
rows = [json.loads(l) for l in open(os.path.join(D, "runs.jsonl"))]; rows.sort(key=lambda r: r["ind"])
inds = [r["ind"] for r in rows]; seeds = sorted({x["seed"] for x in rows[0]["rows"]}); I, S = len(inds), len(seeds)
def cell(r, stim, seed): return next(x for x in r["rows"] if x["stim"] == stim and x["seed"] == seed)
def table(f): return np.array([[f(r, s) for s in seeds] for r in rows], dtype=float)
PH = {
  "DNge145, sound only (spikes / 250 ms)":        lambda r, s: sum(cell(r, "joLR", s)["DNge145"]),
  "DNge145, sound + gate":                         lambda r, s: sum(cell(r, "joLR+gate", s)["DNge145"]),
  "gate suppression of DNge145 (paired difference)": lambda r, s: sum(cell(r, "joLR", s)["DNge145"]) - sum(cell(r, "joLR+gate", s)["DNge145"]),
  "giant fibre, sound only":                       lambda r, s: sum(cell(r, "joLR", s)["GF"]),
  "giant fibre, sound + gate":                     lambda r, s: sum(cell(r, "joLR+gate", s)["GF"]),
  "gate effect on giant fibre (paired difference)": lambda r, s: sum(cell(r, "joLR+gate", s)["GF"]) - sum(cell(r, "joLR", s)["GF"]),
  "DNp12, sound only":                             lambda r, s: sum(cell(r, "joLR", s)["DNp12"]),
  "listening layer (38 locked cells), sound only": lambda r, s: sum(cell(r, "joLR", s)["locked38"]),
  "listening layer, sound + gate":                 lambda r, s: sum(cell(r, "joLR+gate", s)["locked38"]),
  "whole-brain spikes, sound only (0.5 s)":        lambda r, s: cell(r, "joLR", s)["total"],
  "active neurons, sound only":                    lambda r, s: cell(r, "joLR", s)["active"],
}
def components(X):
    I, S = X.shape; gm = X.mean(); ri = X.mean(1); cj = X.mean(0)
    ms_i = S * ((ri - gm) ** 2).sum() / (I - 1); ms_s = I * ((cj - gm) ** 2).sum() / (S - 1)
    res = X - ri[:, None] - cj[None, :] + gm; ms_r = (res ** 2).sum() / ((I - 1) * (S - 1))
    v_i = max(0.0, (ms_i - ms_r) / S); v_s = max(0.0, (ms_s - ms_r) / I); tot = v_i + v_s + ms_r
    F = ms_i / ms_r if ms_r > 0 else float("inf"); p = None
    try:
        from scipy import stats; p = float(stats.f.sf(F, I - 1, (I - 1) * (S - 1)))
    except Exception: pass
    return dict(mean=gm, sd_between_individual_means=float(ri.std(ddof=1)), min_ind=float(ri.min()), max_ind=float(ri.max()), var_ind=v_i, var_seed=v_s, var_res=ms_r,
                icc1=(v_i / tot if tot > 0 else 0.0), icc_mean=(v_i / (v_i + ms_r / S) if v_i + ms_r > 0 else 0.0), F=F, p=p)
founders = [k for k, r in enumerate(rows) if r["ind"] != 0]; base = next(k for k, r in enumerate(rows) if r["ind"] == 0)
out = {"individuals": len(founders), "seeds": S, "phenotypes": {}}
for name, f in PH.items():
    X = table(f); c = components(X[founders]); c["base_individual_mean"] = float(X[base].mean()); c["base_percentile"] = float((X[founders].mean(1) < X[base].mean()).mean() * 100)
    out["phenotypes"][name] = c
# the gate as a binary trait, and its wiring
sil = np.array([[sum(cell(r, "joLR+gate", s)["DNge145"]) == 0 for s in seeds] for r in rows])[founders]
de = np.array([sum(rows[k]["geno"]["direct_edges"]) for k in founders], dtype=float); demin = np.array([min(rows[k]["geno"]["direct_edges"]) for k in founders], dtype=float)
leak = table(PH["DNge145, sound + gate"])[founders].mean(1)
out["gate"] = {"runs_fully_silenced": float(sil.mean()), "individuals_silenced_in_every_seed": float(sil.all(1).mean()), "individuals_never_silenced": float((~sil.any(1)).mean()),
               "direct_gate_synapses_base": rows[base]["geno"]["direct_edges"], "direct_gate_synapses_founders_mean_sd": [float(de.mean()), float(de.std(ddof=1))], "direct_gate_synapses_min_max": [float(de.min()), float(de.max())],
               "corr_leak_vs_direct_synapses": float(np.corrcoef(leak, de)[0, 1]) if leak.std() > 0 else None, "individuals_missing_a_direct_record": float((demin == 0).mean())}
g = [rows[k]["geno"] for k in founders]
out["genotype"] = {"records_mean": float(np.mean([x["records"] for x in g])), "records_base": rows[base]["geno"]["records"], "synapses_mean": float(np.mean([x["synapses"] for x in g])), "synapses_base": rows[base]["geno"]["synapses"],
                   "turnover_lost_mean": float(np.mean([x["lost"] for x in g])), "turnover_gained_mean": float(np.mean([x["gained"] for x in g]))}
json.dump(out, open(os.path.join(D, "variance.json"), "w"), indent=1)
L = [f"# Phenotype variance pilot: {len(founders)} founders x {S} stimulus seeds x 2 stimuli\n", "| phenotype | mean | base wiring (percentile) | SD between individuals | range of individual means | ICC, one assay | ICC, mean of seeds | F | p |", "|---|---|---|---|---|---|---|---|---|"]
for name, c in out["phenotypes"].items():
    L.append(f"| {name} | {c['mean']:.2f} | {c['base_individual_mean']:.2f} ({c['base_percentile']:.0f}) | {c['sd_between_individual_means']:.2f} | {c['min_ind']:.1f} - {c['max_ind']:.1f} | {c['icc1']:.2f} | {c['icc_mean']:.2f} | {c['F']:.1f} | {c['p']:.1e} |" if c["p"] is not None else f"| {name} | {c['mean']:.2f} | | | | {c['icc1']:.2f} | {c['icc_mean']:.2f} | {c['F']:.1f} | |")
L += ["", "Gate: " + json.dumps(out["gate"]), "", "Genotype: " + json.dumps(out["genotype"])]
open(os.path.join(D, "variance.md"), "w").write("\n".join(L) + "\n"); print("\n".join(L))
