"""The breeding pilot: is a circuit phenotype transmitted by the FLYDELTAv3 cross, and does selection move it?

  python flybnb/analysis/breeding_report.py [--rows flybnb/results/breeding/rows.jsonl] [--design flybnb/results/breeding/design.json]

The assay is deterministic: for fixed stimulus seeds a phenotype is a function of the wiring and of nothing else, so ALL
of its variance between individuals is genetic (broad-sense H^2 = 1 by construction). What is not given is how much of it
a parent passes on. Under this cross an offspring takes each connection from one parent or the other and then redraws
one connection in eight around the base, so a purely ADDITIVE phenotype regresses on the midparent with slope 7/8 =
0.875. That is an expectation for additive phenotypes, not a bound: a phenotype that is a convex function of an additive
liability (a thresholded response, say) can regress more steeply. The slope actually measured is the narrow-sense
heritability h^2 of the phenotype under this cross; a slope well below 0.875 means that much of the phenotype lives in
interactions between connections, which recombination breaks up.

Three numbers per phenotype: h^2 from the midparent regression over the randomly mated offspring; the realised h^2 =
R / S of the divergent selection lines (selected on DNge145 under `sound`); and, for every OTHER phenotype, the
correlated response to that selection, which is what a trade-off would look like.
"""
import os, json, argparse, numpy as np
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
ap = argparse.ArgumentParser(); ap.add_argument("--rows", default=os.path.join(ROOT, "flybnb/results/breeding/rows.jsonl")); ap.add_argument("--design", default=os.path.join(ROOT, "flybnb/results/breeding/design.json"))
ap.add_argument("--battery", default=os.path.join(ROOT, "flybnb/battery/battery-v1.json")); ap.add_argument("--out", default=os.path.join(ROOT, "flybnb/results/breeding/heritability")); a = ap.parse_args()
bat = json.load(open(a.battery)); design = json.load(open(a.design)); R = {r["id"]: r for r in map(json.loads, open(a.rows))}
G = json.load(open(os.path.join(ROOT, "flybnb/analysis/groups_flywire783.json"))); dn = bat["readout"]["neuron_index"]; dpos = {i: k for k, i in enumerate(dn)}; types = bat["readout"]["cell_type"]
stims = [s["name"] for s in bat["stimuli"]]; nD = len(dn)
def dnvec(r, stim):
    v = np.zeros(nD)
    for x in r["rows"]:
        if x["stim"] == stim: v[x["dn_i"]] += np.array(x["dn_c"], dtype=float)
    return v / len(bat["seeds"])
def scalar(r, stim, key): return float(np.mean([x[key] for x in r["rows"] if x["stim"] == stim]))
ids = list(R); V = {i: {s: dnvec(R[i], s) for s in stims} for i in ids}
founders = [i for i in ids if R[i]["kind"] == "founder"]; crosses = [i for i in ids if R[i]["kind"] == "cross" and R[i]["a"] in R and R[i]["b"] in R]
rand = [i for i in crosses if R[i]["line"] == "random"]; high = [i for i in crosses if R[i]["line"] == "high"]; low = [i for i in crosses if R[i]["line"] == "low"]
# ---- phenotypes: named cell types under sound, per-stimulus aggregates, and every descending cell type that varies among founders
P = {}
for name, grp in [("DNge145", "DNge145"), ("giant fibre", "GF"), ("DNp12", "DNp12")]:
    k = [dpos[i] for i in G[grp] if i in dpos]
    if k: P[f"{name} | sound"] = {i: float(V[i]["sound"][k].sum()) for i in ids}
    if k and name == "DNge145": P["gate suppression of DNge145 (sound - sound_gate)"] = {i: float(V[i]["sound"][k].sum() - V[i]["sound_gate"][k].sum()) for i in ids}
for s in stims:
    P[f"descending spikes, all | {s}"] = {i: float(V[i][s].sum()) for i in ids}; P[f"descending neurons active | {s}"] = {i: float((V[i][s] > 0).sum()) for i in ids}; P[f"neurons reached | {s}"] = {i: scalar(R[i], s, "active") for i in ids}
