"""Build the FlyBnB standard battery: the fixed set of assays EVERY individual gets.

One battery is what makes the three analyses one dataset. The perturbation atlas perturbs it; the association analysis
regresses its readouts on wiring across individuals; the selection experiment measures it in parents and offspring. An
individual that is minted or bred gets the same battery as a batch task, and its rows land in the same table.

  python flybnb/battery/build_battery.py --annotations annotations.tsv --payload flywire-783-min5.bin [--out flybnb/battery/battery-v1.json]

`annotations.tsv` is FlyWire's neuron annotation table (flyconnectome/flywire_annotations, v783). A stimulus is a set of
SENSORY neurons chosen by an annotation rule and driven at ~150 Hz for the whole run (that is what an int-lif stimulus
is); the rule is recorded beside the ids, so the set can be rebuilt and argued with. The readout is every descending
neuron. The script also runs the base wiring under every stimulus and records what it drives, because a stimulus that
moves nothing downstream measures nothing.
"""
import sys, os, json, time, argparse, numpy as np, pandas as pd
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, os.path.join(os.path.dirname(HERE), "analysis")); import intlif as IL; FD = IL.FD
ap = argparse.ArgumentParser(); ap.add_argument("--annotations", required=True); ap.add_argument("--payload", required=True); ap.add_argument("--out", default=os.path.join(HERE, "battery-v1.json")); a = ap.parse_args()
A = pd.read_csv(a.annotations, sep="\t", low_memory=False); buf = open(a.payload, "rb").read(); B = FD.decode_payload(buf); n = B["n"]
ids = np.frombuffer(B["ids"], dtype="<u8") if isinstance(B["ids"], (bytes, bytearray)) else np.asarray(B["ids"]); pos = {int(r): i for i, r in enumerate(ids)}
A["idx"] = A.root_id.map(lambda r: pos.get(int(r), -1)); A = A[A.idx >= 0]
G = json.load(open(os.path.join(os.path.dirname(HERE), "analysis", "groups_flywire783.json")))
def rule(desc, mask): return desc, sorted(int(i) for i in A[mask].idx)
sound = sorted(G["joA_L"] + G["joB_L"] + G["joA_R"] + G["joB_R"]); sound_left = sorted(G["joA_L"] + G["joB_L"])
SETS = [
  ("sound", "hearing", "Johnston's organ A and B neurons of both antennae that have outgoing connections of >= 5 synapses (the set of the network's first task, tasks/flywire-gate: joLR)", sound),
  ("sound_left", "hearing", "the same, left antenna only: a lateralised input", sound_left),
  ("sound_gate", "hearing + a central input", "sound plus the two AN_multi_8 gate neurons. Not purely sensory: it is the first entry of the perturbation atlas (the gate silences DNge145), kept in the battery so that every individual has it", sorted(sound + list(G["gate"]))),
  ("wind", "wind and gravity", "cell_sub_class == 'wind_gravity' (Johnston's organ C and E)", rule("", A.cell_sub_class == "wind_gravity")[1]),
  ("sugar", "taste", "cell_sub_class == 'sugar/water'", rule("", A.cell_sub_class == "sugar/water")[1]),
  ("bitter", "taste", "cell_sub_class == 'bitter'", rule("", A.cell_sub_class == "bitter")[1]),
  ("taste_peg", "taste", "cell_sub_class == 'taste peg'", rule("", A.cell_sub_class == "taste peg")[1]),
  ("head_bristle", "touch", "cell_sub_class == 'head bristle' (the input of head grooming)", rule("", A.cell_sub_class == "head bristle")[1]),
  ("eye_bristle", "touch", "cell_sub_class == 'eye bristle'", rule("", A.cell_sub_class == "eye bristle")[1]),
  ("ocelli", "vision", "cell_sub_class == 'ocellar' (ocellar photoreceptors: a whole-field light step)", rule("", A.cell_sub_class == "ocellar")[1]),
  ("moist", "humidity", "cell_sub_class == 'moist'", rule("", A.cell_sub_class == "moist")[1]),
  ("pheromone", "smell", "cell_class == 'olfactory' and cell_sub_class == 'pheromone'", rule("", (A.cell_class == "olfactory") & (A.cell_sub_class == "pheromone"))[1]),
  ("cold", "temperature", "cell_sub_class == 'cold' (nine neurons)", rule("", A.cell_sub_class == "cold")[1]),
]
dn = A[A.super_class == "descending"].sort_values("idx"); dnidx = dn.idx.to_numpy(dtype=np.int64)
net = IL.Net(n, B["pre"].astype(np.int64), B["post"].astype(np.int64), B["w"].astype(np.int64)); SEEDS = [7, 8, 9]; STEPS = 5000
out = {"name": "flybnb-battery", "version": 1, "brain": "flywire-783-female", "exec_kind": "aigg:exec:int-lif:v1", "steps": STEPS, "commit_stride": 500, "seeds": SEEDS,
       "annotations": "flyconnectome/flywire_annotations (FlyWire v783)", "payload_model_id": "0x" + FD.model_id(buf).hex(), "neurons": n,
       "note": "indices are rows of the payload's neuron table (the same for the >=5 and the >=2 synapse export); root ids are FlyWire v783",
       "readout": {"name": "descending", "rule": "super_class == 'descending'", "neuron_index": [int(i) for i in dnidx], "cell_type": [None if pd.isna(t) else str(t) for t in dn.cell_type], "window": "spikes in steps 2501..5000 (the last 250 ms)"},
       "stimuli": []}
print(f"{'stimulus':13s} {'n':>5s} {'reached':>8s} {'spikes':>8s} {'DNs':>5s} {'DN spikes':>9s}  regime")
for name, modality, desc, idx in SETS:
    reached, spikes, dns, dnsp = [], [], [], []; st = np.zeros(n, bool); st[idx] = True
    for seed in SEEDS: c, late = IL.run(net, seed, STEPS, idx); reached.append(int(((c > 0) & ~st).sum())); spikes.append(int(c[~st].sum())); dns.append(int((late[dnidx] > 0).sum())); dnsp.append(int(late[dnidx].sum()))
    regime = "ignited" if np.mean(reached) > 3000 else "sparse"   # a few stimuli tip the whole network into its high-activity state; most do not
    out["stimuli"].append({"name": name, "modality": modality, "rule": desc, "n": len(idx), "neuron_index": idx, "root_id": [str(int(ids[i])) for i in idx],
        "base_wiring": {"neurons_reached": reached, "spikes": spikes, "descending_active": dns, "descending_spikes_late": dnsp, "regime": regime}})
    print(f"{name:13s} {len(idx):5d} {int(np.mean(reached)):8d} {int(np.mean(spikes)):8d} {int(np.mean(dns)):5d} {int(np.mean(dnsp)):9d}  {regime}")
json.dump(out, open(a.out, "w"), separators=(",", ":")); print(f"{len(SETS)} stimuli x {len(SEEDS)} seeds = {len(SETS) * len(SEEDS)} runs per individual; {len(dnidx)} descending neurons read out -> {a.out} ({os.path.getsize(a.out) // 1024} KB)")
