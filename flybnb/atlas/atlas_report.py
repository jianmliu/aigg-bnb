"""The first slice of the atlas: which silencing effects found on ONE brain would be found on another?

  python flybnb/atlas/atlas_report.py [--rows flybnb/results/atlas/rows.jsonl] [--base-payload flywire-783-min2.bin]

An EFFECT is (silenced cell type, stimulus, readout): the change in a descending cell type's spikes (last 250 ms) when the
silenced type is removed, against the same individual's unperturbed run under the same seed. A study of one brain DETECTS
it when all seeds agree in sign and the mean change is at least one spike. That rule is applied to the base wiring -- the
published connectome, the brain every simulation paper uses -- and then, unchanged, to every individual: an effect's
REPLICATION RATE is the fraction of individuals in which the same study would have reported the same effect. Silencing
the readout itself is left out (it is not a finding), and silencing part of the stimulus is reported separately.
"""
import os, sys, json, argparse, numpy as np
HERE = os.path.dirname(os.path.abspath(__file__)); ROOT = os.path.dirname(os.path.dirname(HERE))
ap = argparse.ArgumentParser(); ap.add_argument("--rows", default=os.path.join(ROOT, "flybnb/results/atlas/rows.jsonl.gz")); ap.add_argument("--battery", default=os.path.join(ROOT, "flybnb/battery/battery-v1.json"))
ap.add_argument("--celltypes", default=os.path.join(HERE, "celltypes-flywire783.json")); ap.add_argument("--base-payload", default=os.environ.get("FLYBNB_BASE")); ap.add_argument("--out", default=os.path.join(ROOT, "flybnb/results/atlas/robustness")); ap.add_argument("--min-effect", type=float, default=1.0); a = ap.parse_args()
import gzip
opener = lambda p: gzip.open(p, "rt") if p.endswith(".gz") else open(p)
bat = json.load(open(a.battery)); ct = json.load(open(a.celltypes)); R = {r["id"]: r for r in map(json.loads, opener(a.rows))}
dn = np.array(bat["readout"]["neuron_index"]); tn = np.array(ct["type_of_neuron"]); dtype = tn[dn]; rtypes = sorted({int(t) for t in dtype if t >= 0}); rpos = {t: k for k, t in enumerate(rtypes)}
M = np.zeros((len(rtypes), len(dn))); [M.__setitem__((rpos[int(t)], j), 1.0) for j, t in enumerate(dtype) if t >= 0]   # descending neurons -> descending cell types
def vec(i, c): v = np.zeros(len(dn)); v[i] = c; return M @ v
def effects(r):
    """{(stim, silenced type): array [seeds x readout types] of perturbed - unperturbed}; a type not active under a seed has effect 0 there, exactly"""
    seeds = sorted({c["seed"] for c in r["cells"]}); out = {}; stimd = {}
    for c in r["cells"]:
        u = vec(c["dn_i"], c["dn_c"]); si = seeds.index(c["seed"])
        for s in c["silenced"]:
            key = (c["stim"], s["t"]); out.setdefault(key, np.zeros((len(seeds), len(rtypes))))[si] = vec(s["dn_i"], s["dn_c"]) - u; stimd[key] = s["stimulated"]
    return out, stimd
def detected(E): m = E.mean(0); same = (np.sign(E) == np.sign(m)[None, :]).all(0); return same & (np.abs(m) >= a.min_effect), m
E = {}; STIM = {}
for i, r in R.items(): E[i], sd = effects(r); STIM.update(sd)
base = "BASE"; inds = [i for i in R if i != base]; nI = len(inds); found = []
for key, Eb in E[base].items():
    det, m = detected(Eb)
    for k in np.flatnonzero(det):
        if rtypes[k] == key[1]: continue   # silencing the readout itself
        rep = 0; same_sign = 0; sizes = []
        for i in inds:
            Ei = E[i].get(key); di, mi = detected(Ei) if Ei is not None else (np.zeros(len(rtypes), bool), np.zeros(len(rtypes)))
            ok = bool(di[k]) and np.sign(mi[k]) == np.sign(m[k]); rep += ok; same_sign += np.sign(mi[k]) == np.sign(m[k]); sizes.append(float(mi[k]))
        found.append({"stimulus": key[0], "silenced": ct["types"][key[1]], "silenced_is_stimulated": bool(STIM[key]), "readout": ct["types"][rtypes[k]], "base_effect": float(m[k]), "replication": rep / nI if nI else None,
                      "same_sign": same_sign / nI if nI else None, "individual_mean": float(np.mean(sizes)) if sizes else None, "individual_sd": float(np.std(sizes, ddof=1)) if len(sizes) > 1 else None, "_key": [key[0], int(key[1]), int(rtypes[k])]})
