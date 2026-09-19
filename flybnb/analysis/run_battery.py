"""Run the standard battery (flybnb/battery/battery-v1.json) on a list of individuals.

  python flybnb/analysis/run_battery.py --base flywire-783-min2.bin --individuals design.json --out rows.jsonl [--workers 8]

An individual is {"id", "kind": "base"} | {"id", "kind": "founder", "seed"} | {"id", "kind": "cross", "a": id, "b": id, "seed"}:
the published wiring, an in-place FLYDELTAv3 founder, or the cross of two individuals of the same list (parents first).
Recipes are the collection's format (record-level inheritance, mutation rate 1/8), so an individual here is exactly the
brain its recipe would register. What differs between connectomes is the battery's "population": the base it is drawn on,
the mean ratio and dispersion table of its variability model, and the weight unit of its exec kind. A battery without one
is the female brain's (FlyWire: min_syn 5, mean ratio 0.92, the default table, unit 18022). One output line per individual: its recipe and delta id, its
parents, how its wiring differs from the base, and one row per (stimulus, seed) with the run's digest and the spikes of
every descending neuron that fired in the readout window.
"""
import sys, os, json, time, argparse, numpy as np
HERE = os.path.dirname(os.path.abspath(__file__)); ROOT = os.path.dirname(os.path.dirname(HERE)); sys.path.insert(0, HERE); import intlif as IL; FD = IL.FD
BASE_MODEL_ID = "0x53a7b48e9265bea68fbd3f3640eda751f8dd7742ac76ae6f9c69f1cddc528135"; MEAN_RATIO_Q16 = 60293; MUT_Q32 = 1 << 29
def population(battery):
    """the connectome-specific parameters of a battery's individuals; the female brain's when the battery names none"""
    p = battery.get("population") or {}
    return {"base_model_id": p.get("base_model_id", BASE_MODEL_ID), "min_syn": int(p.get("min_syn", 5)), "mean_ratio_q16": int(p.get("mean_ratio_q16", MEAN_RATIO_Q16)), "mut_rate_q32": int(p.get("mut_rate_q32", MUT_Q32)),
            "r_table": [tuple(r) for r in p["r_table_q8"]] if p.get("r_table_q8") else None, "w_unit_q16": int(p.get("w_unit_q16", IL.W_UNIT_Q16))}
_S = {}
def _init(base_path, mid, battery, spec):
    try:
        base = open(base_path, "rb").read(); B = FD.decode_payload(base)
        _S.update(B=B, mid=mid, sign=np.sign(B["w"]).astype(np.int64), c=np.abs(B["w"]).astype(np.int64), nl=FD.base_name_length(base), bat=battery, spec={x["id"]: x for x in spec}, recipes={}, pre=B["pre"].astype(np.int64), post=B["post"].astype(np.int64))
        _S["dn"] = np.array(battery["readout"]["neuron_index"], dtype=np.int64); _S["pop"] = population(battery)
    except BaseException:
        import traceback; traceback.print_exc(); os._exit(1)

def recipe(iid):
    """the FLYDELTAv3 bytes of an individual (None for the base), built from the design alone"""
    if iid in _S["recipes"]: return _S["recipes"][iid]
    x = _S["spec"][iid]; B = _S["B"]; name = FD.fit_name(x.get("name", iid), _S["nl"]); P = _S["pop"]; kw = dict(granularity=0, min_syn=P["min_syn"], mean_ratio_q16=P["mean_ratio_q16"], r_table=P["r_table"], layout=1)
    if x["kind"] == "base": d = None
    elif x["kind"] == "founder": d = FD.encode_delta3(_S["mid"], B["n"], name, "", FD.ZERO_ID, FD.ZERO_ID, x["seed"], mut_rate_q32=FD.MUT_ALWAYS, **kw)
    else: d = FD.encode_delta3(_S["mid"], B["n"], name, "", FD.delta_id(recipe(x["a"])), FD.delta_id(recipe(x["b"])), x["seed"], mut_rate_q32=P["mut_rate_q32"], **kw)
    _S["recipes"][iid] = d; return d

