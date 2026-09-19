"""`aigg:exec:int-lif:v1`, fast and exact, for the FlyBnB analyses.

The published reference visits every record on every step; the pilot's runner visits only the outgoing records of neurons
that spiked. This one also updates only the neurons that have ever been TOUCHED -- stimulated, silenced-and-irrelevant
excepted, or reached by a spike. That is exact, not an approximation: int-lif has no background input, and a neuron
whose v, g and refr are 0 and whose input is 0 stays at 0 under the rule (g - (g*k >> 16) + 0 = 0, v + ((g - v)*k >> 16) = 0).
In half a second a few hundred of the 139,255 neurons spike and a few tens of thousands are ever reached.

`python flybnb/analysis/intlif.py --verify --min5 flywire-783-min5.bin` holds it to the published digests, with and
without a silence set against the dense rule.
"""
import sys, os, json, struct, time, argparse, numpy as np
HERE = os.path.dirname(os.path.abspath(__file__)); ROOT = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, os.environ.get("FLY_BRAIN_DIR", os.path.join(ROOT, "contracts", "lib", "aigg-porw", "gpu", "triton", "demo", "fly_brain")))
import flywire_delta as FD
GOLDEN32 = 0x9E3779B9; M32 = 0xFFFFFFFF
DT_TAU_M_Q16, DT_TAU_S_Q16, THRESH_Q16, W_UNIT_Q16, REFRACT, EXT_P_Q32 = 328, 1311, 458752, 18022, 22, 64424509
I32_MAX, I32_MIN = 2**31 - 1, -(2**31)
REFERENCE = {"joLR": "0x8614eda1e74c604aa4dcebcd6cdcb664f29d90c74af1bb4025f6a3f4a04c2bbd", "joLR+gate": "0x017258be33f72b5ad5deb3e184bda5b1b00d3497af5206fa02abb728de8b1b2b"}   # tasks/flywire-gate: full model, seed 7, 5000 steps

def fmix32(h):
    h = h & M32; h ^= h >> 16; h = (h * 0x85EBCA6B) & M32; h ^= h >> 13; h = (h * 0xC2B2AE35) & M32; h ^= h >> 16; return h

class Net:
    """CSR by presynaptic neuron over the non-zero records"""
    def __init__(self, n, pre, post, w):
        nz = w != 0; pre, post, w = pre[nz], post[nz], w[nz]; o = np.argsort(pre, kind="stable")
        self.n = n; self.post = post[o].astype(np.int64); self.w = w[o].astype(np.float64)
        self.indptr = np.zeros(n + 1, np.int64); np.cumsum(np.bincount(pre, minlength=n), out=self.indptr[1:])

def run(net, seed, steps, stim_ids, silence_ids=None, t_from=None):
    """-> (count, late): spike counts of every neuron over the run, and over steps > t_from (default: the second half)"""
    n = net.n; t_from = steps // 2 if t_from is None else t_from
    silent = np.zeros(n, bool)
    if silence_ids is not None and len(silence_ids): silent[np.asarray(silence_ids, dtype=np.int64)] = True
    stim_ids = np.asarray(stim_ids, dtype=np.int64); stim_live = stim_ids[~silent[stim_ids]]   # silence wins over the stimulus
    stim = np.zeros(n, bool); stim[stim_ids] = True; h0 = fmix32((stim_live.astype(np.uint64) * GOLDEN32 + seed) & M32)
    v = np.zeros(n, np.int64); g = np.zeros(n, np.int64); refr = np.zeros(n, np.int64); count = np.zeros(n, np.int64); late = np.zeros(n, np.int64)
    touched = np.zeros(n, bool); idx = np.zeros(0, np.int64); sp_idx = np.zeros(0, np.int64)
    for s in range(1, steps + 1):
        if len(sp_idx):
            st = net.indptr[sp_idx]; ln = net.indptr[sp_idx + 1] - st; tot = int(ln.sum())
            if tot:
                k = np.repeat(st - (np.cumsum(ln) - ln), ln) + np.arange(tot); tgt = net.post[k]
                new = ~touched[tgt]
                if new.any(): touched[tgt[new]] = True; idx = np.flatnonzero(touched)
                I = np.bincount(tgt, weights=net.w[k], minlength=n).astype(np.int64)[idx]
            else: I = 0
        else: I = 0
        if len(idx):
            gi = g[idx]; gi = gi - ((gi * DT_TAU_S_Q16) >> 16) + I * W_UNIT_Q16; np.clip(gi, I32_MIN, I32_MAX, out=gi); g[idx] = gi
            free = ~(stim[idx] | silent[idx]); ri = refr[idx]; vi = v[idx]
            act = free & (ri == 0); vv = vi + (((gi - vi) * DT_TAU_M_Q16) >> 16); fired = act & (vv >= THRESH_Q16)
            v[idx] = np.where(act & ~fired, vv, 0); refr[idx] = np.where(fired, REFRACT, np.where(free & (ri > 0), ri - 1, 0))
            fired_idx = idx[fired]
        else: fired_idx = np.zeros(0, np.int64)
        e = fmix32((h0 + s * GOLDEN32) & M32) < EXT_P_Q32
        sp_idx = np.concatenate([fired_idx, stim_live[e]]) if len(fired_idx) else stim_live[e]
        count[sp_idx] += 1
        if s > t_from: late[sp_idx] += 1
    return count, late

