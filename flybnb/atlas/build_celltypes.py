"""The cell type of every neuron of the payload, from FlyWire's annotations: what the atlas silences.

  python flybnb/atlas/build_celltypes.py --annotations annotations.tsv --payload flywire-783-min5.bin

A perturbation of the atlas is "silence every neuron of one cell type" (both sides). The type is `cell_type`, or
`hemibrain_type` where that is all there is; neurons with neither are left out of the atlas and counted here.
"""
import sys, os, json, argparse, numpy as np, pandas as pd
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, os.path.join(os.path.dirname(HERE), "analysis")); import intlif as IL; FD = IL.FD
ap = argparse.ArgumentParser(); ap.add_argument("--annotations", required=True); ap.add_argument("--payload", required=True); ap.add_argument("--out", default=os.path.join(HERE, "celltypes-flywire783.json")); a = ap.parse_args()
A = pd.read_csv(a.annotations, sep="\t", low_memory=False); B = FD.decode_payload(open(a.payload, "rb").read()); n = B["n"]
ids = np.frombuffer(B["ids"], dtype="<u8") if isinstance(B["ids"], (bytes, bytearray)) else np.asarray(B["ids"]); pos = {int(r): i for i, r in enumerate(ids)}
A["idx"] = A.root_id.map(lambda r: pos.get(int(r), -1)); A = A[A.idx >= 0]; t = A.cell_type.fillna(A.hemibrain_type)
names = sorted(t.dropna().unique()); code = {x: k for k, x in enumerate(names)}; of = np.full(n, -1, np.int32); of[A.idx.to_numpy()] = [code.get(x, -1) if isinstance(x, str) else -1 for x in t]
sup = A.groupby(t).super_class.agg(lambda s: s.value_counts().index[0]).to_dict()
json.dump({"brain": "flywire-783-female", "annotations": "flyconnectome/flywire_annotations (FlyWire v783)", "rule": "cell_type, else hemibrain_type", "neurons": n, "typed": int((of >= 0).sum()),
           "types": names, "super_class": [sup.get(x) for x in names], "type_of_neuron": [int(x) for x in of]}, open(a.out, "w"), separators=(",", ":"))
print(f"{len(names)} cell types over {int((of >= 0).sum())} of {n} neurons -> {a.out} ({os.path.getsize(a.out) // 1024} KB)")
