"""The numpy half of the battery audit: rebuild an archived battery's payload and run the battery on it with intlif.py.

  python flybnb/analysis/audit_reference.py --battery flybnb/battery/battery-male-v1.json --archive <job>.json [...] \
      --base malecns-v1.0-min2.bin [--base ...] [--recipes DIR ...] [--fetch --cache DIR] [--workers 4] --out refs.jsonl

Driven by `battery/audit.mjs`, which chooses the sample and joins what this writes with the archived digests. Everything
a result is checked against here is rebuilt from content addresses, not taken from the archive:

  - the battery file must hash to the archive's `batteryVersion` (keccak256 of the file's bytes, as the worker computes it);
  - the payload is either a ROOT (a base whose model_id is the archive's `modelId`) or a DERIVED individual: its root
    base with its FLYDELTA recipe applied in place (FD.apply_any), and model_id of the result must equal `modelId`;
  - a derived individual must be drawn on the battery's population base, since the battery's weight unit belongs to it;
  - the battery runs over the payload AS REGISTERED: every record it carries, no min_syn threshold. A derived
    individual's genotype already zeroes what falls under min_syn; a root substrate does not, and is a different
    network from the dataset's thresholded `base` row (flybnb/battery/README.md, the section on #80).

A base is found by model_id among the `--base` files, the cache (`<cache>/<model_id>.bin`), or with `--fetch` on the
Pages mirror named by the committed profiles. A recipe is found by delta id (`<dir>/<delta id>.delta`) in `--recipes`,
the cache, or with `--fetch` on the founder-asset mirror. Fetched bytes are cached only after their hash checks. The
audit itself reads no chain and writes nothing but `--out`.

One output line per archive, in order: the reference row ({stim, seed, digest, total, active} per run, the shape
run_battery.py writes) or {"error": ...} when the payload cannot be rebuilt -- which the auditor reports as a failure,
never as a pass.
"""
import sys, os, json, time, glob, argparse, urllib.error, urllib.request, numpy as np
HERE = os.path.dirname(os.path.abspath(__file__)); ROOT = os.path.dirname(os.path.dirname(HERE)); sys.path.insert(0, HERE)
import intlif as IL; FD = IL.FD
from run_battery import population

BRAINS_MIRROR = "https://aigg-brains.pages.dev/aigg-brains/"; DELTA_MIRROR = "https://aigg-founder-assets.pages.dev/deltas/"
UA = {"User-Agent": "flybnb-battery-audit/1"}   # the Pages edge refuses urllib's default agent
hx = lambda b: "0x" + b.hex()

def committed_profiles():
    """model_id -> where the committed profiles say its bytes are, and the founders' recipes by model_id (older archives
    carry no delta id). Only locations and ids come from here; bytes are always checked against the content address."""
    where, founders = {}, {}
    for f in glob.glob(os.path.join(ROOT, "flybnb", "*", "*.v3.json")):
        p = json.load(open(f)); da = p.get("weightsDA", "")
        if da.startswith("gnfd://aigg-brains/"): where[p["modelId"].lower()] = BRAINS_MIRROR + da.split("/")[-1]
    g = json.load(open(os.path.join(ROOT, "flybnb", "genesis", "founder-profiles-v2.json")))
    for b in g["bases"]: where.setdefault(b["modelId"].lower(), b["weightsDA"])
    for x in g["founders"]: founders[x["modelId"].lower()] = x["deltaHash"].lower()
    return where, founders

def fetch(url):
    """the whole object, or its parts when the mirror holds it in parts (js/mirror_pack.mjs)"""
    get = lambda u: urllib.request.urlopen(urllib.request.Request(u, headers=UA), timeout=120).read()
    try: return get(url)
    except urllib.error.HTTPError as e:
        if e.code != 404: raise
    m = json.loads(get(url + ".parts.json")); b = b"".join(get(f"{url}.part{i}") for i in range(m["parts"]))
    if len(b) != m["size"]: raise ValueError(f"{url}: parts reassemble to {len(b)} bytes, manifest says {m['size']}")
    return b

