"""FlyBnB pilot: do circuit phenotypes vary between synthetic individuals at all?

The atlas is only worth building if calibrated individual-level wiring noise (the FLYDELTA negative-binomial model, fitted to
left/right hemisphere differences within one brain) moves a phenotype by more than the run-to-run noise of the assay. This
measures exactly that, and nothing else:

  individuals : in-place FLYDELTAv3 founders on the flywire-783-min2 base (min_syn 5, mean ratio 0.92) -- the format an
                individual of the collection has. Individual 0 is the base itself thresholded at 5, i.e. the published
                flywire-783-min5 wiring.
  assays      : the two stimulus sets of the network's first task (tasks/flywire-gate: joLR, joLR+gate), `aigg:exec:int-lif:v1`,
                5000 steps = 0.5 s.
  readouts    : DNge145 (the gated action neuron), the giant fibre, DNp12, the 38 phase-locked listening cells, whole-brain spikes.
  noise floor : the only randomness in int-lif is the hash-driven stimulus train, so "seed" = another realisation of the same
                sound. Every individual is run under the same S seeds -> a two-way layout, variance split into
                between-individual, between-seed and interaction, and an intraclass correlation per phenotype.

The runner is a sparse rewrite of the int-lif reference (only spiking neurons' outgoing records are visited; the stimulus hash
is evaluated on the stimulated cells only). `--verify` checks it against the published reference digests before anything is
trusted.

  python flybnb/analysis/phenotype_variance.py --verify --min5 flywire-783-min5.bin
  python flybnb/analysis/phenotype_variance.py --base flywire-783-min2.bin --individuals 100 --seeds 10 --rows-dir rows/

Needs numpy and the aigg-porw submodule (contracts/lib/aigg-porw: flywire_delta.py is the individual sampler). The payloads are
not in the repository; flybnb/README.md says how to export them and what their content addresses must be.
"""
import sys, os, json, time, struct, argparse, functools, numpy as np
HERE = os.path.dirname(os.path.abspath(__file__)); ROOT = os.path.dirname(os.path.dirname(HERE))   # the aigg-bnb checkout
sys.path.insert(0, os.environ.get("FLY_BRAIN_DIR", os.path.join(ROOT, "contracts", "lib", "aigg-porw", "gpu", "triton", "demo", "fly_brain")))
import flywire_delta as FD
GROUPS = os.path.join(HERE, "groups_flywire783.json")
BASE_MODEL_ID = "0x53a7b48e9265bea68fbd3f3640eda751f8dd7742ac76ae6f9c69f1cddc528135"   # flywire-783-min2 (77,074,432 bytes, sha256 10a9e16f…)
REFERENCE = {"joLR": "0x8614eda1e74c604aa4dcebcd6cdcb664f29d90c74af1bb4025f6a3f4a04c2bbd", "joLR+gate": "0x017258be33f72b5ad5deb3e184bda5b1b00d3497af5206fa02abb728de8b1b2b"}   # tasks/flywire-gate/task.json: full model, seed 7, 5000 steps
GOLDEN32 = 0x9E3779B9; M32 = 0xFFFFFFFF
DT_TAU_M_Q16, DT_TAU_S_Q16, THRESH_Q16, W_UNIT_Q16, REFRACT, EXT_P_Q32 = 328, 1311, 458752, 18022, 22, 64424509
I32_MAX, I32_MIN = 2**31 - 1, -(2**31)
FD.nb_table = functools.lru_cache(maxsize=None)(FD.nb_table)   # the CDF tables depend on (c, r, mean ratio) only: share them across individuals

def fmix32(h):
    h = h & M32; h ^= h >> 16; h = (h * 0x85EBCA6B) & M32; h ^= h >> 13; h = (h * 0xC2B2AE35) & M32; h ^= h >> 16; return h

class Net:
    """CSR by presynaptic neuron over the non-zero records"""
    def __init__(self, n, pre, post, w):
        nz = w != 0; pre, post, w = pre[nz], post[nz], w[nz]; o = np.argsort(pre, kind="stable")
        self.n = n; self.post = post[o].astype(np.int64); self.w = w[o].astype(np.float64)
        self.indptr = np.zeros(n + 1, np.int64); np.cumsum(np.bincount(pre, minlength=n), out=self.indptr[1:])

