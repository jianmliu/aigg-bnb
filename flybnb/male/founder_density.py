"""Which mean ratio for male individuals? The density of a sampled founder against the real animal.

  python flybnb/male/founder_density.py --base malecns-v1.0-min2.bin

A founder is drawn in place on the >= 2-synapse base: every record's count is resampled around count * mean_ratio with the
male dispersion table, and a record counts for the dynamics at >= 5 synapses. Sampling around the published count with
ratio 1 treats one noisy draw as the mean, so founders come out denser than the fly. For each candidate ratio: a
founder's >= 5 records and synapses as a fraction of the real male's. The left/right data give 0.93 for the ratio of a
mirror connection's mean to the given count; the scan says which ratio gives the animal's density.
"""
import sys, os, json, argparse, numpy as np
HERE = os.path.dirname(os.path.abspath(__file__)); ROOT = os.path.dirname(os.path.dirname(HERE)); sys.path.insert(0, os.path.join(ROOT, "flybnb", "analysis")); import intlif as IL; FD = IL.FD
ap = argparse.ArgumentParser(); ap.add_argument("--base", required=True); ap.add_argument("--r-table", default=os.path.join(ROOT, "flybnb/results/male/lr_conditional.json")); ap.add_argument("--ratios", default="0.88,0.90,0.92,0.93,0.94,0.96,1.0"); ap.add_argument("--seeds", default="1000,1001,1002")
ap.add_argument("--min-syn", type=int, default=5); ap.add_argument("--out", default=os.path.join(ROOT, "flybnb/results/male/founder_density.json")); a = ap.parse_args()
rows = [tuple(r) for r in json.load(open(a.r_table))["r_table_q8"]]; B = FD.decode_payload(open(a.base, "rb").read()); c = np.abs(B["w"]).astype(np.int64); real = c >= a.min_syn; R0, S0 = int(real.sum()), int(c[real].sum())
out = {"base_records": int(len(c)), "min_syn": a.min_syn, "real_records": R0, "real_synapses": S0, "r_table_q8": [list(r) for r in rows], "ratios": []}
print(f"real male at >= {a.min_syn}: {R0:,} records, {S0:,} synapses"); print(f"{'ratio':>6s} {'q16':>6s} {'records':>8s} {'synapses':>9s}")
for x in [float(v) for v in a.ratios.split(",")]:
    q = int(round(x * 65536)); rr, ss = [], []
    for s in [int(v) for v in a.seeds.split(",")]: g = FD.sample_counts(B["pre"], B["post"], c, s, q, rows).astype(np.int64); k = g >= a.min_syn; rr.append(k.sum() / R0); ss.append(g[k].sum() / S0)
    out["ratios"].append({"ratio": x, "mean_ratio_q16": q, "records": float(np.mean(rr)), "synapses": float(np.mean(ss)), "records_range": [float(min(rr)), float(max(rr))]}); print(f"{x:6.2f} {q:6d} {np.mean(rr):8.3f} {np.mean(ss):9.3f}", flush=True)
json.dump(out, open(a.out, "w"), indent=1); print("->", a.out)