# effects a study of the base would MISS: detected in most individuals, not on the base
miss = {}
for i in inds:
    for key, Ei in E[i].items():
        det, mi = detected(Ei)
        for k in np.flatnonzero(det):
            if rtypes[k] != key[1]: miss[(key[0], key[1], rtypes[k], int(np.sign(mi[k])))] = miss.get((key[0], key[1], rtypes[k], int(np.sign(mi[k]))), 0) + 1
got = {(f["_key"][0], f["_key"][1], f["_key"][2], int(np.sign(f["base_effect"]))) for f in found}
missed = sorted(({"stimulus": k[0], "silenced": ct["types"][k[1]], "readout": ct["types"][k[2]], "sign": k[3], "detected_in": v / nI} for k, v in miss.items() if k not in got and nI and v / nI >= 0.5), key=lambda d: -d["detected_in"])
# the same question without giving the base a special place: take each INDIVIDUAL as the one brain studied, and ask the other individuals.
# (An effect is selected for being detected on the brain studied, so some of its shrinkage elsewhere is selection; that is true of any single-brain study, and it is the same here whichever brain is taken.)
pairwise = None
if nI > 1:
    keys = sorted({k for i in inds for k in E[i] if not STIM[k]}); D = np.zeros((nI, len(keys), len(rtypes)), np.int8)
    for x, i in enumerate(inds):
        for y, key in enumerate(keys):
            if key in E[i]: det, mi = detected(E[i][key]); D[x, y] = np.where(det, np.sign(mi), 0)
            if key in E[i] and key[1] in rpos: D[x, y, rpos[key[1]]] = 0   # silencing the readout itself
    per = []; counts = []
    for x in range(nI):
        m = D[x] != 0; counts.append(int(m.sum()))
        if m.any(): per.append(((D[:, m] == D[x][m][None, :]).sum(0) - 1) / (nI - 1))
    allr = np.concatenate(per); pairwise = {"effects_per_individual_median": float(np.median(counts)), "effects_per_individual_range": [int(min(counts)), int(max(counts))], "replication_in_another_individual": {"mean": float(allr.mean()), "median": float(np.median(allr)), "at_least_0.8": float((allr >= .8).mean()), "at_most_0.2": float((allr <= .2).mean())}}
# H2, a first look: does the wiring between the silenced type and the readout predict replication?
if a.base_payload and found:
    sys.path.insert(0, os.path.join(ROOT, "flybnb", "analysis")); import intlif as IL; B = IL.FD.decode_payload(open(a.base_payload, "rb").read()); c = np.abs(B["w"]).astype(np.int64); c = np.where(c >= 5, c, 0); tp, tq = tn[B["pre"]], tn[B["post"]]
    for f in found: m = (tp == f["_key"][1]) & (tq == f["_key"][2]) & (c > 0); f["direct_records"] = int(m.sum()); f["direct_synapses"] = int(c[m].sum())
rep = np.array([f["replication"] for f in found if not f["silenced_is_stimulated"]]) if nI else np.array([])
def dist(x): return None if not len(x) else {"n": int(len(x)), "median": float(np.median(x)), "at_least_0.8": float((x >= .8).mean()), "at_most_0.2": float((x <= .2).mean()), "deciles": [int(((x >= lo / 10) & ((x < (lo + 1) / 10) | (lo == 9))).sum()) for lo in range(10)]}
out = {"individuals": nI, "detection_rule": f"all seeds agree in sign and mean |change| >= {a.min_effect} spike", "effects_detected_on_base": len(found), "of_which_silencing_part_of_the_stimulus": int(sum(f["silenced_is_stimulated"] for f in found)),
       "replication_central": dist(rep), "replication_stimulus": dist(np.array([f["replication"] for f in found if f["silenced_is_stimulated"]])) if nI else None, "missed_by_the_base": {"n": len(missed), "top": missed[:15]}, "any_individual_as_the_brain_studied": pairwise}
