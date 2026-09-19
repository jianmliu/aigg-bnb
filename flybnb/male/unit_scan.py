"""Which weight unit for the male brain? A scan, not a choice: the data the calibration is argued from.

  python flybnb/male/unit_scan.py --payload malecns-v1.0-min5.bin --annotations body-annotations-male-cns-v1.0-minconf-0.5.feather

Under FlyWire's unit (18022) every male stimulus ignites the network. For each candidate unit and each candidate
stimulus of a male battery: how many neurons a run reaches, and the descending output. The female brain, under its own
unit, is sparse for 11 of its 13 battery stimuli (a few hundred to ~1,700 neurons reached) and ignites for two; the male
unit should put the male brain in the same kind of regime, and the scan shows where that is and how sharply it sets in.
"""
import sys, os, json, time, argparse, numpy as np, pyarrow.feather as pf
HERE = os.path.dirname(os.path.abspath(__file__)); ROOT = os.path.dirname(os.path.dirname(HERE)); sys.path.insert(0, os.path.join(ROOT, "flybnb", "analysis")); import intlif as IL; FD = IL.FD
ap = argparse.ArgumentParser(); ap.add_argument("--payload", required=True); ap.add_argument("--annotations", required=True); ap.add_argument("--units", default="18022,11107,9912,9011,8110,7209,6308,5407"); ap.add_argument("--out", default=os.path.join(ROOT, "flybnb/results/male/unit_scan")); a = ap.parse_args()
A = pf.read_table(a.annotations).to_pandas(); B = FD.decode_payload(open(a.payload, "rb").read()); n = B["n"]
ids = np.frombuffer(B["ids"], dtype="<u8") if isinstance(B["ids"], (bytes, bytearray)) else np.asarray(B["ids"]); pos = {int(r): i for i, r in enumerate(ids)}; A["idx"] = A.bodyId.map(lambda r: pos.get(int(r), -1)); A = A[A.idx >= 0]
S = lambda m: sorted(int(i) for i in A[m].idx)
SETS = {"sound": S((A["class"] == "mechanosensory") & (A.subclass == "auditory")), "wind": S(A.subclass == "wind_gravity"), "taste_labellar": S(A.subclass == "labellar bristle"), "taste_peg": S(A.subclass == "taste peg"),
        "taste_leg": S((A["class"] == "gustatory") & (A.subclass == "leg bristle")), "ppk23": S(A.receptorType == "putative_ppk23"), "touch_bristle": S(A.subclass == "mechanosensory bristle"), "touch_leg": S((A["class"] == "mechanosensory_tactile") & (A.subclass == "leg")),
        "grooming": S(A.subclass == "grooming"), "chordotonal": S(A.subclass == "chordotonal organ"), "campaniform": S(A.subclass == "campaniform sensilla"), "haltere": S(A.subclass == "haltere"),
        "hygro": S(A["class"] == "hygrosensory"), "thermo": S(A["class"] == "thermosensory"), "olfactory": S(A["class"] == "olfactory")}
dn = np.array(S(A.superclass == "descending_neuron")); net = IL.Net(n, B["pre"].astype(np.int64), B["post"].astype(np.int64), B["w"].astype(np.int64)); units = [int(x) for x in a.units.split(",")]; out = {"units": units, "stimuli": {k: len(v) for k, v in SETS.items()}, "reached": {}, "dn_spikes": {}}
print(f"{'unit':>6s} {'x':>5s} " + " ".join(f"{k[:9]:>9s}" for k in SETS) + "   sparse(<3000)", flush=True)
for u in units:
    r, d = [], []
    for k, idx in SETS.items(): c, late = IL.run(net, 7, 5000, idx, w_unit=u); st = np.zeros(n, bool); st[idx] = True; r.append(int(((c > 0) & ~st).sum())); d.append(int(late[dn].sum()))
    out["reached"][str(u)] = dict(zip(SETS, r)); out["dn_spikes"][str(u)] = dict(zip(SETS, d)); print(f"{u:6d} {u / 18022:5.2f} " + " ".join(f"{x:9d}" for x in r) + f"   {sum(x < 3000 for x in r)}/{len(r)}", flush=True)
json.dump(out, open(a.out + ".json", "w"), indent=1)