tset = sorted({t for t in types if t}); tidx = {t: [k for k, x in enumerate(types) if x == t] for t in tset}
for s in stims:
    for t in tset:
        f = np.array([V[i][s][tidx[t]].sum() for i in founders])
        if (f > 0).mean() >= 0.5 and f.std() > 0: P[f"{t} | {s}"] = {i: float(V[i][s][tidx[t]].sum()) for i in ids}
def h2(ph):
    x = np.array([(ph[R[i]["a"]] + ph[R[i]["b"]]) / 2 for i in rand]); y = np.array([ph[i] for i in rand])
    if len(x) < 10 or x.std() == 0: return None
    b, c = np.polyfit(x, y, 1); res = y - (b * x + c); se = float(np.sqrt(res.var(ddof=2) / ((x - x.mean()) ** 2).sum())); return float(b), se, float(np.corrcoef(x, y)[0, 1])
out = {"individuals": {"founders": len(founders), "random": len(rand), "high": len(high), "low": len(low)}, "additive_expectation": 0.875, "phenotypes": {}}
fm = lambda ph, g: float(np.mean([ph[i] for i in g])) if g else None
for name, ph in P.items():
    r = h2(ph); f = np.array([ph[i] for i in founders]); sd = float(f.std(ddof=1)) if len(f) > 1 else 0.0
    out["phenotypes"][name] = {"founder_mean": float(f.mean()), "founder_sd": sd, "h2": None if r is None else r[0], "h2_se": None if r is None else r[1], "r_midparent": None if r is None else r[2],
        "random_offspring_mean": fm(ph, rand), "high_line_mean": fm(ph, high), "low_line_mean": fm(ph, low), "divergence_in_founder_sd": None if not (high and low and sd > 0) else (fm(ph, high) - fm(ph, low)) / sd}
# ---- the selected trait: response against differential, in the battery's own measurement of the parents
sel = "DNge145 | sound"
if sel in P and high and low:
    ph = P[sel]; mu = fm(ph, founders); hp = [design_id for design_id in design["high"] if design_id in R]; lp = [x for x in design["low"] if x in R]
    S_hi, S_lo = fm(ph, hp) - mu, fm(ph, lp) - mu; R_hi, R_lo = fm(ph, high) - mu, fm(ph, low) - mu
    out["selection"] = {"trait": sel, "founder_mean": mu, "S_high": S_hi, "R_high": R_hi, "S_low": S_lo, "R_low": R_lo, "realised_h2_high": R_hi / S_hi, "realised_h2_low": R_lo / S_lo, "realised_h2_divergent": (R_hi - R_lo) / (S_hi - S_lo), "regression_h2": out["phenotypes"][sel]["h2"]}
# ---- correlated responses, tested: Welch's t between the two lines for every phenotype, Benjamini-Hochberg across all of them
from math import erf, sqrt
names = [k for k in P if high and low]; tt = []
for k in names:
    x = np.array([P[k][i] for i in high]); y = np.array([P[k][i] for i in low]); se = sqrt(x.var(ddof=1) / len(x) + y.var(ddof=1) / len(y))
    t = (x.mean() - y.mean()) / se if se > 0 else 0.0; tt.append(t)
pv = np.array([2 * (1 - 0.5 * (1 + erf(abs(t) / sqrt(2)))) for t in tt])   # normal approximation: 50 + 50 offspring
order = np.argsort(pv); q = np.empty(len(pv)); m = len(pv); run = 1.0
for rank, j in list(enumerate(order, 1))[::-1]: run = min(run, pv[j] * m / rank); q[j] = run
for k, t, p_, q_ in zip(names, tt, pv, q): out["phenotypes"][k].update({"lines_t": float(t), "lines_p": float(p_), "lines_q": float(q_)})
own = [k for k in names if k.startswith("DNge145") or k.startswith("gate suppression")]
sig = [k for k in names if out["phenotypes"][k]["lines_q"] < 0.05]; out["correlated_responses"] = {"tested": len(names), "q_below_0.05": len(sig), "of_which_not_DNge145": len([k for k in sig if k not in own]),
    "largest_not_DNge145": sorted(({"phenotype": k, "high_minus_low_in_founder_sd": out["phenotypes"][k]["divergence_in_founder_sd"], "q": out["phenotypes"][k]["lines_q"]} for k in sig if k not in own), key=lambda d: -abs(d["high_minus_low_in_founder_sd"] or 0))[:12]}
