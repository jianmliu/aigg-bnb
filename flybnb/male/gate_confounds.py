"""The male gate is weaker than the female one. Two things that could fake that, tested on the base wirings.

  python flybnb/male/gate_confounds.py --female flywire-783-min2.bin --male malecns-v1.0-min2.bin

In the female brain, driving the two AN_multi_8 neurons with sound removes most of DNge145's response to sound. In the
male brain the matched neurons (AN02A001) remove about a third to a half. Before reading that as a difference between
the sexes:
  1. the male `sound` is a left-ear stimulus (the right ear of the reconstruction is nearly disconnected). Is the female
     gate weaker too when only one ear is driven?
  2. the male runs under another weight unit, which scales excitation and inhibition alike. Does the male gate's
     strength depend on the unit?
"""
import sys, os, json, argparse, numpy as np
HERE = os.path.dirname(os.path.abspath(__file__)); ROOT = os.path.dirname(os.path.dirname(HERE)); sys.path.insert(0, os.path.join(ROOT, "flybnb", "analysis")); import intlif as IL; FD = IL.FD
ap = argparse.ArgumentParser(); ap.add_argument("--female", required=True); ap.add_argument("--male", required=True); ap.add_argument("--units", default="6308,7209,8110,9011"); ap.add_argument("--out", default=os.path.join(ROOT, "flybnb/results/male/gate_confounds.json")); a = ap.parse_args()
def load(payload, battery):
    bat = json.load(open(os.path.join(ROOT, "flybnb/battery", battery))); B = FD.decode_payload(open(payload, "rb").read()); c = np.abs(B["w"]).astype(np.int64); g = np.where(c >= 5, c, 0)
    net = IL.Net(B["n"], B["pre"].astype(np.int64), B["post"].astype(np.int64), np.sign(B["w"]).astype(np.int64) * g); dn = np.array(bat["readout"]["neuron_index"])
    return bat, net, dn[[i for i, t in enumerate(bat["readout"]["cell_type"]) if t == "DNge145"]], {s["name"]: s["neuron_index"] for s in bat["stimuli"]}
def resp(net, k, idx, u, seeds): return float(np.mean([IL.run(net, s, 5000, idx, w_unit=u)[1][k].sum() for s in seeds]))
out = {"readout": "DNge145, late spikes, mean of the battery's seeds, base wiring", "female_one_ear": [], "male_by_unit": []}
bat, net, k, S = load(a.female, "battery-v1.json"); gate = sorted(set(S["sound_gate"]) - set(S["sound"]))
for name in ("sound", "sound_left"):
    x = resp(net, k, S[name], IL.W_UNIT_Q16, bat["seeds"]); y = resp(net, k, sorted(S[name] + gate), IL.W_UNIT_Q16, bat["seeds"]); out["female_one_ear"].append({"stimulus": name, "without_gate": x, "with_gate": y, "removed": 1 - y / x if x else None}); print(f"female {name:11s}: {x:5.1f} -> {y:5.1f} ({100 * (1 - y / x):.0f}% removed)", flush=True)
bat, net, k, S = load(a.male, "battery-male-v1.json")
for u in [int(v) for v in a.units.split(",")]:
    x = resp(net, k, S["sound"], u, bat["seeds"]); y = resp(net, k, S["sound_gate"], u, bat["seeds"]); out["male_by_unit"].append({"w_unit_q16": u, "without_gate": x, "with_gate": y, "removed": 1 - y / x if x else None}); print(f"male unit {u}: {x:5.1f} -> {y:5.1f} ({100 * (1 - y / x):.0f}% removed)", flush=True)
json.dump(out, open(a.out, "w"), indent=1); print("->", a.out)
