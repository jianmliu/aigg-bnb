"""Association analysis: which connections decide a phenotype?

  python flybnb/analysis/association_report.py --features features.npz [--rows flybnb/results/breeding/rows.jsonl flybnb/results/association/rows.jsonl]

Individuals are unrelated founders (the crosses are left out: relatives are not independent samples). A phenotype is a
descending cell type's spikes under one stimulus, mean of the battery's seeds. Predictors are the individual's counts on
that stimulus's candidate connections (association_features.py). Two questions, per phenotype:

  which  : the marginal correlation of every candidate connection with the phenotype, Benjamini-Hochberg at 0.05.
  how much: ridge regression, 5-fold cross-validated R^2 -- out of sample, so it cannot be bought with parameters --
            from (a) the connections INTO the readout cells only, (b) every candidate connection of the stimulus.
            (a) is what a wiring-diagram reading of the phenotype would use. (b) - (a) is what the rest of the
            active network adds.
"""
import os, sys, json, argparse, numpy as np
from scipy import stats
from sklearn.linear_model import RidgeCV
from sklearn.model_selection import KFold, cross_val_predict
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
ap = argparse.ArgumentParser(); ap.add_argument("--features", required=True); ap.add_argument("--rows", nargs="+", default=[os.path.join(ROOT, "flybnb/results/breeding/rows.jsonl"), os.path.join(ROOT, "flybnb/results/association/rows.jsonl")])
ap.add_argument("--max-candidates", type=int, default=60000); ap.add_argument("--battery", default=os.path.join(ROOT, "flybnb/battery/battery-v1.json")); ap.add_argument("--celltypes", default=os.path.join(ROOT, "flybnb/atlas/celltypes-flywire783.json")); ap.add_argument("--out", default=os.path.join(ROOT, "flybnb/results/association/association")); a = ap.parse_args()
bat = json.load(open(a.battery)); ct = json.load(open(a.celltypes)); tn = np.array(ct["type_of_neuron"]); F = np.load(a.features, allow_pickle=False); fid = [str(x) for x in F["ids"]]; X = F["X"].astype(np.float64); pre, post, basec = F["pre"], F["post"], F["base_count"]
R = {}
for p in a.rows:
    for r in map(json.loads, open(p)):
        if r["kind"] == "founder": R[r["id"]] = r
ids = [i for i in fid if i in R]; rowi = np.array([fid.index(i) for i in ids]); X = X[rowi]; n = len(ids); print(f"{n} unrelated founders, {X.shape[1]} candidate connections", flush=True)
dn = np.array(bat["readout"]["neuron_index"]); dtype = tn[dn]; seeds = len(bat["seeds"]); tname = lambda t: ct["types"][t] if t >= 0 else "untyped"
def pheno(stim):
    V = np.zeros((n, len(dn)))
    for k, i in enumerate(ids):
        for x in R[i]["rows"]:
            if x["stim"] == stim: V[k, x["dn_i"]] += np.array(x["dn_c"], dtype=float)
    return V / seeds
def bh(p):
    o = np.argsort(p); q = np.empty(len(p)); run = 1.0; m = len(p)
    for rank in range(m, 0, -1): j = o[rank - 1]; run = min(run, p[j] * m / rank); q[j] = run
    return q
def cvr2(Xs, y):
    if Xs.shape[1] == 0: return 0.0
    Z = (Xs - Xs.mean(0)) / np.where(Xs.std(0) > 0, Xs.std(0), 1); pred = cross_val_predict(RidgeCV(alphas=np.logspace(0, 5, 11)), Z, y, cv=KFold(5, shuffle=True, random_state=0)); return float(1 - ((y - pred) ** 2).sum() / ((y - y.mean()) ** 2).sum())
def cvr2_screened(Xs, y, top=200):
    """ridge on the `top` connections most correlated with y, chosen INSIDE each training fold (choosing them on all the
    data would leak the held-out individuals into the choice). Ridge over all ~30,000 candidates with 600 individuals
    drowns a few informative connections in noise and predicts nothing; this is the fair version of "the whole network"."""
    if Xs.shape[1] == 0: return 0.0
    pred = np.zeros(len(y))
    for tr, te in KFold(5, shuffle=True, random_state=0).split(Xs):
        A = Xs[tr]; mu, sdv = A.mean(0), A.std(0); ok = sdv > 0; Z = (A[:, ok] - mu[ok]) / sdv[ok]; yc = y[tr] - y[tr].mean(); r = np.abs(Z.T @ yc) / (len(tr) * (yc.std() or 1)); pick = np.argsort(-r)[:top]
        m = RidgeCV(alphas=np.logspace(0, 5, 11)).fit(Z[:, pick], y[tr]); pred[te] = m.predict(((Xs[te][:, ok] - mu[ok]) / sdv[ok])[:, pick])
    return float(1 - ((y - pred) ** 2).sum() / ((y - y.mean()) ** 2).sum())
out = {"individuals": n, "candidate_connections": int(X.shape[1]), "phenotypes": [], "skipped": [], "ignition": []}
# Ignition is a phenotype of the individual: under a stimulus that leaves the base wiring sparse, some individuals tip into the
# high-activity state. Its rate per stimulus, from the runs themselves (neurons active, mean of the seeds, above 3,000).
for st in bat["stimuli"]:
    act = np.array([np.mean([x["active"] for x in R[i]["rows"] if x["stim"] == st["name"]]) for i in ids]); any_seed = np.array([max(x["active"] for x in R[i]["rows"] if x["stim"] == st["name"]) for i in ids])
    out["ignition"].append({"stimulus": st["name"], "base_regime": st["base_wiring"]["regime"], "base_reached": float(np.mean(st["base_wiring"]["neurons_reached"])), "median_active": float(np.median(act)), "ignites_on_average": float((act > 3000).mean()), "ignites_in_some_seed": float((any_seed > 3000).mean())})
