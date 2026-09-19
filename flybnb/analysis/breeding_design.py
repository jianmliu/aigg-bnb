"""The breeding pilot's design: who is crossed with whom, decided from the founders' measured phenotype and nothing else.

  python flybnb/analysis/breeding_design.py [--trait-runs flybnb/results/pilot/runs.jsonl] [--out flybnb/results/breeding/design.json]

Founders are the variance pilot's 100 individuals (same recipes: seed 1000 + k, name pilot<k>). The selected trait is the
one the pilot measured best: DNge145 spikes under `sound`, averaged over the pilot's ten seeds. Three sets of offspring:

  random : 100 crosses of founders paired at random (each founder is a parent twice) -> parent-offspring regression, h^2
  high   : 50 crosses among the 20 founders with the HIGHEST trait  \\ divergent selection: the response R against the
  low    : 50 crosses among the 20 founders with the LOWEST trait   /  selection differential S, R = h^2 S

Every choice that is not the data's is a fixed seed, so the design is reproducible from the pilot's rows.
"""
import os, json, argparse, numpy as np
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
ap = argparse.ArgumentParser(); ap.add_argument("--trait-runs", default=os.path.join(ROOT, "flybnb/results/pilot/runs.jsonl")); ap.add_argument("--out", default=os.path.join(ROOT, "flybnb/results/breeding/design.json")); a = ap.parse_args()
rows = {r["ind"]: r for r in map(json.loads, open(a.trait_runs))}
trait = {k: float(np.mean([sum(x["DNge145"]) for x in r["rows"] if x["stim"] == "joLR"])) for k, r in rows.items() if k != 0}
fid = lambda k: f"F{k:03d}"; inds = [{"id": "BASE", "kind": "base"}] + [{"id": fid(k), "kind": "founder", "seed": 1000 + k, "name": f"pilot{k}", "trait_pilot": trait[k]} for k in sorted(trait)]
rng = np.random.default_rng(20260918); ks = sorted(trait); order = sorted(ks, key=lambda k: trait[k]); low, high = order[:20], order[-20:]
def pairs_random():
    out = []
    for rep in range(2):   # two derangement-like passes: every founder is a dam once and a sire once per pass
        p = rng.permutation(ks)
        while any(int(p[i]) == ks[i] for i in range(len(ks))): p = rng.permutation(ks)
        out += [(ks[i], int(p[i])) for i in range(0, len(ks), 2)] if rep == 0 else [(ks[i], int(p[i])) for i in range(1, len(ks), 2)]
    return out
def pairs_within(group, m):
    out = []
    while len(out) < m:
        x, y = rng.choice(group, 2, replace=False); out.append((int(x), int(y)))
    return out
n = 0
for line, pairs in [("random", pairs_random()), ("high", pairs_within(high, 50)), ("low", pairs_within(low, 50))]:
    for x, y in pairs: n += 1; inds.append({"id": f"X{n:03d}", "kind": "cross", "line": line, "a": fid(x), "b": fid(y), "seed": 5000 + n, "name": f"cross{n}"})
S = {l: float(np.mean([trait[k] for k in g])) for l, g in [("high", high), ("low", low)]}; mu = float(np.mean(list(trait.values())))
json.dump({"trait": "DNge145 spikes in the last 250 ms under `sound`, mean of the pilot's ten seeds", "founder_mean": mu, "selected_mean": S, "selection_differential": {l: S[l] - mu for l in S},
           "high": [fid(k) for k in high], "low": [fid(k) for k in low], "individuals": inds}, open(a.out, "w"), indent=0)
print(f"{len(inds)} individuals: 1 base, {len(trait)} founders, {n} crosses (random {sum(1 for i in inds if i.get('line') == 'random')}, high 50, low 50)")
print(f"founder mean {mu:.2f}; high parents {S['high']:.2f} (S = {S['high'] - mu:+.2f}); low parents {S['low']:.2f} (S = {S['low'] - mu:+.2f})")
