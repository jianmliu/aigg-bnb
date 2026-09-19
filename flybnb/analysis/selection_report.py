"""Multi-generation selection: the response per generation, what drift alone does, and what the selected circuit pays.

  python flybnb/analysis/selection_report.py --work <dir of selection_experiment.py> [--out flybnb/results/selection/selection]

Per generation and line: the selected trait (DNge145 under `sound`), the cost the breeding pilot found inside the same
circuit (DNge145 under `sound_gate`: what leaks through the gate, and the suppression the gate still achieves), and the
wiring's size. Then, at the last generation, every battery phenotype in the high lines against the low lines and
against the controls, in units of the founders' standard deviation, tested (Welch, Benjamini-Hochberg over all
phenotypes): which other behaviours the selection moved, and which moved in the control lines too, i.e. by drift.
"""
import os, sys, json, argparse, numpy as np
from math import erf, sqrt
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
ap = argparse.ArgumentParser(); ap.add_argument("--work", required=True); ap.add_argument("--founder-rows", default=os.path.join(ROOT, "flybnb/results/breeding/rows.jsonl")); ap.add_argument("--out", default=os.path.join(ROOT, "flybnb/results/selection/selection")); a = ap.parse_args()
bat = json.load(open(os.path.join(ROOT, "flybnb/battery/battery-v1.json"))); G = json.load(open(os.path.join(ROOT, "flybnb/analysis/groups_flywire783.json"))); ct = json.load(open(os.path.join(ROOT, "flybnb/atlas/celltypes-flywire783.json")))
dn = bat["readout"]["neuron_index"]; k145 = [dn.index(i) for i in G["DNge145"]]; tn = np.array(ct["type_of_neuron"])[np.array(dn)]; stims = [s["name"] for s in bat["stimuli"]]; nD = len(dn)
def vecs(r):
    V = {s: np.zeros(nD) for s in stims}
    for x in r["rows"]: V[x["stim"]][x["dn_i"]] += np.array(x["dn_c"], dtype=float) / len(bat["seeds"])
    return V
F = [vecs(r) for r in map(json.loads, open(a.founder_rows)) if r["kind"] == "founder"]; gens = {}
g = 1
while os.path.exists(os.path.join(a.work, f"rows_gen{g}.jsonl")):
    for r in map(json.loads, open(os.path.join(a.work, f"rows_gen{g}.jsonl"))): gens.setdefault(g, {}).setdefault((r["line"], r["rep"]), []).append((vecs(r), r["geno"]))
    g += 1
G_LAST = max(gens); trait = lambda V: float(V["sound"][k145].sum()); leak = lambda V: float(V["sound_gate"][k145].sum())
f_t = np.array([trait(V) for V in F]); f_l = np.array([leak(V) for V in F]); sd = float(f_t.std(ddof=1))
out = {"generations": G_LAST, "founders": {"trait_mean": float(f_t.mean()), "trait_sd": sd, "leak_mean": float(f_l.mean())}, "by_generation": []}
for gg in sorted(gens):
    for (line, rep), rows in sorted(gens[gg].items()):
        t = np.array([trait(V) for V, _ in rows]); l = np.array([leak(V) for V, _ in rows])
        out["by_generation"].append({"gen": gg, "line": line, "rep": rep, "n": len(rows), "trait_mean": float(t.mean()), "trait_sd": float(t.std(ddof=1)), "trait_in_founder_sd": float((t.mean() - f_t.mean()) / sd), "leak_mean": float(l.mean()),
                                     "suppression_mean": float((t - l).mean()), "silenced_fraction": float((l == 0).mean()), "records_mean": float(np.mean([g_["records"] for _, g_ in rows])), "synapses_mean": float(np.mean([g_["synapses"] for _, g_ in rows]))})
