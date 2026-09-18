// Recompute every scheme-dependent id of this task from the real payload with the aigg-porw code in this checkout
// (its SCHEME_ID, weights Merkle root, synapse root, exec kind): modelId, synapseRoot, schemeDigest, execKind, mepId for the
// three models (the two edited ones are rebuilt from their FLYDELTAv1 deltas), and the task ids (keccak(mepId, seed, nonce)).
// execDigest / execRoot / inputCommit do not depend on the scheme and are left alone.
//   node tasks/flywire-gate/recompute_ids.mjs /path/to/flywire-783-min5.bin            rewrite task.json + fields/*.json
//   node tasks/flywire-gate/recompute_ids.mjs /path/to/flywire-783-min5.bin --check    exit 1 if anything is stale
import fs from "node:fs"; import path from "node:path"; import { keccak256, encodePacked } from "viem";
const here = path.dirname(new URL(import.meta.url).pathname); const porwDir = path.join(here, "../../contracts/lib/aigg-porw/web/porw-browser"); const porw = (f) => import(path.join(porwDir, f));
const [basePath, flag] = process.argv.slice(2); if (!basePath) { console.log("usage: recompute_ids.mjs <flywire-783-min5.bin> [--check]"); process.exit(2); }
const V = await porw("verify.js"); const { PorwNode } = await porw("node.js"); const { loadKernelFromBytes } = await porw("porw.js"); const { applyDelta } = await porw("delta.js");
const wasm = fs.readFileSync(path.join(porwDir, "sketch.wasm")); const base = new Uint8Array(fs.readFileSync(basePath)); const T = JSON.parse(fs.readFileSync(path.join(here, "task.json"), "utf8")); const stale = [];
console.log(`scheme in this checkout: ${V.SCHEME_ID} (${V.hex(V.schemeDigest())})`);
for (const [name, m] of Object.entries(T.models)) {
  const payload = m.delta ? applyDelta(base, new Uint8Array(fs.readFileSync(path.join(here, m.delta.file)))) : base;
  const nd = new PorwNode(await loadKernelFromBytes(wasm), { privHex: "0x" + "33".repeat(32) }); const st = await nd.loadModel(name, payload, { steps: T.steps, exec: "lif", commitStride: T.commitStride }); const mep = st.mep;
  const now = { mepId: V.hex(mep.mepId), modelId: V.hex(mep.modelId), schemeDigest: V.hex(mep.schemeDigest), execKind: V.hex(mep.execKind), steps: mep.steps, clampQ16: mep.clampQ16, neurons: st.hdr.neurons, synapses: st.hdr.synapses, synapseRoot: V.hex(st.csr.synapseRoot) };
  for (const [k, v] of Object.entries(now)) if (m.mep[k] !== v) stale.push(`${name}.${k}: ${m.mep[k]} -> ${v}`);
  Object.assign(m.mep, now); m.mep.schemeId = V.SCHEME_ID;
  const fp = path.join(here, "fields", name + ".json"); if (fs.existsSync(fp)) { const f = JSON.parse(fs.readFileSync(fp, "utf8")); Object.assign(f, now, { schemeId: V.SCHEME_ID }); if (flag !== "--check") fs.writeFileSync(fp, JSON.stringify(f, null, 1)); }
}
for (const t of T.tasks) { const id = keccak256(encodePacked(["bytes32", "uint32", "bytes32"], [T.models[t.model].mep.mepId, T.stimulusSeed, t.nonce])); if (t.anvil && t.anvil.taskId !== id) { stale.push(`task ${t.model}|${t.stimulusSet}: taskId ${t.anvil.taskId.slice(0, 12)}… -> ${id.slice(0, 12)}…`); t.anvil = { taskId: id, note: "ids recomputed for a newer scheme; the anvil run recorded earlier used the previous ids — rerun e2e_gate_task.mjs to refresh the record" }; } t.taskId = id; }
if (stale.length) { console.log(`${stale.length} stale values:`); for (const s of stale) console.log("  " + s); } else console.log("every id in task.json matches the payload under this scheme");
if (flag === "--check") process.exit(stale.length ? 1 : 0);
fs.writeFileSync(path.join(here, "task.json"), JSON.stringify(T, null, 1)); console.log("task.json and fields/*.json written");
