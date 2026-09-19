"""Multi-generation divergent selection on a circuit phenotype, under the collection's cross.

  python flybnb/analysis/selection_experiment.py --base flywire-783-min2.bin --work <dir outside the repo> [--generations 6]

The breeding pilot showed one generation. This asks what one generation cannot: does the response continue or plateau,
is it symmetric, what does drift alone do, and does the cost inside the selected circuit (the gate leaks more in the line
bred for a strong response to sound) accumulate.

  trait       DNge145 spikes under `sound`, mean of the battery's three seeds
  lines       high, low, control (parents drawn at random), two replicates each: six lines
  generation  0 is the pilot's 100 founders (already under the battery). Each later generation of a line is 40 offspring
              of 10 parents chosen from the line's previous generation (from the founders, for generation 1), paired at
              random without selfing. Recipes are the collection's: record-level inheritance, one connection in eight
              redrawn around the base, in-place layout, min_syn 5.
  every individual gets the FULL battery, so every other phenotype is measured in every generation.

A child's wiring is computed from its two parents' stored wirings rather than by replaying its whole ancestry, so a
generation costs the same whatever its depth. Resumable: a generation's rows are appended as they finish.
"""
import sys, os, json, time, argparse, numpy as np
HERE = os.path.dirname(os.path.abspath(__file__)); ROOT = os.path.dirname(os.path.dirname(HERE)); sys.path.insert(0, HERE); import intlif as IL, run_battery as RB; FD = IL.FD
LINES = [("high", 1), ("high", 2), ("low", 1), ("low", 2), ("control", 1), ("control", 2)]; N_OFF, N_PAR = 40, 10
_W = {}
def _init(base_path, mid, battery, spec, work): RB._init(base_path, mid, battery, spec); _W["work"] = work
def _gpath(iid): return os.path.join(_W["work"], "genotypes", iid + ".npy")
def _job(iid):
    t0 = time.time(); S = RB._S; x = S["spec"][iid]; B = S["B"]; d = RB.recipe(iid); cache = {}; parents = {}
    for p in (x["a"], x["b"]):
        rp = RB.recipe(p); parents[FD.delta_id(rp)] = rp
        if os.path.exists(_gpath(p)): cache[FD.delta_id(rp)] = np.load(_gpath(p)).astype(np.int64)
        else:   # a founder: its wiring is its own recipe's
            for q in (S["spec"][p].get("a"), S["spec"][p].get("b")):
                if q: rq = RB.recipe(q); parents[FD.delta_id(rq)] = rq
    g = FD.genotype(B, S["mid"], d, parents, cache); np.save(_gpath(iid), g.astype(np.uint16)); c = S["c"]; kept5 = c >= 5
    rec = {"id": iid, "kind": "cross", "line": x["line"], "rep": x["rep"], "gen": x["gen"], "a": x["a"], "b": x["b"], "seed": x["seed"], "delta_id": "0x" + FD.delta_id(d).hex(), "recipe_hex": d.hex(),
           "geno": {"records": int((g > 0).sum()), "synapses": int(g.sum()), "lost": int((kept5 & (g == 0)).sum()), "gained": int((~kept5 & (g > 0)).sum())}, "rows": []}
    net = IL.Net(B["n"], S["pre"], S["post"], S["sign"] * g); dn = S["dn"]
    for st in S["bat"]["stimuli"]:
        for seed in S["bat"]["seeds"]:
            count, late = IL.run(net, seed, S["bat"]["steps"], st["neuron_index"]); l = late[dn]; nz = np.flatnonzero(l)
            rec["rows"].append({"stim": st["name"], "seed": seed, "digest": IL.digest(B["n"], count), "total": int(count.sum()), "active": int((count > 0).sum()), "dn_i": [int(i) for i in nz], "dn_c": [int(v) for v in l[nz]]})
    rec["t_s"] = round(time.time() - t0, 1); return rec

def trait_of(r, k145):
    v = 0.0
    for x in r["rows"]:
        if x["stim"] == "sound": v += sum(c for i, c in zip(x["dn_i"], x["dn_c"]) if i in k145)
    return v / 3