def _job(iid):
    t0 = time.time(); x = _S["spec"][iid]; B = _S["B"]; c = _S["c"]; d = recipe(iid)
    T = _S["pop"]["min_syn"]
    if d is None: g = np.where(c >= T, c, 0)
    else:
        parents = {FD.delta_id(recipe(p)): recipe(p) for p in ([x["a"], x["b"]] if x["kind"] == "cross" else [])}
        g = FD.genotype(B, _S["mid"], d, parents)
    kept5 = c >= T
    rec = {"id": iid, "kind": x["kind"], "line": x.get("line"), "a": x.get("a"), "b": x.get("b"), "seed": x.get("seed"), "delta_id": None if d is None else "0x" + FD.delta_id(d).hex(), "recipe_hex": None if d is None else d.hex(),
           "geno": {"records": int((g > 0).sum()), "synapses": int(g.sum()), "lost": int((kept5 & (g == 0)).sum()), "gained": int((~kept5 & (g > 0)).sum())}, "rows": []}
    net = IL.Net(B["n"], _S["pre"], _S["post"], _S["sign"] * g); rec["t_geno_s"] = round(time.time() - t0, 1); dn = _S["dn"]
    for st in _S["bat"]["stimuli"]:
        for seed in _S["bat"]["seeds"]:
            count, late = IL.run(net, seed, _S["bat"]["steps"], st["neuron_index"], w_unit=_S["pop"]["w_unit_q16"]); l = late[dn]; nz = np.flatnonzero(l)
            rec["rows"].append({"stim": st["name"], "seed": seed, "digest": IL.digest(B["n"], count), "total": int(count.sum()), "active": int((count > 0).sum()), "dn_i": [int(i) for i in nz], "dn_c": [int(v) for v in l[nz]]})
    rec["t_s"] = round(time.time() - t0, 1); return rec

def main():
    ap = argparse.ArgumentParser(); ap.add_argument("--base", default=os.environ.get("FLYBNB_BASE")); ap.add_argument("--battery", default=os.path.join(ROOT, "flybnb/battery/battery-v1.json"))
    ap.add_argument("--individuals", required=True); ap.add_argument("--out", required=True); ap.add_argument("--workers", type=int, default=8); ap.add_argument("--only", default=None, help="comma-separated ids (smoke tests)"); a = ap.parse_args()
    if not a.base: sys.exit("--base <flywire-783-min2.bin> (or FLYBNB_BASE): see flybnb/README.md")
    battery = json.load(open(a.battery)); spec = json.load(open(a.individuals))["individuals"]; mid = FD.model_id(open(a.base, "rb").read())
    assert "0x" + mid.hex() == population(battery)["base_model_id"], f"not the base this battery's individuals are drawn on: 0x{mid.hex()}"
    done = {json.loads(l)["id"] for l in open(a.out)} if os.path.exists(a.out) else set(); todo = [x["id"] for x in spec if x["id"] not in done and (a.only is None or x["id"] in a.only.split(","))]
    print(f"{len(todo)} individuals x {len(battery['stimuli']) * len(battery['seeds'])} runs ({len(done)} done)", flush=True)
    import multiprocessing as mp
    with mp.Pool(a.workers, initializer=_init, initargs=(a.base, mid, battery, spec)) as pool, open(a.out, "a") as f:
        t0 = time.time()
        for k, r in enumerate(pool.imap_unordered(_job, todo), 1):
            f.write(json.dumps(r, separators=(",", ":")) + "\n"); f.flush()
            if k % 8 == 0 or k == len(todo): print(f"[{k}/{len(todo)}] {r['id']} geno {r['t_geno_s']}s total {r['t_s']}s  elapsed {time.time() - t0:.0f}s", flush=True)
if __name__ == "__main__": main()