def digest(n, count): return "0x" + FD.keccak256(struct.pack("<I", n) + count.astype("<u4").tobytes()).hex()

def run_dense(n, pre, post, w, seed, steps, stim_ids, silence_ids):
    """the rule as written, over every neuron and every record: what `run` is held to when a silence set is involved"""
    stim = np.zeros(n, bool); stim[np.asarray(stim_ids, dtype=np.int64)] = True; silent = np.zeros(n, bool); silent[np.asarray(silence_ids, dtype=np.int64)] = True
    v = np.zeros(n, np.int64); g = np.zeros(n, np.int64); refr = np.zeros(n, np.int64); spiked = np.zeros(n, bool); count = np.zeros(n, np.int64); wf = w.astype(np.float64); i = np.arange(n, dtype=np.uint64)
    for s in range(1, steps + 1):
        I = np.bincount(post, weights=wf * spiked[pre], minlength=n).astype(np.int64); g = np.clip(g - ((g * DT_TAU_S_Q16) >> 16) + I * W_UNIT_Q16, I32_MIN, I32_MAX)
        e = fmix32((fmix32((i * GOLDEN32 + seed) & M32) + s * GOLDEN32) & M32) < EXT_P_Q32
        st = stim & ~silent; rf = ~st & ~silent & (refr > 0); fr = ~st & ~silent & (refr == 0)
        vv = v + (((g - v) * DT_TAU_M_Q16) >> 16); fired = fr & (vv >= THRESH_Q16)
        v = np.where(fr & ~fired, vv, 0); refr = np.where(fired, REFRACT, np.where(rf, refr - 1, 0)); spiked = fired | (st & e); count += spiked
    return count

if __name__ == "__main__":
    ap = argparse.ArgumentParser(); ap.add_argument("--verify", action="store_true"); ap.add_argument("--min5", default=os.environ.get("FLYBNB_MIN5")); a = ap.parse_args()
    if not (a.verify and a.min5): sys.exit("usage: intlif.py --verify --min5 <flywire-783-min5.bin>")
    B = FD.decode_payload(open(a.min5, "rb").read()); G = json.load(open(os.path.join(HERE, "groups_flywire783.json"))); ok = True
    pre, post, w = B["pre"].astype(np.int64), B["post"].astype(np.int64), B["w"].astype(np.int64); net = Net(B["n"], pre, post, w)
    jo = list(G["joA_L"]) + list(G["joB_L"]) + list(G["joA_R"]) + list(G["joB_R"])
    for name, ids in [("joLR+gate", jo + list(G["gate"])), ("joLR", jo)]:
        t0 = time.time(); count, _ = run(net, 7, 5000, ids); d = digest(B["n"], count); ok &= d == REFERENCE[name]
        print(name, d, "== published" if d == REFERENCE[name] else "!= " + REFERENCE[name], f"({time.time() - t0:.1f} s, {int((count > 0).sum())} active)")
    # a silence set, against the rule as written: silence the busiest free neurons and one stimulated neuron
    base, _ = run(net, 7, 600, jo); stimset = set(jo); busy = [int(i) for i in np.argsort(-base) if base[i] > 0 and int(i) not in stimset][:30]; sil = busy + [jo[0]]
    t0 = time.time(); fast, _ = run(net, 7, 600, jo, sil); t1 = time.time(); dense = run_dense(B["n"], pre, post, w, 7, 600, jo, sil); same = bool((fast == dense).all()); ok &= same
    print(f"silence set of {len(sil)} (600 steps): fast == dense rule: {same}; silenced spikes {int(fast[sil].sum())}; differs from unsilenced: {bool((fast != base).any())} (fast {t1 - t0:.1f} s, dense {time.time() - t1:.1f} s)")
    sys.exit(0 if ok else 1)