def main():
    ap = argparse.ArgumentParser(); ap.add_argument("--base", default=os.environ.get("FLYBNB_BASE")); ap.add_argument("--work", required=True); ap.add_argument("--generations", type=int, default=6); ap.add_argument("--workers", type=int, default=8)
    ap.add_argument("--founder-rows", default=os.path.join(ROOT, "flybnb/results/breeding/rows.jsonl")); ap.add_argument("--founder-design", default=os.path.join(ROOT, "flybnb/results/breeding/design.json")); a = ap.parse_args()
    os.makedirs(os.path.join(a.work, "genotypes"), exist_ok=True); battery = json.load(open(os.path.join(ROOT, "flybnb/battery/battery-v1.json"))); G = json.load(open(os.path.join(ROOT, "flybnb/analysis/groups_flywire783.json")))
    dn = battery["readout"]["neuron_index"]; k145 = {dn.index(i) for i in G["DNge145"]}; mid = FD.model_id(open(a.base, "rb").read()); assert "0x" + mid.hex() == RB.BASE_MODEL_ID
    spec = [x for x in json.load(open(a.founder_design))["individuals"] if x["kind"] == "founder"]; trait = {r["id"]: trait_of(r, k145) for r in map(json.loads, open(a.founder_rows)) if r["kind"] == "founder"}
    pop = {ln: [x["id"] for x in spec] for ln in LINES}; serial = 0; import multiprocessing as mp
    for gen in range(1, a.generations + 1):
        rng = np.random.default_rng(7000 + gen); new = []
        for (line, rep) in LINES:
            cand = pop[(line, rep)]; order = sorted(cand, key=lambda i: trait[i]); r2 = np.random.default_rng(100 * gen + 10 * rep + len(line))
            par = order[-N_PAR:] if line == "high" else order[:N_PAR] if line == "low" else [str(z) for z in r2.choice(cand, N_PAR, replace=False)]
            kids = []
            for k in range(N_OFF):
                x, y = r2.choice(par, 2, replace=False); serial += 1; iid = f"S{gen}{line[0].upper()}{rep}_{k:02d}"
                new.append({"id": iid, "kind": "cross", "line": line, "rep": rep, "gen": gen, "a": str(x), "b": str(y), "seed": 900000 + serial, "name": iid}); kids.append(iid)
            pop[(line, rep)] = kids
        spec += new; out = os.path.join(a.work, f"rows_gen{gen}.jsonl"); done = {json.loads(l)["id"]: json.loads(l) for l in open(out)} if os.path.exists(out) else {}
        todo = [x["id"] for x in new if x["id"] not in done]; print(f"generation {gen}: {len(new)} individuals, {len(todo)} to run", flush=True); t0 = time.time()
        if todo:
            with mp.Pool(a.workers, initializer=_init, initargs=(a.base, mid, battery, spec, a.work)) as pool, open(out, "a") as f:
                for k, r in enumerate(pool.imap_unordered(_job, todo), 1):
                    f.write(json.dumps(r, separators=(",", ":")) + "\n"); f.flush(); done[r["id"]] = r
                    if k % 40 == 0 or k == len(todo): print(f"  [{k}/{len(todo)}] elapsed {time.time() - t0:.0f}s", flush=True)
        for x in new: trait[x["id"]] = trait_of(done[x["id"]], k145)
        for (line, rep) in LINES: v = [trait[i] for i in pop[(line, rep)]]; print(f"  gen {gen} {line}{rep}: trait {np.mean(v):6.2f} ± {np.std(v, ddof=1):5.2f}", flush=True)
        json.dump({"individuals": spec}, open(os.path.join(a.work, "design.json"), "w"))
        # wirings of individuals two generations back are no one's parents any more
        keep = {i for ln in LINES for i in pop[ln]}
        for fn in os.listdir(os.path.join(a.work, "genotypes")):
            if fn[:-4] not in keep: os.remove(os.path.join(a.work, "genotypes", fn))
if __name__ == "__main__": main()