class Store:
    def __init__(self, bases, recipes, cache, online):
        self.base_files, self.recipe_dirs, self.cache, self.online = list(bases), list(recipes), cache, online
        self.bases, self.where, self.founders = {}, *committed_profiles()
        if cache: os.makedirs(cache, exist_ok=True)
    def _put(self, name, b):
        if self.cache: tmp = os.path.join(self.cache, name + ".tmp"); open(tmp, "wb").write(b); os.replace(tmp, os.path.join(self.cache, name))
    def base(self, mid):
        """the payload whose model_id is `mid`, or None"""
        mid = mid.lower()
        if mid in self.bases: return self.bases[mid]
        cands = self.base_files + ([os.path.join(self.cache, mid + ".bin")] if self.cache else [])
        while cands:
            f = cands.pop(0)
            if not os.path.exists(f): continue
            b = open(f, "rb").read(); got = hx(FD.model_id(b)); self.bases[got] = b
            if f in self.base_files: self.base_files.remove(f)   # hashed once per process
            if got == mid: return b
        if self.online and mid in self.where:
            b = fetch(self.where[mid]); got = hx(FD.model_id(b))
            if got != mid: raise ValueError(f"{self.where[mid]} is model {got}, not {mid}")
            self.bases[mid] = b; self._put(mid + ".bin", b); return b
        return None
    def recipe(self, did):
        did = did.lower()
        for d in self.recipe_dirs + ([self.cache] if self.cache else []):
            f = os.path.join(d, did + ".delta")
            if os.path.exists(f):
                b = open(f, "rb").read()
                if hx(FD.delta_id(b)) != did: raise ValueError(f"{f} is delta {hx(FD.delta_id(b))}, not {did}")
                return b
        if self.online:
            b = fetch(DELTA_MIRROR + did + ".delta")
            if hx(FD.delta_id(b)) != did: raise ValueError(f"the mirror's {did}.delta is delta {hx(FD.delta_id(b))}")
            self._put(did + ".delta", b); return b
        raise LookupError(f"recipe {did} not found (--recipes DIR with <delta id>.delta, or --fetch)")
    def parents(self, delta, acc=None):
        """every ancestor recipe a v3 cross names, by delta id (founders and the collection's children name none)"""
        acc = {} if acc is None else acc
        if delta[:12] != FD.MAGIC_DELTA3: return acc
        D = FD.decode_delta3(delta)
        for pid in (D["parent_a"], D["parent_b"]):
            if pid != FD.ZERO_ID and pid not in acc: acc[pid] = self.recipe(hx(pid)); self.parents(acc[pid], acc)
        return acc

def rebuild(store, archive, battery):
    """-> (payload bytes, provenance): the executed payload, rebuilt from content addresses and held to the archive's modelId"""
    mid = str(archive.get("modelId", "")).lower(); P = population(battery)
    if not mid.startswith("0x") or len(mid) != 66: raise ValueError("the archive names no modelId")
    did = (archive.get("deltaHash") or "").lower()
    if did in ("", "0x" + "0" * 64): did = store.founders.get(mid, "")
    root = None if did else store.base(mid)
    if root is not None: return root, {"kind": "root", "model_id": mid}
    if not did: raise LookupError(f"model {mid} is no base provided and the archive names no recipe (deltaHash), nor is it a committed founder")
    delta = store.recipe(did); D = (FD.decode_delta3 if delta[:12] == FD.MAGIC_DELTA3 else FD.decode_delta2 if delta[:12] == FD.MAGIC_DELTA2 else FD.decode_delta)(delta)
    bmid = hx(D["base_model_id"])
    if archive.get("baseModelId") and archive["baseModelId"].lower() != bmid: raise ValueError(f"recipe {did} binds base {bmid}, the archive says {archive['baseModelId']}")
    if bmid != P["base_model_id"].lower(): raise ValueError(f"recipe {did} is drawn on base {bmid}, not this battery's population base {P['base_model_id']}: its weight unit does not apply")
    base = store.base(bmid)
    if base is None: raise LookupError(f"base {bmid} not found (--base FILE, or --fetch)")
    payload = FD.apply_any(base, delta, store.parents(delta)); got = hx(FD.model_id(payload))
    if got != mid: raise ValueError(f"base {bmid} with recipe {did} is model {got}, not the archived {mid}")
    return payload, {"kind": "derived", "model_id": mid, "base_model_id": bmid, "delta_id": did}

