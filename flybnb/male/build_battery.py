"""The standard battery of the MALE brain (Janelia MaleCNS v1.0), built the way the female one is.

  python flybnb/male/build_battery.py --annotations body-annotations-male-cns-v1.0-minconf-0.5.feather --payload malecns-v1.0-min2.bin

Stimuli are annotation rules over the release's sensory neurons; the readout is every descending neuron. The battery also
carries the male POPULATION: the in-place base its individuals are drawn on, the variability model measured on the male
brain's own two hemispheres (flybnb/male/lr_conditional.py: dispersion table; founder_density.py: mean ratio 0.93, which
is also what the mirror data give, 0.931), and the weight unit of the male exec kind, 7209 = 0.40 of FlyWire's
(flybnb/male/unit_scan.py: MaleCNS counts are 1.55-1.62 times FlyWire's over homologous connections, and at FlyWire's
unit every male stimulus ignites the network). run_battery.py reads all of it from here.

Every stimulus records its outgoing synapses by side of entry (rootSide), because a reconstruction is not symmetric: the
right Johnston's organ auditory neurons of MaleCNS v1.0 carry 835 synapses of >= 5 against 25,201 on the left.

`sound_gate` exists in the male too: AN02A001 is the male type matched to FlyWire's AN_multi_8, the two gate neurons.
"""
import sys, os, json, argparse, numpy as np, pyarrow.feather as pf
HERE = os.path.dirname(os.path.abspath(__file__)); ROOT = os.path.dirname(os.path.dirname(HERE)); sys.path.insert(0, os.path.join(ROOT, "flybnb", "analysis")); import intlif as IL; FD = IL.FD
ap = argparse.ArgumentParser(); ap.add_argument("--annotations", required=True); ap.add_argument("--payload", required=True); ap.add_argument("--w-unit", type=int, default=7209); ap.add_argument("--mean-ratio-q16", type=int, default=60948)
ap.add_argument("--r-table", default=os.path.join(ROOT, "flybnb/results/male/lr_conditional.json")); ap.add_argument("--out", default=os.path.join(ROOT, "flybnb/battery/battery-male-v1.json")); a = ap.parse_args()
A = pf.read_table(a.annotations).to_pandas(); buf = open(a.payload, "rb").read(); B = FD.decode_payload(buf); n = B["n"]; T = 5
ids = np.frombuffer(B["ids"], dtype="<u8") if isinstance(B["ids"], (bytes, bytearray)) else np.asarray(B["ids"]); pos = {int(r): i for i, r in enumerate(ids)}; A["idx"] = A.bodyId.map(lambda r: pos.get(int(r), -1)); A = A[A.idx >= 0]
S = lambda m: sorted(int(i) for i in A[m].idx); aud = (A["class"] == "mechanosensory") & (A.subclass == "auditory"); gate = S(A.type == "AN02A001")
SETS = [
  ("sound", "hearing", "class == 'mechanosensory' and subclass == 'auditory' (Johnston's organ A and B). In this release the right antenna's auditory neurons are nearly disconnected (see outgoing_synapses_by_side): this is a LEFT-ear stimulus, and the battery has no separate sound_left", S(aud)),
  ("sound_gate", "hearing + a central input", "sound plus the AN02A001 neurons (the male type matched to FlyWire's AN_multi_8, the gate of the female battery). Not purely sensory", sorted(S(aud) + gate)),
  ("wind", "wind and gravity", "subclass == 'wind_gravity'", S(A.subclass == "wind_gravity")),
  ("taste_labellar", "taste", "subclass == 'labellar bristle'", S(A.subclass == "labellar bristle")),
  ("taste_peg", "taste", "subclass == 'taste peg'", S(A.subclass == "taste peg")),
  ("taste_leg", "taste", "class == 'gustatory' and subclass == 'leg bristle' (the nerve cord is part of this connectome)", S((A["class"] == "gustatory") & (A.subclass == "leg bristle"))),
  ("ppk23", "contact pheromone", "receptorType == 'putative_ppk23'", S(A.receptorType == "putative_ppk23")),
  ("touch_leg", "touch", "class == 'mechanosensory_tactile' and subclass == 'leg'", S((A["class"] == "mechanosensory_tactile") & (A.subclass == "leg"))),
  ("grooming", "touch", "subclass == 'grooming'", S(A.subclass == "grooming")),
  ("chordotonal", "proprioception", "subclass == 'chordotonal organ'", S(A.subclass == "chordotonal organ")),
  ("campaniform", "proprioception", "subclass == 'campaniform sensilla'", S(A.subclass == "campaniform sensilla")),
  ("haltere", "proprioception", "subclass == 'haltere'", S(A.subclass == "haltere")),
  ("hygro", "humidity", "class == 'hygrosensory'", S(A["class"] == "hygrosensory")),
  ("thermo", "temperature", "class == 'thermosensory'", S(A["class"] == "thermosensory")),
]
dn = A[A.superclass == "descending_neuron"].sort_values("idx"); dnidx = dn.idx.to_numpy(dtype=np.int64); c = np.abs(B["w"]).astype(np.int64); g = np.where(c >= T, c, 0)
outw = np.bincount(B["pre"].astype(np.int64), weights=g, minlength=n); side = dict(zip(A.idx, A.rootSide.where(A.rootSide.notna(), A.somaSide)))
def by_side(idx): d = {}; [d.__setitem__(str(side.get(i)) if side.get(i) == side.get(i) and side.get(i) is not None else "unknown", d.get(str(side.get(i)) if side.get(i) == side.get(i) and side.get(i) is not None else "unknown", 0) + int(outw[i])) for i in idx]; return d
net = IL.Net(n, B["pre"].astype(np.int64), B["post"].astype(np.int64), np.sign(B["w"]).astype(np.int64) * g); SEEDS = [7, 8, 9]; STEPS = 5000
out = {"name": "flybnb-battery-male", "version": 1, "brain": "malecns-v1.0-male", "exec_kind": "aigg:exec:int-lif:v1", "steps": STEPS, "commit_stride": 500, "seeds": SEEDS,
       "annotations": "Janelia FlyEM MaleCNS v1.0 body annotations (minconf 0.5), CC-BY 4.0", "payload_model_id": "0x" + FD.model_id(buf).hex(), "neurons": n,
       "note": "indices are rows of the payload's neuron table (the same for the >=5 and the >=2 synapse export); ids are MaleCNS body ids. Brain and ventral nerve cord.",
       "population": {"base": "malecns-v1.0-min2", "base_model_id": "0x" + FD.model_id(buf).hex(), "min_syn": T, "mean_ratio_q16": a.mean_ratio_q16, "mut_rate_q32": 1 << 29, "r_table_q8": json.load(open(a.r_table))["r_table_q8"], "w_unit_q16": a.w_unit},
       "readout": {"name": "descending", "rule": "superclass == 'descending_neuron'", "neuron_index": [int(i) for i in dnidx], "cell_type": [None if t is None or t != t else str(t) for t in dn.type], "window": "spikes in steps 2501..5000 (the last 250 ms)"}, "stimuli": []}