def run(net, seed, steps, stim_ids, groups, t_from):
    n = net.n; stim_ids = np.asarray(stim_ids, dtype=np.int64); stim = np.zeros(n, bool); stim[stim_ids] = True; free = ~stim
    h0 = fmix32((stim_ids.astype(np.uint64) * GOLDEN32 + seed) & M32)
    v = np.zeros(n, np.int64); g = np.zeros(n, np.int64); refr = np.zeros(n, np.int64); sp_idx = np.zeros(0, np.int64); count = np.zeros(n, np.int64); late = np.zeros(n, np.int64)
    for s in range(1, steps + 1):
        if len(sp_idx):
            st = net.indptr[sp_idx]; ln = net.indptr[sp_idx + 1] - st; tot = int(ln.sum())
            idx = np.repeat(st - (np.cumsum(ln) - ln), ln) + np.arange(tot)
            I = np.bincount(net.post[idx], weights=net.w[idx], minlength=n).astype(np.int64)
            g = g - ((g * DT_TAU_S_Q16) >> 16) + I * W_UNIT_Q16
        else: g = g - ((g * DT_TAU_S_Q16) >> 16)
        np.clip(g, I32_MIN, I32_MAX, out=g)
        e = fmix32((h0 + s * GOLDEN32) & M32) < EXT_P_Q32
        active = free & (refr == 0); vv = v + (((g - v) * DT_TAU_M_Q16) >> 16); fired = active & (vv >= THRESH_Q16)
        v = np.where(active & ~fired, vv, 0); refr = np.where(fired, REFRACT, np.where(free & (refr > 0), refr - 1, 0))
        spiked = fired; spiked[stim_ids] = e
        sp_idx = np.nonzero(spiked)[0]; count[sp_idx] += 1
        if s > t_from: late[sp_idx] += 1
    out = {"total": int(count.sum()), "active": int((count > 0).sum()), "late_total": int(late.sum()), "digest": digest(n, count)}
    for k, ix in groups.items(): out[k] = [int(x) for x in late[ix]]
    return count, out

def digest(n, count): return "0x" + FD.keccak256(struct.pack("<I", n) + count.astype("<u4").tobytes()).hex()

# ---------------------------------------------------------------- workers
_S = {}
def _init(base_path, mid, first_seed):
    try:   # a Pool whose initializer raises respawns workers forever and says nothing: fail loudly instead
        base = open(base_path, "rb").read(); B = FD.decode_payload(base); _S.update(base=base, B=B, sign=np.sign(B["w"]).astype(np.int64), c=np.abs(B["w"]).astype(np.int64))
        _S["mid"] = mid; _S["G"] = json.load(open(GROUPS)); _S["nl"] = FD.base_name_length(base); _S["first_seed"] = first_seed
    except BaseException as e:
        import traceback; traceback.print_exc(); os._exit(1)

def _weights(ind):
    """(thresholded counts, recipe bytes or None). Individual 0 has no recipe: it is the base thresholded at 5, the published wiring"""
    B = _S["B"]
    if ind == 0: return np.where(_S["c"] >= 5, _S["c"], 0), None
    else:
        d = FD.encode_delta3(_S["mid"], B["n"], FD.fit_name(f"pilot{ind}", _S["nl"]), "", FD.ZERO_ID, FD.ZERO_ID, _S["first_seed"] + ind, granularity=0, min_syn=5,
                             mut_rate_q32=FD.MUT_ALWAYS, mean_ratio_q16=60293, layout=1)
        g = FD.genotype(B, _S["mid"], d)
    return g, d