_S = {}
def _run(job):
    st, seed = job; count, _ = IL.run(_S["net"], seed, _S["steps"], st["neuron_index"], w_unit=_S["unit"])
    return {"stim": st["name"], "seed": seed, "digest": IL.digest(_S["net"].n, count), "total": int(count.sum()), "active": int((count > 0).sum())}

def reference(payload, battery, workers=1):
    """the battery's rows for this payload, every record as registered, at the population's weight unit"""
    B = FD.decode_payload(payload)
    if B["n"] != battery["neurons"]: raise ValueError(f"payload has {B['n']} neurons, the battery {battery['neurons']}")
    _S.update(net=IL.Net(B["n"], B["pre"], B["post"], B["w"]), steps=battery["steps"], unit=population(battery)["w_unit_q16"])
    jobs = [(st, seed) for st in battery["stimuli"] for seed in battery["seeds"]]   # run k = stimulus k // seeds, seed k % seeds
    if workers > 1:
        import multiprocessing as mp
        with mp.get_context("fork").Pool(workers) as pool: rows = pool.map(_run, jobs, chunksize=1)
    else: rows = [_run(j) for j in jobs]
    return rows, int(len(B["w"]))

def main():
    ap = argparse.ArgumentParser(); ap.add_argument("--battery", required=True); ap.add_argument("--archive", nargs="+", required=True)
    ap.add_argument("--base", action="append", default=[]); ap.add_argument("--recipes", action="append", default=[]); ap.add_argument("--cache", default=None)
    ap.add_argument("--fetch", action="store_true", help="fetch missing bases/recipes from the Pages mirrors (checked, then cached)")
    ap.add_argument("--workers", type=int, default=1); ap.add_argument("--out", required=True); a = ap.parse_args()
    raw = open(a.battery, "rb").read(); battery = json.loads(raw); version = hx(FD.keccak256(raw)); unit = population(battery)["w_unit_q16"]
    store = Store(a.base, a.recipes, a.cache, a.fetch)
    with open(a.out, "w") as out:
        for f in a.archive:
            t0 = time.time(); archive = json.load(open(f)); line = {"archive": f, "taskId": archive.get("taskId"), "model_id": archive.get("modelId")}
            try:
                if archive.get("batteryVersion") and archive["batteryVersion"].lower() != version: raise ValueError(f"the archive was run under battery {archive['batteryVersion']}, this file is {version}")
                payload, prov = rebuild(store, archive, battery); t1 = time.time()
                rows, records = reference(payload, battery, a.workers)
                line.update(prov, battery=battery["name"], battery_version=version, w_unit_q16=unit, records=records, rows=rows, t_rebuild_s=round(t1 - t0, 1), t_battery_s=round(time.time() - t1, 1))
            except Exception as e: line["error"] = f"{type(e).__name__}: {e}"
            out.write(json.dumps(line, separators=(",", ":")) + "\n"); out.flush()
            msg = line["error"] if "error" in line else "%d runs, rebuilt in %s s, battery in %s s" % (len(line["rows"]), line["t_rebuild_s"], line["t_battery_s"])
            print(f"{f}: {msg}", file=sys.stderr, flush=True)

if __name__ == "__main__": main()
