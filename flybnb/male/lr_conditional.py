"""The individual-variability model of the MALE brain, calibrated the way the female one was.

  python flybnb/male/lr_conditional.py --edges connectome-weights-male-cns-v1.0-minconf-0.5.feather --annotations body-annotations-male-cns-v1.0-minconf-0.5.feather

The two hemispheres of one brain are two samples of the same wiring plan. For cell types with exactly one neuron on each
side, every connection between two such types exists once per side (and once per crossing direction): given the count on
one side, the distribution of its mirror image on the other is what "another individual" looks like, as far as one brain
can say. Per bin of the given count: mean, variance, and the negative-binomial shape r. A sampled INDIVIDUAL gets half
of a pair's variance (two individuals differ by a pair's worth), around the count it was given, which is what the
sampler draws around: r_ind = c^2 / (Var_pair / 2 - c), c the bin's mean given count. This is the female table's
derivation (423, 479, 677, ... for FlyWire), repeated so that the two are comparable. That table, in the
recipe's units (r * 256), is what a FLYDELTA recipe of the male collection carries.
"""
import os, json, argparse, numpy as np, pandas as pd, pyarrow.feather as pf
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
ap = argparse.ArgumentParser(); ap.add_argument("--edges", required=True); ap.add_argument("--annotations", required=True); ap.add_argument("--out", default=os.path.join(ROOT, "flybnb/results/male/lr_conditional")); a = ap.parse_args()
ann = pf.read_table(a.annotations, columns=["bodyId", "type", "somaSide", "rootSide", "superclass"]).to_pandas(); ann["side"] = ann.somaSide.fillna(ann.rootSide); ann = ann[ann.side.isin(["L", "R"]) & ann.type.notna()]
census = ann.groupby(["type", "side"]).size().unstack(fill_value=0); one2one = set(census[(census["L"] == 1) & (census["R"] == 1)].index)
e = pf.read_table(a.edges, columns=["body_pre", "body_post", "weight"]).to_pandas(); info = ann.set_index("bodyId")[["type", "side"]]
e = e.join(info.rename(columns={"type": "pre_type", "side": "pre_side"}), on="body_pre").join(info.rename(columns={"type": "post_type", "side": "post_side"}), on="body_post").dropna()
e = e[e.pre_type.isin(one2one) & e.post_type.isin(one2one)]; e["cross"] = (e.pre_side != e.post_side).astype(int)
g = e.groupby(["pre_type", "post_type", "cross", "pre_side"])["weight"].sum().unstack("pre_side", fill_value=0).astype(float)
Lc = np.concatenate([g["L"].values, g["R"].values]); Rc = np.concatenate([g["R"].values, g["L"].values])   # symmetrised: "given one side" is not tied to the left
edges = [1, 2, 3, 5, 8, 12, 20, 35, 60, 100, 200, 1e9]; rows = []
for lo, hi in zip(edges[:-1], edges[1:]):
    s = (Lc >= lo) & (Lc < hi); R = Rc[s]; m, v = float(R.mean()), float(R.var()); vi = v / 2; gm = float(Lc[s].mean())
    rows.append({"given": f"{int(lo)}-{int(hi) - 1 if hi < 1e9 else 'inf'}", "c_from": int(lo), "n": int(s.sum()), "other_mean": m, "other_over_given": m / float(Lc[s].mean()), "other_var": v, "var_over_mean": v / m,
                 "nb_r_pair": m * m / (v - m) if v > m else None, "given_mean": gm, "nb_r_individual": gm * gm / (vi - gm) if vi > gm else None, "p_other_zero": float((R == 0).mean()), "p_other_below5": float((R < 5).mean())})
table = [[r["c_from"], int(round(r["nb_r_individual"] * 256))] for r in rows[:-1] if r["nb_r_individual"]]   # the open-ended last bin is dominated by a few giant connections: the female table stops before it too
out = {"one_to_one_types": len(one2one), "mirror_pairs": int(len(g)), "bins": rows, "r_table_q8": table, "mean_ratio_large_counts": float(np.mean([r["other_over_given"] for r in rows if r["c_from"] >= 20]))}
json.dump(out, open(a.out + ".json", "w"), indent=1)
md = [f"{len(one2one)} cell types with one neuron per side; {len(g)} mirrored connections.\n", "| given count | n | E[other] | E[other]/given | var/mean | NB r (pair) | NB r (individual) | P(other = 0) | P(other < 5) |", "|---|---|---|---|---|---|---|---|---|"]
md += [f"| {r['given']} | {r['n']} | {r['other_mean']:.2f} | {r['other_over_given']:.2f} | {r['var_over_mean']:.2f} | " + ("n/a" if r["nb_r_pair"] is None else f"{r['nb_r_pair']:.2f}") + " | " + ("n/a" if r["nb_r_individual"] is None else f"{r['nb_r_individual']:.2f}") + f" | {r['p_other_zero']:.3f} | {r['p_other_below5']:.3f} |" for r in rows]
md += ["", f"r table for recipes (c_from, r x 256): {table}"]; open(a.out + ".md", "w").write("\n".join(md) + "\n"); print("\n".join(md))
