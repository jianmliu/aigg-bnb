"""Build the Hugging Face layout of the FlyBnB pilot from the pilot's outputs (flybnb/analysis/phenotype_variance.py --rows-dir).

  python flybnb/dataset/build_dataset.py --base flywire-783-min2.bin --rows-dir rows/ [--runs flybnb/results/pilot/runs.jsonl] [--out flybnb/dataset/build]

Writes pilot/runs.parquet, pilot/individuals.parquet, neurons/flywire-783-female.parquet, stimuli.json and copies README.md, and
checks that every stored spike-count vector hashes to its row's digest. Needs numpy, pandas, pyarrow. Nothing here uploads
anything: `huggingface-cli upload <repo> flybnb/dataset/build . --repo-type dataset` is a separate, deliberate step."""
import os, sys, json, argparse, shutil, numpy as np, pandas as pd
HERE = os.path.dirname(os.path.abspath(__file__)); ROOT = os.path.dirname(os.path.dirname(HERE))   # the aigg-bnb checkout
sys.path.insert(0, os.environ.get("FLY_BRAIN_DIR", os.path.join(ROOT, "contracts", "lib", "aigg-porw", "gpu", "triton", "demo", "fly_brain"))); import flywire_delta as FD
BRAIN = "flywire-783-female"; EXEC = "aigg:exec:int-lif:v1"
ap = argparse.ArgumentParser(); ap.add_argument("--base", default=os.environ.get("FLYBNB_BASE"), required=not os.environ.get("FLYBNB_BASE")); ap.add_argument("--runs", default=os.path.join(ROOT, "flybnb/results/pilot/runs.jsonl"))
ap.add_argument("--rows-dir", required=True); ap.add_argument("--out", default=os.path.join(HERE, "build")); ap.add_argument("--steps", type=int, default=5000); a = ap.parse_args()
base = open(a.base, "rb").read(); base_mid = "0x" + FD.model_id(base).hex(); B = FD.decode_payload(base)
G = json.load(open(os.path.join(ROOT, "flybnb", "analysis", "groups_flywire783.json"))); recs = [json.loads(l) for l in open(a.runs)]; recs.sort(key=lambda r: r["ind"])
runs, inds = [], []
for r in recs:
    z = np.load(os.path.join(a.rows_dir, f"ind{r['ind']:04d}.npz")); g = r["geno"]
    inds.append(dict(individual=r["ind"], individual_delta_id=g.get("delta_id"), individual_model_id=g.get("model_id"), recipe_hex=g.get("recipe_hex"), base_model_id=base_mid,
                     records=g["records"], synapses=g["synapses"], records_lost=g["lost"], records_gained=g["gained"], direct_gate_synapses=g["direct_edges"]))
    for x in r["rows"]:
        k = f"{x['stim']}|{x['seed']}"; idx, n = z[k + "|idx"], z[k + "|n"]
        full = np.zeros(B["n"], np.int64); full[idx] = n; assert "0x" + FD.keccak256(np.uint32(B["n"]).tobytes() + full.astype("<u4").tobytes()).hex() == x["digest"], ("the stored vector does not hash to the row's digest", r["ind"], k)
        runs.append(dict(row_id=f"{BRAIN}|{r['ind']}|none|{x['stim']}|{x['seed']}|{a.steps}", brain=BRAIN, base_model_id=base_mid, individual=r["ind"], individual_delta_id=g.get("delta_id"), individual_model_id=g.get("model_id"),
                         perturbation="none", stimulus=x["stim"], seed=x["seed"], steps=a.steps, exec_kind=EXEC, digest=x["digest"], total_spikes=x["total"], active_neurons=x["active"],
                         neuron_index=idx.astype(np.uint32), spike_count=n.astype(np.uint32), late_dnge145=x["DNge145"], late_gf=x["GF"], late_dnp12=x["DNp12"], late_locked38=x["locked38"]))
os.makedirs(os.path.join(a.out, "pilot"), exist_ok=True); os.makedirs(os.path.join(a.out, "neurons"), exist_ok=True)
pd.DataFrame(runs).to_parquet(os.path.join(a.out, "pilot", "runs.parquet"), index=False); pd.DataFrame(inds).to_parquet(os.path.join(a.out, "pilot", "individuals.parquet"), index=False)
ids = np.frombuffer(B["ids"], dtype="<u8") if isinstance(B["ids"], (bytes, bytearray)) else np.asarray(B["ids"]); pd.DataFrame(dict(neuron_index=np.arange(B["n"], dtype=np.uint32), flywire_root_id=ids.astype(np.uint64).astype(str))).to_parquet(os.path.join(a.out, "neurons", f"{BRAIN}.parquet"), index=False)
jo = list(G["joA_L"]) + list(G["joB_L"]) + list(G["joA_R"]) + list(G["joB_R"])
json.dump({"joLR": {"description": "Johnston's organ A and B neurons of both antennae, driven at ~150 Hz", "neuron_index": jo},
           "joLR+gate": {"description": "joLR plus the two AN_multi_8 gate neurons", "neuron_index": jo + list(G["gate"])},
           "readout_groups": {k: list(G[k]) for k in ["DNge145", "GF", "DNp12", "locked38", "gate"]}}, open(os.path.join(a.out, "stimuli.json"), "w"))
shutil.copy(os.path.join(HERE, "README.md"), os.path.join(a.out, "README.md"))
print(f"{len(runs)} runs, {len(inds)} individuals -> {a.out}; every stored vector hashes to its digest")