# ---- every phenotype at the last generation: high vs low, and each against the controls
types = sorted({int(t) for t in tn if t >= 0}); P = {}
for s in stims:
    P[f"descending spikes, all | {s}"] = lambda V, s=s: float(V[s].sum())
    for t in types:
        k = np.flatnonzero(tn == t); fv = np.array([V[s][k].sum() for V in F])
        if (fv > 0).mean() >= 0.5 and fv.std() > 0: P[f"{ct['types'][t]} | {s}"] = lambda V, s=s, k=k: float(V[s][k].sum())
pool = lambda line: [V for (ln, _), rows in gens[G_LAST].items() if ln == line for V, _ in rows]
H, Lo, C = pool("high"), pool("low"), pool("control"); res = []
def welch(x, y): se = sqrt(x.var(ddof=1) / len(x) + y.var(ddof=1) / len(y)); t = (x.mean() - y.mean()) / se if se > 0 else 0.0; return t, 2 * (1 - 0.5 * (1 + erf(abs(t) / sqrt(2))))
for name, f in P.items():
    fv = np.array([f(V) for V in F]); s0 = fv.std(ddof=1); h, l, c = (np.array([f(V) for V in X]) for X in (H, Lo, C)); t1, p1 = welch(h, l); t2, p2 = welch(c, fv)
    lm = {k: float((np.mean([f(V) for V, _ in rows]) - fv.mean()) / s0) for k, rows in gens[G_LAST].items()}   # each LINE's mean, in founder SDs: the line is the unit of replication, not the individual
    hi, lo = [v for (ln, _), v in lm.items() if ln == "high"], [v for (ln, _), v in lm.items() if ln == "low"]; reps = [abs(x[0] - x[1]) for x in ([v for (ln, _), v in lm.items() if ln == g] for g in ("high", "low", "control")) if len(x) == 2]
    res.append({"phenotype": name, "high_minus_low_sd": float((h.mean() - l.mean()) / s0), "p_high_low": p1, "control_minus_founders_sd": float((c.mean() - fv.mean()) / s0), "p_control_founders": p2,
                "line_means_sd": {f"{ln}{rp}": v for (ln, rp), v in lm.items()}, "lines_separated": bool(hi and lo and (min(hi) > max(lo) or max(hi) < min(lo))), "between_lines_sd": float(np.mean(hi) - np.mean(lo)) if hi and lo else None, "replicate_gaps_sd": reps})
def bh(p):
    o = np.argsort(p); q = np.empty(len(p)); run = 1.0; m = len(p)
    for rank in range(m, 0, -1): j = o[rank - 1]; run = min(run, p[j] * m / rank); q[j] = run
    return q
for key in ("p_high_low", "p_control_founders"):
    q = bh(np.array([r[key] for r in res]));
    for r, qq in zip(res, q): r[key.replace("p_", "q_")] = float(qq)
own = lambda n: n.startswith("DNge145")
def course(name):
    """high minus low, between line means, in founder SDs, generation by generation"""
    f = P[name]; fv = np.array([f(V) for V in F]); s0 = fv.std(ddof=1); c = []
    for g in sorted(gens):
        m = {k: np.mean([f(V) for V, _ in rows]) for k, rows in gens[g].items()}; hi = [v for (ln, _), v in m.items() if ln == "high"]; lo = [v for (ln, _), v in m.items() if ln == "low"]; c.append(float((np.mean(hi) - np.mean(lo)) / s0) if hi and lo else None)
    return c
# Individuals of a line are relatives, so the test above overstates what two lines per direction can show. The stricter
# reading takes the LINE as the unit: how far apart do two lines of the SAME treatment end up (drift plus sampling, three
# such gaps per phenotype)? A phenotype counts as moved by selection when both high lines are on one side of both low
# lines AND the gap between the treatments exceeds the 99th percentile of those same-treatment gaps over all phenotypes.
gaps = np.array([g for r in res for g in r["replicate_gaps_sd"]]); thr = float(np.percentile(gaps, 99)) if len(gaps) else float("inf")
# The two lines of a treatment are not independent in one respect: both chose their first parents from the same 100
# founders, so both high lines start from the same ten flies. What those ten happened to carry shows up in both
# replicates at generation 1 and then stays; a response to selection keeps growing as the trait does. Hence the course.
for r in res: r["moved_at_line_level"] = bool(r["lines_separated"] and r["between_lines_sd"] is not None and abs(r["between_lines_sd"]) > thr)
for r in res:
    if r["moved_at_line_level"]: r["course_high_minus_low_sd"] = course(r["phenotype"])