if nI and len(rep) > 5:
    from scipy.stats import spearmanr; C = [f for f in found if not f["silenced_is_stimulated"]]
    out["what_predicts_replication"] = {"abs_base_effect": float(spearmanr([abs(f["base_effect"]) for f in C], [f["replication"] for f in C])[0])}
    if "direct_synapses" in C[0]: out["what_predicts_replication"].update({"direct_synapses": float(spearmanr([f["direct_synapses"] for f in C], [f["replication"] for f in C])[0]), "effects_with_a_direct_connection": float(np.mean([f["direct_records"] > 0 for f in C])),
        "replication_with_direct": float(np.mean([f["replication"] for f in C if f["direct_records"] > 0] or [np.nan])), "replication_without_direct": float(np.mean([f["replication"] for f in C if f["direct_records"] == 0] or [np.nan]))})
# replication by the size of the effect on the base: a one-spike effect and a thirty-spike effect are not the same claim
if nI:
    C = [f for f in found if not f["silenced_is_stimulated"]]; bins = [(1, 2), (2, 5), (5, 10), (10, 1e9)]
    out["replication_by_base_effect"] = [{"abs_effect": f"{lo:g}-{hi:g}" if hi < 1e9 else f">= {lo:g}", "n": len(g), "median_replication": float(np.median([f["replication"] for f in g])) if g else None, "median_same_sign": float(np.median([f["same_sign"] for f in g])) if g else None,
        "replicate_in_80pct": float(np.mean([f["replication"] >= .8 for f in g])) if g else None} for lo, hi in bins for g in [[f for f in C if lo <= abs(f["base_effect"]) < hi]]]
for f in found: f.pop("_key")
out["effects"] = sorted(found, key=lambda f: (-abs(f["base_effect"])))
json.dump(out, open(a.out + ".json", "w"), indent=1)
L = [f"# Atlas, first slice: silencing under `sound`, base wiring against {nI} individuals\n", f"Detection rule: {out['detection_rule']}. {len(found)} effects detected on the base wiring ({out['of_which_silencing_part_of_the_stimulus']} of them by silencing part of the stimulus).\n"]
if out["replication_central"]: d = out["replication_central"]; L += [f"**Replication of the {d['n']} central effects:** median {d['median']:.2f}; {100 * d['at_least_0.8']:.0f}% replicate in at least 80% of individuals, {100 * d['at_most_0.2']:.0f}% in at most 20%. Deciles (0-10% ... 90-100%): {d['deciles']}.\n",
    f"**Missed by the base:** {out['missed_by_the_base']['n']} effects are detected in at least half of the individuals and not on the base wiring.\n"]
if pairwise: q = pairwise["replication_in_another_individual"]; L += [f"**Any individual as the brain studied** (central effects): {pairwise['effects_per_individual_median']:.0f} effects per individual (range {pairwise['effects_per_individual_range'][0]}-{pairwise['effects_per_individual_range'][1]}); an effect found in one individual is found in another with probability {q['mean']:.2f} (median over effects {q['median']:.2f}; {100 * q['at_least_0.8']:.0f}% in at least 80% of the others, {100 * q['at_most_0.2']:.0f}% in at most 20%).\n"]
if out.get("replication_by_base_effect"): L += ["| size of the effect on the base (spikes) | effects | median replication | median same sign | replicate in >= 80% |", "|---|---|---|---|---|"] + [f"| {b['abs_effect']} | {b['n']} | " + ("n/a" if b["median_replication"] is None else f"{b['median_replication']:.2f} | {b['median_same_sign']:.2f} | {100 * b['replicate_in_80pct']:.0f}%") + " |" for b in out["replication_by_base_effect"]] + [""]
if "what_predicts_replication" in out: L += ["**What predicts replication (Spearman):** " + ", ".join(f"{k} {v:+.2f}" if "replication_" not in k and "effects_" not in k else f"{k} {v:.2f}" for k, v in out["what_predicts_replication"].items()) + "\n"]
L += ["| silenced | readout | base effect | replication | same sign | mean ± SD over individuals |", "|---|---|---|---|---|---|"] + [f"| {f['silenced']}{' (stimulus)' if f['silenced_is_stimulated'] else ''} | {f['readout']} | {f['base_effect']:+.1f} | " + ("n/a" if f["replication"] is None else f"{f['replication']:.2f}") + " | " + ("n/a" if f["same_sign"] is None else f"{f['same_sign']:.2f}") + " | " + ("n/a" if f["individual_sd"] is None else f"{f['individual_mean']:+.1f} ± {f['individual_sd']:.1f}") + " |" for f in out["effects"][:40]]
open(a.out + ".md", "w").write("\n".join(L) + "\n"); print("\n".join(L[:4])); print(f"-> {a.out}.json / .md")