for st in bat["stimuli"]:
    key = "member_" + st["name"]
    if key not in F.files: continue
    cols = np.flatnonzero(F[key])
    if len(cols) > a.max_candidates:   # the union of who is active is huge because SOME individuals ignite under this stimulus: see `ignition` below
        out["skipped"].append({"stimulus": st["name"], "candidates": int(len(cols))}); continue
    V = pheno(st["name"]); Xs = X[:, cols]; keep = Xs.std(0) > 0; cols = cols[keep]; Xs = Xs[:, keep]
    for t in sorted({int(x) for x in dtype if x >= 0}):
        k = np.flatnonzero(dtype == t); y = V[:, k].sum(1)
        if (y > 0).mean() < 0.5 or y.std() == 0: continue
        r = np.array([np.corrcoef(Xs[:, j], y)[0, 1] for j in range(Xs.shape[1])]); tt = r * np.sqrt((n - 2) / np.maximum(1e-12, 1 - r * r)); p = 2 * stats.t.sf(np.abs(tt), n - 2); q = bh(p); sig = np.flatnonzero(q < 0.05)
        direct = np.isin(post[cols], dn[k]); top = sig[np.argsort(-np.abs(r[sig]))][:5]
        out["phenotypes"].append({"stimulus": st["name"], "readout": tname(t), "mean": float(y.mean()), "sd": float(y.std(ddof=1)), "candidates": int(len(cols)), "significant": int(len(sig)), "significant_direct": int(direct[sig].sum()), "direct_candidates": int(direct.sum()),
            "r2_direct": cvr2(Xs[:, direct], y), "r2_all": cvr2_screened(Xs, y), "r2_all_not_direct": cvr2_screened(Xs[:, ~direct], y), "top": [{"pre": tname(int(tn[pre[cols[j]]])), "post": tname(int(tn[post[cols[j]]])), "base_count": int(basec[cols[j]]), "r": float(r[j]), "direct": bool(direct[j])} for j in top]})
    print(f"{st['name']:13s} {sum(1 for x in out['phenotypes'] if x['stimulus'] == st['name'])} phenotypes", flush=True)
P = out["phenotypes"]; rd = np.array([x["r2_direct"] for x in P]); ra = np.array([x["r2_all"] for x in P])
rn = np.array([x["r2_all_not_direct"] for x in P])
out["summary"] = {"phenotypes": len(P), "median_r2_without_direct": float(np.median(rn)), "median_r2_direct": float(np.median(rd)), "median_r2_all": float(np.median(ra)), "share_r2_all_above_0.5": float((ra > .5).mean()), "share_where_direct_explains_at_least_half_of_all": float((rd >= 0.5 * np.maximum(ra, 1e-9)).mean()),
                  "median_significant_connections": float(np.median([x["significant"] for x in P])), "share_of_significant_that_are_direct": float(sum(x["significant_direct"] for x in P) / max(1, sum(x["significant"] for x in P)))}
json.dump(out, open(a.out + ".json", "w"), indent=1); s = out["summary"]
L = [f"# Association: {n} unrelated founders, {X.shape[1]} candidate connections, {len(P)} phenotypes\n", f"Cross-validated R² from the connections INTO the readout cells: median {s['median_r2_direct']:.2f}. From the rest of the active network WITHOUT them: median {s['median_r2_without_direct']:.2f}. From every candidate connection of the stimulus (the 200 most correlated, chosen inside each training fold): median {s['median_r2_all']:.2f} ({100 * s['share_r2_all_above_0.5']:.0f}% of phenotypes above 0.5). The direct connections give at least half of that in {100 * s['share_where_direct_explains_at_least_half_of_all']:.0f}% of phenotypes.\n",
     "**Ignition is an individual phenotype.** Fraction of individuals in which a stimulus tips the network into its high-activity state (> 3,000 neurons active): " + "; ".join(f"{g['stimulus']} {100 * g['ignites_on_average']:.0f}%" for g in out["ignition"]) + ". The connection-level analysis below covers the stimuli under which nobody ignites; for the others the candidate set is the whole ignited network (" + ", ".join(f"{k['stimulus']} {k['candidates']:,}" for k in out["skipped"]) + " connections) and the question is a different one.\n",
     f"Significant connections per phenotype (FDR 0.05): median {s['median_significant_connections']:.0f}; {100 * s['share_of_significant_that_are_direct']:.0f}% of all significant connections are direct inputs of the readout.\n", "| stimulus | readout | mean ± SD | R² direct | R² all | significant (direct) | strongest connection |", "|---|---|---|---|---|---|---|"]
for x in sorted(P, key=lambda x: -x["r2_all"])[:40]: t = x["top"][0] if x["top"] else None; L.append(f"| {x['stimulus']} | {x['readout']} | {x['mean']:.1f} ± {x['sd']:.1f} | {x['r2_direct']:.2f} | {x['r2_all']:.2f} | {x['significant']} ({x['significant_direct']}) | " + (f"{t['pre']} → {t['post']} (base {t['base_count']}, r {t['r']:+.2f})" if t else "") + " |")
open(a.out + ".md", "w").write("\n".join(L) + "\n"); print("\n".join(L[:4]))
