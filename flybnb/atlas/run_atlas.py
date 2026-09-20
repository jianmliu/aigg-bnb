"""The perturbation atlas, silencing side: every cell type that is ACTIVE under a stimulus, silenced, in every individual.

  python flybnb/atlas/run_atlas.py --base flywire-783-min2.bin --individuals design.json --stimuli sound --out rows.jsonl

For each individual, stimulus and seed: the unperturbed run, then one run per cell type with at least one neuron that
spiked (or was stimulated) in it, with every neuron of that type silenced (the int-lif silence set). Types with no active
neuron are not run, and that is exact rather than a shortcut: int-lif has no background input, so silencing a neuron that
never spikes leaves the run unchanged bit for bit -- their rows ARE the unperturbed row.
One output line per individual: per (stimulus, seed) the unperturbed digest and descending-neuron spikes, and per silenced
type its digest, how many of its neurons were active, and the descending-neuron spikes of the perturbed run.
"""
import sys, os, json, time, argparse, numpy as np
HERE = os.path.dirname(os.path.abspath(__file__)); ROOT = os.path.dirname(os.path.dirname(HERE)); sys.path.insert(0, os.path.join(ROOT, "flybnb", "analysis")); import intlif as IL, run_battery as RB; FD = IL.FD
_A = {}
def _init(base_path, mid, battery, spec, stimuli, ct):
    RB._init(base_path, mid, battery, spec); _A["stimuli"] = stimuli; tn = np.array(ct["type_of_neuron"], dtype=np.int64); _A["tn"] = tn
    order = np.argsort(tn, kind="stable"); bounds = np.searchsorted(tn[order], np.arange(len(ct["types"]) + 1)); _A["members"] = lambda t: order[bounds[t]:bounds[t + 1]]
def _sparse(late, dn): l = late[dn]; nz = np.flatnonzero(l); return [int(i) for i in nz], [int(v) for v in l[nz]]
def _job(iid):
    t0 = time.time(); S = RB._S; x = S["spec"][iid]; B = S["B"]; d = RB.recipe(iid)
    g = np.where(S["c"] >= 5, S["c"], 0) if d is None else FD.genotype(B, S["mid"], d, {})
    net = IL.Net(B["n"], S["pre"], S["post"], S["sign"] * g); dn = S["dn"]; tn = _A["tn"]; rec = {"id": iid, "kind": x["kind"], "delta_id": None if d is None else "0x" + FD.delta_id(d).hex(), "cells": []}; runs = 0
    for st in S["bat"]["stimuli"]:
        if st["name"] not in _A["stimuli"]: continue
        stim = np.array(st["neuron_index"], dtype=np.int64)
        for seed in S["bat"]["seeds"]:
            count, late = IL.run(net, seed, S["bat"]["steps"], stim); runs += 1; act = count > 0; act[stim] = True
            types = np.unique(tn[act]); types = types[types >= 0]; i0, c0 = _sparse(late, dn)
            cell = {"stim": st["name"], "seed": seed, "digest": IL.digest(B["n"], count), "dn_i": i0, "dn_c": c0, "active_types": int(len(types)), "silenced": []}
            for t in types:
                mem = _A["members"](int(t)); c2, l2 = IL.run(net, seed, S["bat"]["steps"], stim, mem); runs += 1; i2, v2 = _sparse(l2, dn)
                cell["silenced"].append({"t": int(t), "n": int(len(mem)), "n_active": int(act[mem].sum()), "stimulated": bool(np.isin(mem, stim).any()), "digest": IL.digest(B["n"], c2), "dn_i": i2, "dn_c": v2})
            rec["cells"].append(cell)
    rec["runs"] = runs; rec["t_s"] = round(time.time() - t0, 1); return rec
def main():
    ap = argparse.ArgumentParser(); ap.add_argument("--base", default=os.environ.get("FLYBNB_BASE")); ap.add_argument("--battery", default=os.path.join(ROOT, "flybnb/battery/battery-v1.json")); ap.add_argument("--celltypes", default=os.path.join(HERE, "celltypes-flywire783.json"))
    ap.add_argument("--individuals", required=True); ap.add_argument("--stimuli", default="sound"); ap.add_argument("--out", required=True); ap.add_argument("--workers", type=int, default=8); ap.add_argument("--only", default=None); ap.add_argument("--kinds", default="base,founder"); a = ap.parse_args()
    battery = json.load(open(a.battery)); ct = json.load(open(a.celltypes)); spec = [x for x in json.load(open(a.individuals))["individuals"] if x["kind"] in a.kinds.split(",")]; mid = FD.model_id(open(a.base, "rb").read()); assert "0x" + mid.hex() == RB.BASE_MODEL_ID
    done = {json.loads(l)["id"] for l in open(a.out)} if os.path.exists(a.out) else set(); todo = [x["id"] for x in spec if x["id"] not in done and (a.only is None or x["id"] in a.only.split(","))]
    print(f"{len(todo)} individuals, stimuli {a.stimuli} ({len(done)} done)", flush=True)
    import multiprocessing as mp
    with mp.Pool(a.workers, initializer=_init, initargs=(a.base, mid, battery, spec, a.stimuli.split(","), ct)) as pool, open(a.out, "a") as f:
        t0 = time.time(); total = 0
        for k, r in enumerate(pool.imap_unordered(_job, todo), 1):
            f.write(json.dumps(r, separators=(",", ":")) + "\n"); f.flush(); total += r["runs"]
            if k % 8 == 0 or k == len(todo): print(f"[{k}/{len(todo)}] {r['id']} {r['runs']} runs in {r['t_s']}s; {total} runs, elapsed {time.time() - t0:.0f}s", flush=True)
if __name__ == "__main__": main()