def _job(a):
    ind, seeds, steps, stims, rows_dir = a; B = _S["B"]; G = _S["G"]; t0 = time.time(); g, recipe = _weights(ind); c = _S["c"]
    kept5 = c >= 5; geno = {"records": int((g > 0).sum()), "synapses": int(g.sum()), "lost": int((kept5 & (g == 0)).sum()), "gained": int((~kept5 & (g > 0)).sum()),
            "direct_edges": [int(g[(B["pre"] == p) & (B["post"] == q)].sum()) for p, q in G["direct_edges"]]}
    if recipe is not None:   # what the individual IS on the mesh: the recipe's hash, and the model id of the payload it produces
        geno["recipe_hex"] = recipe.hex(); geno["delta_id"] = "0x" + FD.delta_id(recipe).hex()
        if rows_dir: geno["model_id"] = "0x" + FD.model_id(FD.apply_procedural(_S["base"], recipe)).hex()
    net = Net(B["n"], B["pre"].astype(np.int64), B["post"].astype(np.int64), _S["sign"] * g); t_geno = time.time() - t0; sparse = {}
    groups = {k: np.array(G[k]) for k in ["DNge145", "DNp12", "GF", "locked38", "gate"]}; rows = []
    for stim in stims:
        ids = list(G["joA_L"]) + list(G["joB_L"]) + list(G["joA_R"]) + list(G["joB_R"]) + (list(G["gate"]) if "gate" in stim else [])
        for seed in seeds:
            t1 = time.time(); count, out = run(net, seed, steps, ids, groups, steps // 2); out.update(ind=ind, stim=stim, seed=seed, wall_s=round(time.time() - t1, 1)); rows.append(out)
            if rows_dir: ix = np.nonzero(count)[0]; sparse[f"{stim}|{seed}|idx"] = ix.astype(np.uint32); sparse[f"{stim}|{seed}|n"] = count[ix].astype(np.uint32)
    if rows_dir: np.savez_compressed(os.path.join(rows_dir, f"ind{ind:04d}.npz"), **sparse)   # the whole result of every run: which neurons spiked, how often
    return {"ind": ind, "geno": geno, "t_geno_s": round(t_geno, 1), "rows": rows}

def main():
    ap = argparse.ArgumentParser(); ap.add_argument("--verify", action="store_true"); ap.add_argument("--individuals", type=int, default=40); ap.add_argument("--seeds", type=int, default=5)
    ap.add_argument("--steps", type=int, default=5000); ap.add_argument("--workers", type=int, default=8); ap.add_argument("--first-seed", type=int, default=1000)
    ap.add_argument("--rows-dir", default=None, help="also write every run's sparse spike-count vector (one npz per individual) and the individuals' model ids: the dataset build")
    ap.add_argument("--base", default=os.environ.get("FLYBNB_BASE"), help="the flywire-783-min2 FLYBRAINv2 payload the individuals are laid out on")
    ap.add_argument("--min5", default=os.environ.get("FLYBNB_MIN5"), help="--verify: the flywire-783-min5 payload the reference digests were published for")
    ap.add_argument("--out", default=os.path.join(ROOT, "flybnb/results/pilot/runs.jsonl")); a = ap.parse_args()
    if a.verify:
        if not a.min5: sys.exit("--verify needs --min5 <flywire-783-min5.bin>")
        buf = open(a.min5, "rb").read(); B = FD.decode_payload(buf); G = json.load(open(GROUPS)); ok = True
        net = Net(B["n"], B["pre"].astype(np.int64), B["post"].astype(np.int64), B["w"].astype(np.int64))
        for stim in ["joLR+gate", "joLR"]:
            ids = list(G["joA_L"]) + list(G["joB_L"]) + list(G["joA_R"]) + list(G["joB_R"]) + (list(G["gate"]) if "gate" in stim else [])
            t0 = time.time(); count, out = run(net, 7, 5000, ids, {"DNge145": np.array(G["DNge145"])}, 2500); d = digest(B["n"], count); ok &= d == REFERENCE[stim]
            print(stim, d, "== published" if d == REFERENCE[stim] else "!= published " + REFERENCE[stim], f"({time.time() - t0:.1f} s)", out)
        sys.exit(0 if ok else 1)
    import multiprocessing as mp
    if a.rows_dir: os.makedirs(a.rows_dir, exist_ok=True)
    jobs = [(i, list(range(7, 7 + a.seeds)), a.steps, ["joLR", "joLR+gate"], a.rows_dir) for i in range(a.individuals + 1)]
    done = set()
    if os.path.exists(a.out): done = {json.loads(l)["ind"] for l in open(a.out)}
    jobs = [j for j in jobs if j[0] not in done]; print(f"{len(jobs)} individuals to run ({len(done)} done)", flush=True)
    if not a.base: sys.exit("--base <flywire-783-min2.bin> (or FLYBNB_BASE): see flybnb/README.md for how to export it")
    base_path = a.base; t0 = time.time(); mid = FD.model_id(open(base_path, "rb").read())
    assert "0x" + mid.hex() == BASE_MODEL_ID, f"this is not the base the pilot was run on: model id 0x{mid.hex()}, expected {BASE_MODEL_ID}"
    print(f"base model id 0x{mid.hex()} ({time.time() - t0:.0f}s): the published base", flush=True)
    with mp.Pool(a.workers, initializer=_init, initargs=(base_path, mid, a.first_seed)) as pool, open(a.out, "a") as f:
        t0 = time.time()
        for k, r in enumerate(pool.imap_unordered(_job, jobs), 1):
            f.write(json.dumps(r) + "\n"); f.flush(); print(f"[{k}/{len(jobs)}] ind {r['ind']} geno {r['t_geno_s']}s runs {sum(x['wall_s'] for x in r['rows']):.0f}s  elapsed {time.time() - t0:.0f}s", flush=True)
if __name__ == "__main__": main()
