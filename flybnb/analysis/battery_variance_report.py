"""How much of a battery phenotype belongs to the individual? The same report for any brain's battery rows.

  python flybnb/analysis/battery_variance_report.py --rows rows.jsonl[.gz] --battery battery.json --out report

Rows are run_battery.py's. Individuals are the unrelated founders (the base, crosses and selected lines are left out).
A phenotype is a descending cell type's late spikes under a stimulus. For every stimulus: how often an individual ignites
(more than --ignite active neurons, in the majority of its seeds). Where at least half of the individuals never do, among those individuals, and for the
phenotypes that are not mostly zero: the one-way intraclass correlation over individuals x seeds, i.e. the share of the
variance of a SINGLE run that is the individual and not the input noise. Optionally the gate: a readout type under
`sound` and under `sound_gate`.
"""
import sys, os, json, gzip, argparse, numpy as np
ap = argparse.ArgumentParser(); ap.add_argument("--rows", required=True); ap.add_argument("--battery", required=True); ap.add_argument("--out", required=True); ap.add_argument("--ignite", type=int, default=3000)
ap.add_argument("--min-mean", type=float, default=2.0, help="a phenotype needs this many spikes on average to be analysed"); ap.add_argument("--gate-readout", default="DNge145"); ap.add_argument("--label", default=None); a = ap.parse_args()
bat = json.load(open(a.battery)); op = (lambda p: gzip.open(p, "rt")) if a.rows.endswith(".gz") else open; R = [r for r in map(json.loads, op(a.rows)) if r["kind"] == "founder"]
types = bat["readout"]["cell_type"]; names = sorted({t for t in types if t}); tpos = {t: k for k, t in enumerate(names)}; col = np.array([tpos.get(t, -1) for t in types]); seeds = bat["seeds"]; stims = [s["name"] for s in bat["stimuli"]]; nstim = {s["name"]: s["n"] for s in bat["stimuli"]}
nI, nS = len(R), len(seeds); Y = {s: np.zeros((nI, nS, len(names))) for s in stims}; ACT = {s: np.zeros((nI, nS)) for s in stims}
for x, r in enumerate(R):
    for w in r["rows"]:
        k = seeds.index(w["seed"]); ACT[w["stim"]][x, k] = w["active"] - nstim[w["stim"]]
        for i, c in zip(w["dn_i"], w["dn_c"]):
            if col[i] >= 0: Y[w["stim"]][x, k, col[i]] += c
def icc(y):
    """one-way ICC(1) of y [individuals x seeds]"""
    n, k = y.shape; gm = y.mean(); msb = k * ((y.mean(1) - gm) ** 2).sum() / (n - 1); msw = ((y - y.mean(1, keepdims=True)) ** 2).sum() / (n * (k - 1)); return float((msb - msw) / (msb + (k - 1) * msw)) if msb + (k - 1) * msw > 0 else float("nan")
out = {"label": a.label or bat.get("brain"), "brain": bat.get("brain"), "individuals": nI, "seeds": nS, "ignite_threshold": a.ignite, "min_mean": a.min_mean, "stimuli": [], "phenotypes": []}
for s in stims:
    ign = (ACT[s] > a.ignite).sum(1) * 2 > nS; e = {"stimulus": s, "base_regime": next(b["base_wiring"]["regime"] for b in bat["stimuli"] if b["name"] == s), "individuals_ignited": float(ign.mean()), "neurons_reached_median": float(np.median(ACT[s])), "icc_neurons_reached": icc(ACT[s])}
    calm = ~(ACT[s] > a.ignite).any(1); e["individuals_analysed"] = int(calm.sum())   # an ignited run is another regime, not a larger value of the same phenotype: those individuals are counted above and left out here
    if calm.sum() * 2 >= nI and calm.sum() >= 20:
        Yc = Y[s][calm]; m = Yc.mean((0, 1)); keep = np.flatnonzero(m >= a.min_mean); v = [icc(Yc[:, :, j]) for j in keep]; e.update({"phenotypes": int(len(keep)), "icc_median": float(np.median(v)) if len(v) else None, "icc_quartiles": [float(np.percentile(v, 25)), float(np.percentile(v, 75))] if len(v) else None})
        out["phenotypes"] += [{"stimulus": s, "readout": names[j], "mean": float(m[j]), "sd_between": float(Yc[:, :, j].mean(1).std(ddof=1)), "icc": i} for j, i in zip(keep, v)]
    out["stimuli"].append(e)
v = np.array([p["icc"] for p in out["phenotypes"]]); out["summary"] = {"phenotypes": int(len(v)), "icc_median": float(np.median(v)) if len(v) else None, "icc_at_least_0.5": float((v >= .5).mean()) if len(v) else None, "stimuli_analysed": int(sum("phenotypes" in e for e in out["stimuli"]))}
g = a.gate_readout
if g in tpos and "sound" in Y and "sound_gate" in Y:
    so, ga = Y["sound"][:, :, tpos[g]], Y["sound_gate"][:, :, tpos[g]]
    out["gate"] = {"readout": g, "neurons": int((col == tpos[g]).sum()), "sound_mean": float(so.mean()), "gate_mean": float(ga.mean()), "individuals_silent_in_every_seed": float((ga == 0).all(1).mean()), "individuals_never_silent": float((ga > 0).all(1).mean()),
                   "individuals_gate_below_sound_in_every_seed": float((ga < so).all(1).mean()), "icc_sound": icc(so), "icc_gate": icc(ga)}
json.dump(out, open(a.out + ".json", "w"), indent=1)
L = [f"# Battery variance: {out['label']}, {nI} unrelated founders x {nS} seeds\n", f"Phenotypes analysed (mean >= {a.min_mean:g} spikes, among the individuals that never ignite under the stimulus): {out['summary']['phenotypes']}; median single-run ICC " + (f"{out['summary']['icc_median']:.2f}" if len(v) else "n/a") + (f"; {100 * out['summary']['icc_at_least_0.5']:.0f}% at least 0.5.\n" if len(v) else ".\n"),
     "| stimulus | base regime | individuals ignited | analysed | neurons reached (median) | phenotypes | median ICC | quartiles |", "|---|---|---|---|---|---|---|---|"]
L += [f"| {e['stimulus']} | {e['base_regime']} | {100 * e['individuals_ignited']:.0f}% | {e['individuals_analysed']} | {e['neurons_reached_median']:.0f} | " + (f"{e['phenotypes']} | " + (f"{e['icc_median']:.2f} | {e['icc_quartiles'][0]:.2f}-{e['icc_quartiles'][1]:.2f}" if e["icc_median"] is not None else "n/a | n/a") if "phenotypes" in e else "not analysed | | ") + " |" for e in out["stimuli"]]
if "gate" in out: G = out["gate"]; L += ["", f"**The gate ({G['readout']}, {G['neurons']} neurons):** {G['sound_mean']:.1f} spikes under sound, {G['gate_mean']:.1f} with the gate neurons driven; silent in every seed in {100 * G['individuals_silent_in_every_seed']:.0f}% of individuals, never silent in {100 * G['individuals_never_silent']:.0f}%; below its sound response in every seed in {100 * G['individuals_gate_below_sound_in_every_seed']:.0f}%. ICC {G['icc_sound']:.2f} (sound), {G['icc_gate']:.2f} (gate)."]
open(a.out + ".md", "w").write("\n".join(L) + "\n"); print("\n".join(L))