out["last_generation"] = {"phenotypes": len(res), "moved_by_selection_q05": int(sum(r["q_high_low"] < .05 for r in res)), "of_which_not_DNge145": int(sum(r["q_high_low"] < .05 and not own(r["phenotype"]) for r in res)), "moved_in_controls_q05": int(sum(r["q_control_founders"] < .05 for r in res)),
    "replicate_gap_p99_sd": thr, "replicate_gap_median_sd": float(np.median(gaps)) if len(gaps) else None, "moved_at_line_level": int(sum(r["moved_at_line_level"] for r in res)), "moved_at_line_level_not_DNge145": int(sum(r["moved_at_line_level"] and not own(r["phenotype"]) for r in res)),
    "line_level_not_DNge145": sorted([r for r in res if r["moved_at_line_level"] and not own(r["phenotype"])], key=lambda r: -abs(r["between_lines_sd"]))[:15],
    "largest_not_DNge145": sorted([r for r in res if r["q_high_low"] < .05 and not own(r["phenotype"])], key=lambda r: -abs(r["high_minus_low_sd"]))[:15]}
os.makedirs(os.path.dirname(a.out), exist_ok=True); json.dump(out, open(a.out + ".json", "w"), indent=1)
L = [f"# Selection over {G_LAST} generations: DNge145 under `sound` (founders {f_t.mean():.2f} ± {sd:.2f}; leak under the gate {f_l.mean():.2f})\n", "| gen | line | trait | in founder SDs | leak under the gate | gate suppression | fully silenced | connections |", "|---|---|---|---|---|---|---|---|"]
L += [f"| {r['gen']} | {r['line']}{r['rep']} | {r['trait_mean']:.2f} ± {r['trait_sd']:.2f} | {r['trait_in_founder_sd']:+.2f} | {r['leak_mean']:.2f} | {r['suppression_mean']:.2f} | {100 * r['silenced_fraction']:.0f}% | {r['records_mean']:,.0f} |" for r in out["by_generation"]]
lg = out["last_generation"]; L += ["", f"**Generation {G_LAST}, all {lg['phenotypes']} phenotypes:** {lg['moved_by_selection_q05']} differ between the high and the low lines at FDR 0.05 ({lg['of_which_not_DNge145']} not DNge145); {lg['moved_in_controls_q05']} differ between the control lines and the founders (drift).", "", f"**With the line as the unit:** two lines of the same treatment end up {lg['replicate_gap_median_sd']:.2f} founder SD apart (median over phenotypes; 99th percentile {lg['replicate_gap_p99_sd']:.2f}). {lg['moved_at_line_level']} phenotypes have both high lines on one side of both low lines and a gap beyond that percentile ({lg['moved_at_line_level_not_DNge145']} not DNge145): " + "; ".join(f"{r['phenotype']} ({r['between_lines_sd']:+.2f}; by generation " + ", ".join(f"{v:+.2f}" for v in r["course_high_minus_low_sd"]) + ")" for r in lg["line_level_not_DNge145"][:8]) + ". Both high lines start from the same ten founders, so a gap that is there at generation 1 and does not grow is what those founders carried, not a response.", "", "Largest among the others by the individual-level test: " + "; ".join(f"{r['phenotype']} ({r['high_minus_low_sd']:+.2f} SD)" for r in lg["largest_not_DNge145"][:8])]
open(a.out + ".md", "w").write("\n".join(L) + "\n"); print("\n".join(L[:3] + L[-3:]))
