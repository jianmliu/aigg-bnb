"""The offline reference for a battery run on a REGISTERED base payload: one row, in run_battery.py's shape.

  python flybnb/male/recompute_live.py --payload malecns-v1.0-min2.bin --battery flybnb/battery/battery-male-v1.json

This is not the dataset's `base` row and the difference matters. `run_battery.py` calls the published wiring the
base: the >= 2-synapse export thresholded at the population's min_syn (five). The >= 2 export itself -- the
substrate individuals are drawn on, and what `registerMEP` points at -- keeps every record of two synapses and up,
and is a denser network with different dynamics. A node holds the payload as it is, so a battery posted for that
MEP is measuring the substrate. Joining it against the dataset's base row makes all 42 digests differ, correctly.

Individuals do not have this problem: a FLYDELTA genotype zeroes what falls under min_syn, so an individual's
payload and its offline row are the same network.
"""
import sys, os, json, argparse, numpy as np
HERE = os.path.dirname(os.path.abspath(__file__)); ROOT = os.path.dirname(os.path.dirname(HERE)); sys.path.insert(0, os.path.join(ROOT, "flybnb", "analysis")); import intlif as IL; FD = IL.FD
ap = argparse.ArgumentParser(); ap.add_argument("--payload", required=True); ap.add_argument("--battery", default=os.path.join(ROOT, "flybnb/battery/battery-male-v1.json"))
ap.add_argument("--out", default=os.path.join(ROOT, "flybnb/results/male/live/registered-base.json")); a = ap.parse_args()
bat = json.load(open(a.battery)); buf = open(a.payload, "rb").read(); B = FD.decode_payload(buf); n = B["n"]
net = IL.Net(n, B["pre"].astype(np.int64), B["post"].astype(np.int64), B["w"].astype(np.int64))   # every record the payload carries
dn = np.array(bat["readout"]["neuron_index"], dtype=np.int64); u = bat["population"]["w_unit_q16"]
out = {"id": os.path.basename(a.payload), "kind": "registered payload (not the dataset's base: no min_syn threshold)",
       "model_id": "0x" + FD.model_id(buf).hex(), "w_unit_q16": u, "records": int(len(B["w"])), "battery": bat["name"], "rows": []}
print(f"{out['id']}: {n:,} neurons, {out['records']:,} records, unit {u}")
for st in bat["stimuli"]:
    for seed in bat["seeds"]:
        count, late = IL.run(net, seed, bat["steps"], st["neuron_index"], w_unit=u); l = late[dn]; nz = np.flatnonzero(l)
        out["rows"].append({"stim": st["name"], "seed": seed, "digest": IL.digest(n, count), "total": int(count.sum()), "active": int((count > 0).sum()),
                            "dn_i": [int(i) for i in nz], "dn_c": [int(v) for v in l[nz]]})
        print(f"  {st['name']:16s} seed {seed}  {out['rows'][-1]['digest'][:18]}…  active {out['rows'][-1]['active']:6d}", flush=True)
os.makedirs(os.path.dirname(a.out), exist_ok=True); json.dump(out, open(a.out, "w"), separators=(",", ":")); print(f"{len(out['rows'])} runs -> {a.out}")
