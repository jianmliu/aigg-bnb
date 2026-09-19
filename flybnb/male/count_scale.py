"""How many male synapses is one female synapse? The scale between the two connectomes' counts.

  python flybnb/male/count_scale.py --male-edges ... --male-annotations ... --female-edges proofread_connections_783.feather --female-annotations annotations.tsv

The int-lif weight unit (0.275 mV per synapse) was set on FlyWire counts. MaleCNS was reconstructed with another synapse
detector and reports about twice as many synapses for the same connection, so under the same unit the male brain is
driven twice as hard and every stimulus ignites it. The male annotations carry `flywireType`, the matching FlyWire cell
type: for every pair of types present in both brains, the total count of the connection in each. The ratio is a property
of the two datasets, not of sex, and it is what a per-connectome weight unit has to absorb.
"""
import os, json, argparse, numpy as np, pandas as pd, pyarrow.feather as pf
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
ap = argparse.ArgumentParser(); ap.add_argument("--male-edges", required=True); ap.add_argument("--male-annotations", required=True); ap.add_argument("--female-edges", required=True); ap.add_argument("--female-annotations", required=True)
ap.add_argument("--out", default=os.path.join(ROOT, "flybnb/results/male/count_scale")); a = ap.parse_args()
ma = pf.read_table(a.male_annotations, columns=["bodyId", "flywireType", "superclass", "dimorphism"]).to_pandas(); ma = ma[ma.flywireType.notna()]
fa = pd.read_csv(a.female_annotations, sep="\t", low_memory=False, usecols=["root_id", "cell_type", "hemibrain_type"]); fa["t"] = fa.cell_type.fillna(fa.hemibrain_type); fa = fa[fa.t.notna()]
nm = ma.groupby("flywireType").size(); nf = fa.groupby("t").size(); shared = sorted(set(nm.index) & set(nf.index)); same_n = [t for t in shared if nm[t] == nf[t]]   # types with the same number of cells in both: a like-for-like comparison
me = pf.read_table(a.male_edges, columns=["body_pre", "body_post", "weight"]).to_pandas(); mt = ma.set_index("bodyId").flywireType
me["p"] = me.body_pre.map(mt); me["q"] = me.body_post.map(mt); me = me.dropna(subset=["p", "q"]); M = me[me.p.isin(same_n) & me.q.isin(same_n)].groupby(["p", "q"]).weight.sum()
fe = pf.read_table(a.female_edges, columns=["pre_pt_root_id", "post_pt_root_id", "syn_count"]).to_pandas(); ft = fa.set_index("root_id").t
fe["p"] = fe.pre_pt_root_id.map(ft); fe["q"] = fe.post_pt_root_id.map(ft); fe = fe.dropna(subset=["p", "q"]); F = fe[fe.p.isin(same_n) & fe.q.isin(same_n)].groupby(["p", "q"]).syn_count.sum()
J = pd.concat([M.rename("male"), F.rename("female")], axis=1).dropna(); J = J[(J.male >= 5) & (J.female >= 5)]
ratio = J.male / J.female; big = J[J.female >= 50]
out = {"types_shared": len(shared), "types_with_equal_cell_counts": len(same_n), "connections_compared": int(len(J)), "sum_ratio_male_over_female": float(J.male.sum() / J.female.sum()), "median_ratio": float(ratio.median()),
       "geometric_mean_ratio": float(np.exp(np.log(ratio).mean())), "median_ratio_large_connections": float((big.male / big.female).median()), "spearman": float(J.male.corr(J.female, method="spearman")),
       "female_per_male_synapse": float(J.female.sum() / J.male.sum()), "weight_unit_q16_female": 18022, "weight_unit_q16_male_equivalent": int(round(18022 * J.female.sum() / J.male.sum()))}
json.dump(out, open(a.out + ".json", "w"), indent=1); print(json.dumps(out, indent=1))