print(f"{'stimulus':15s} {'n':>5s} {'reached':>8s} {'spikes':>8s} {'DNs':>5s} {'DN spikes':>9s}  regime   outgoing synapses by side")
for name, modality, desc, idx in SETS:
    reached, spikes, dns, dnsp = [], [], [], []; st = np.zeros(n, bool); st[idx] = True
    for seed in SEEDS: cnt, late = IL.run(net, seed, STEPS, idx, w_unit=a.w_unit); reached.append(int(((cnt > 0) & ~st).sum())); spikes.append(int(cnt[~st].sum())); dns.append(int((late[dnidx] > 0).sum())); dnsp.append(int(late[dnidx].sum()))
    regime = "ignited" if np.mean(reached) > 3000 else "sparse"
    out["stimuli"].append({"name": name, "modality": modality, "rule": desc, "n": len(idx), "neuron_index": idx, "body_id": [str(int(ids[i])) for i in idx], "outgoing_synapses_by_side": by_side(idx), "base_wiring": {"neurons_reached": reached, "spikes": spikes, "descending_active": dns, "descending_spikes_late": dnsp, "regime": regime}})
    print(f"{name:15s} {len(idx):5d} {int(np.mean(reached)):8d} {int(np.mean(spikes)):8d} {int(np.mean(dns)):5d} {int(np.mean(dnsp)):9d}  {regime:8s} {by_side(idx)}", flush=True)
json.dump(out, open(a.out, "w"), separators=(",", ":")); print(f"{len(SETS)} stimuli x {len(SEEDS)} seeds = {len(SETS) * len(SEEDS)} runs per individual; {len(dnidx)} descending neurons read out -> {a.out} ({os.path.getsize(a.out) // 1024} KB)")
