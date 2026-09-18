// Recompute every scheme-dependent id of this task from the real payload with an aigg-porw checkout (its SCHEME_ID,
// weights Merkle root, synapse root, exec kind). Results are kept PER SCHEME in task.json (models[*].mepByScheme[schemeId]),
// because the ids of one payload differ between schemes while execDigest / execRoot / initStateRoot do not:
//   sketch-tile-keccak:v1  mep_id = keccak(scheme, modelId, execKind, steps, stride); taskId = keccak(mepId, seed, nonce)
//   sketch-tile-keccak:v2  mep_id = keccak(scheme, modelId, execKind, neurons, synapses, synapseRoot); steps and stride are the
//                          Task's; taskId = keccak(abi.encode(task, nonce)) covers fee and deadline, so it exists only at post time
// The two edited models are rebuilt from their FLYDELTAv1 deltas when the checkout has delta.js, else read as <name>.bin
// next to the base payload.
//   node tasks/flywire-gate/recompute_ids.mjs <flywire-783-min5.bin> [--porw /path/to/aigg-porw/web/porw-browser] [--check]
import fs from "node:fs"; import path from "node:path"; import { keccak256, encodePacked } from "viem";
const here = path.dirname(new URL(import.meta.url).pathname); const argv = process.argv.slice(2); const basePath = argv.find((a) => !a.startsWith("--") && argv[argv.indexOf(a) - 1] !== "--porw");
const porwDir = argv.includes("--porw") ? path.resolve(argv[argv.indexOf("--porw") + 1]) : path.join(here, "../../contracts/lib/aigg-porw/web/porw-browser"); const check = argv.includes("--check"); const porw = (f) => import(path.join(porwDir, f));
if (!basePath) { console.log("usage: recompute_ids.mjs <flywire-783-min5.bin> [--porw dir] [--check]"); process.exit(2); }
const V = await porw("verify.js"); const { PorwNode } = await porw("node.js"); const { loadKernelFromBytes } = await porw("porw.js"); const delta = fs.existsSync(path.join(porwDir, "delta.js")) ? await porw("delta.js") : null;
const wasm = fs.readFileSync(path.join(porwDir, "sketch.wasm")); const base = new Uint8Array(fs.readFileSync(basePath)); const T = JSON.parse(fs.readFileSync(path.join(here, "task.json"), "utf8")); const stale = []; const S = V.SCHEME_ID;
console.log(`scheme of ${porwDir}: ${S} (${V.hex(V.schemeDigest())})`);
for (const [name, m] of Object.entries(T.models)) {
  const payload = !m.delta ? base : delta ? delta.applyDelta(base, new Uint8Array(fs.readFileSync(path.join(here, m.delta.file)))) : new Uint8Array(fs.readFileSync(path.join(path.dirname(basePath), name + ".bin")));
  const nd = new PorwNode(await loadKernelFromBytes(wasm), { privHex: "0x" + "33".repeat(32) }); const st = await nd.loadModel(name, payload, { steps: T.steps, maxSteps: 1, exec: "lif", commitStride: T.commitStride }); const mep = st.mep;
  const now = { schemeId: S, schemeDigest: V.hex(mep.schemeDigest), mepId: V.hex(mep.mepId), modelId: V.hex(mep.modelId), execKind: V.hex(mep.execKind), neurons: st.hdr.neurons, synapses: st.hdr.synapses, synapseRoot: V.hex(st.csr.synapseRoot) };
  if (mep.steps !== undefined) Object.assign(now, { steps: mep.steps, clampQ16: mep.clampQ16 }); else now.note = "steps and commit stride belong to the Task under this scheme";
  m.mepByScheme = m.mepByScheme || {}; const old = m.mepByScheme[S] || {}; for (const [k, v] of Object.entries(now)) if (old[k] !== v) stale.push(`${name} [${S}] ${k}: ${old[k]} -> ${v}`); m.mepByScheme[S] = now;
  const fp = path.join(here, "fields", `${name}.${S.split(":").pop()}.json`); if (!check) fs.writeFileSync(fp, JSON.stringify({ name, sha256: m.payload.sha256, ...now }, null, 1));
}
const v1 = Object.values(T.models)[0].mepByScheme[S].steps !== undefined;
for (const t of T.tasks) { t.taskIdByScheme = t.taskIdByScheme || {}; const id = v1 ? keccak256(encodePacked(["bytes32", "uint32", "bytes32"], [T.models[t.model].mepByScheme[S].mepId, T.stimulusSeed, t.nonce])) : "post-time: keccak(abi.encode(Task{mepId, stimulusSeed, steps, commitStride, initStateRoot, fee, deadline, redundancy}, nonce))"; if (t.taskIdByScheme[S] !== id) stale.push(`task ${t.model}|${t.stimulusSet} [${S}] taskId`); t.taskIdByScheme[S] = id; }
console.log(stale.length ? `${stale.length} values new or changed for ${S}:\n  ` + stale.join("\n  ") : `every ${S} id in task.json matches the payload`);
if (check) process.exit(stale.length ? 1 : 0);
fs.writeFileSync(path.join(here, "task.json"), JSON.stringify(T, null, 1)); console.log("task.json and fields/*.<scheme version>.json written");
