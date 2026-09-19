"""Association analysis, step 1: each individual's wiring on the connections that could matter.

  python flybnb/analysis/association_features.py --base flywire-783-min2.bin --designs design.json [design.json ...] --out features.npz

An individual has 7.6 million connection counts and there are a few hundred individuals, so the analysis cannot look at
all of them. It looks at the CANDIDATE connections of each stimulus: base records whose pre- and postsynaptic neuron
both spike (or are stimulated) under that stimulus -- in the base wiring or in any of a sample of founders, since who is
active varies between individuals. A connection outside that set never carries a spike in these runs, so it cannot
affect a readout: the restriction loses nothing about the runs it was derived from, and little about the others.
Writes, per individual, the (thresholded) count on every candidate record, and the record table itself.
"""
import sys, os, json, time, argparse, numpy as np
HERE = os.path.dirname(os.path.abspath(__file__)); ROOT = os.path.dirname(os.path.dirname(HERE)); sys.path.insert(0, HERE); import intlif as IL; FD = IL.FD
import run_battery as RB
_S = {}
def _init(base_path, mid, battery, spec, cand):
    RB._init(base_path, mid, battery, spec); _S["cand"] = cand
def _geno(iid):
    x = RB._S["spec"][iid]; B = RB._S["B"]; d = RB.recipe(iid)
    return np.where(RB._S["c"] >= 5, RB._S["c"], 0) if d is None else FD.genotype(B, RB._S["mid"], d, {})
def _active(iid):
    """which neurons spike (or are stimulated) under each sparse stimulus, any seed"""
    g = _geno(iid); B = RB._S["B"]; net = IL.Net(B["n"], RB._S["pre"], RB._S["post"], RB._S["sign"] * g); out = {}
    for st in RB._S["bat"]["stimuli"]:
        if st["base_wiring"]["regime"] != "sparse": continue
        a = np.zeros(B["n"], bool); a[st["neuron_index"]] = True
        for seed in RB._S["bat"]["seeds"]: c, _ = IL.run(net, seed, RB._S["bat"]["steps"], st["neuron_index"]); a |= c > 0
        out[st["name"]] = np.flatnonzero(a)
    return out
def _features(iid): return iid, _geno(iid)[_S["cand"]].astype(np.uint16)

def main():
    ap = argparse.ArgumentParser(); ap.add_argument("--base", default=os.environ.get("FLYBNB_BASE")); ap.add_argument("--battery", default=os.path.join(ROOT, "flybnb/battery/battery-v1.json"))
    ap.add_argument("--designs", nargs="+", required=True); ap.add_argument("--out", required=True); ap.add_argument("--sample", type=int, default=30); ap.add_argument("--workers", type=int, default=8); a = ap.parse_args()
    battery = json.load(open(a.battery)); spec = [{"id": "BASE", "kind": "base"}]; seen = {"BASE"}
    for d in a.designs:
        for x in json.load(open(d))["individuals"]:
            if x["kind"] == "founder" and x["id"] not in seen: spec.append(x); seen.add(x["id"])
    base = open(a.base, "rb").read(); mid = FD.model_id(base); B = FD.decode_payload(base); n = B["n"]; pre = B["pre"].astype(np.int64); post = B["post"].astype(np.int64)
    import multiprocessing as mp; t0 = time.time(); ids = [x["id"] for x in spec]
    with mp.Pool(a.workers, initializer=_init, initargs=(a.base, mid, battery, spec, None)) as pool: acts = pool.map(_active, ids[: a.sample + 1])
    names = [s["name"] for s in battery["stimuli"] if s["base_wiring"]["regime"] == "sparse"]; member = {}; union = np.zeros(len(pre), bool)
    for s in names:
        A = np.zeros(n, bool)
        for d in acts: A[d[s]] = True
        m = A[pre] & A[post]; member[s] = m; union |= m; print(f"{s:13s} active neurons {int(A.sum()):5d}  candidate records {int(m.sum()):6d}", flush=True)
    cand = np.flatnonzero(union); print(f"{len(cand)} candidate records in all ({time.time() - t0:.0f}s); extracting {len(ids)} individuals", flush=True)
    with mp.Pool(a.workers, initializer=_init, initargs=(a.base, mid, battery, spec, cand)) as pool: rows = pool.map(_features, ids, chunksize=4)
    np.savez_compressed(a.out, ids=np.array([r[0] for r in rows]), X=np.stack([r[1] for r in rows]), record=cand, pre=pre[cand], post=post[cand], base_count=np.abs(B["w"][cand]).astype(np.uint16), sign=np.sign(B["w"][cand]).astype(np.int8),
                        **{"member_" + s: member[s][cand] for s in names})
    print(f"{len(rows)} individuals x {len(cand)} connections -> {a.out} ({time.time() - t0:.0f}s)")
if __name__ == "__main__": main()