steep = [k for k, v in out["phenotypes"].items() if v["h2"] is not None and v["h2"] - 2 * v["h2_se"] > 0.875]; flat = [k for k, v in out["phenotypes"].items() if v["h2"] is not None and v["h2"] + 2 * v["h2_se"] < 0.875]
out["against_additive_expectation"] = {"clearly_above": len(steep), "clearly_below": len(flat), "consistent": len([v for v in out["phenotypes"].values() if v["h2"] is not None]) - len(steep) - len(flat)}
hs = np.array([v["h2"] for v in out["phenotypes"].values() if v["h2"] is not None]); out["h2_distribution"] = {"n": int(len(hs)), "median": float(np.median(hs)) if len(hs) else None, "q25": float(np.quantile(hs, .25)) if len(hs) else None, "q75": float(np.quantile(hs, .75)) if len(hs) else None, "above_0.5": float((hs > .5).mean()) if len(hs) else None}
json.dump(out, open(a.out + ".json", "w"), indent=1)
L = [f"# Breeding pilot: {len(founders)} founders, {len(rand)} randomly mated offspring, {len(high)} + {len(low)} offspring of the divergent selection lines\n",
     f"Additive expectation under this cross (one connection in eight is redrawn): 0.875. {out['h2_distribution']['n']} phenotypes; h² median {out['h2_distribution']['median']:.2f} (quartiles {out['h2_distribution']['q25']:.2f} to {out['h2_distribution']['q75']:.2f}); {100 * out['h2_distribution']['above_0.5']:.0f}% above 0.5.\n" if len(hs) else ""]
if "selection" in out: s = out["selection"]; L += [f"**Selection on {s['trait']}** (founder mean {s['founder_mean']:.2f}). High line: parents +{s['S_high']:.2f}, offspring {s['R_high']:+.2f}, realised h² {s['realised_h2_high']:.2f}. Low line: parents {s['S_low']:.2f}, offspring {s['R_low']:+.2f}, realised h² {s['realised_h2_low']:.2f}. Divergent: {s['realised_h2_divergent']:.2f}. Midparent regression: {s['regression_h2']:.2f}.\n"]
if "correlated_responses" in out: c = out["correlated_responses"]; ae = out["against_additive_expectation"]; L += [f"**Against the additive expectation (slope ± 2 SE):** {ae['clearly_below']} phenotypes clearly below 0.875, {ae['consistent']} consistent with it, {ae['clearly_above']} clearly above.\n",
    f"**Correlated responses.** Of {c['tested']} phenotypes, {c['q_below_0.05']} differ between the high and the low line at FDR 0.05; {c['of_which_not_DNge145']} of them are not DNge145 phenotypes. The largest: " + "; ".join(f"{d['phenotype']} ({d['high_minus_low_in_founder_sd']:+.2f} SD)" for d in c["largest_not_DNge145"][:8]) + ".\n"]
key = [k for k in out["phenotypes"] if "|" not in k or k.split(" | ")[0] in ("DNge145", "giant fibre", "DNp12") or k.startswith("descending spikes, all")]
L += ["| phenotype | founder mean ± SD | h² (midparent slope ± SE) | high line | low line | high − low, in founder SDs |", "|---|---|---|---|---|---|"]
for k in key:
    v = out["phenotypes"][k]; L.append(f"| {k} | {v['founder_mean']:.2f} ± {v['founder_sd']:.2f} | " + ("n/a" if v["h2"] is None else f"{v['h2']:.2f} ± {v['h2_se']:.2f}") + f" | {v['high_line_mean'] if v['high_line_mean'] is None else round(v['high_line_mean'], 2)} | {v['low_line_mean'] if v['low_line_mean'] is None else round(v['low_line_mean'], 2)} | " + ("n/a" if v["divergence_in_founder_sd"] is None else f"{v['divergence_in_founder_sd']:+.2f}") + " |")
open(a.out + ".md", "w").write("\n".join(L) + "\n"); print("\n".join(L[:3])); print(f"... {len(out['phenotypes'])} phenotypes -> {a.out}.json / .md")
