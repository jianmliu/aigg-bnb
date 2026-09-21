// The node itself, off the main thread. Holding the brain resident and proving it is seconds of single-threaded
// wasm per epoch per brain -- on the main thread that is seconds of frozen page, every epoch, for every brain the
// tab hosts. Nothing here needs the DOM or the wallet, so all of it lives in a worker: the kernel, the resident
// models, the relay connection and the service that answers audits and tasks. The page keeps the UI, the wallet
// and the chain calls, and talks to this over a small request/response protocol.
//
// A plain worker, not a shared-memory one: it needs no SharedArrayBuffer, so the page needs no COOP/COEP and can
// fetch a brain from any host that does ordinary CORS. Restoring the multi-threaded kernel would mean taking
// those headers back on, deliberately, in exchange for the throughput.
import { loadKernel } from "/porw/porw.js";
import { PorwNode } from "/porw/node.js";
import { RelayClient } from "/porw/relay_client.js";
import { NodeService } from "/porw/node_service.js";
import { FamilyNodeService } from "/porw/family_service.js";
import { FamilyReplayJournal } from "/porw/family_journal.js";
import * as V from "/porw/verify.js";
import { decodeHeader } from "/porw/model.js";
import { isDelta2, isDelta3, decodeDelta2, decodeDelta3, applyDelta, LAYOUT } from "/porw/delta.js";

const hex = (b) => "0x" + Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const unhex = (s) => Uint8Array.from(s.slice(2).match(/../g).map((h) => parseInt(h, 16)));
const reply = (m, data) => self.postMessage({ ok: true, reqId: m.reqId, ...data });
const say = (op, data) => self.postMessage({ op, ...data });

let node = null, rc = null, svc = null, familySvc = null, identity = null, familyMode = false;
let nextResolveId = 0;
const familyResolvers = new Map();
const resolveFamily = (env) => new Promise((resolve, reject) => {
  const resolveId = ++nextResolveId;
  const timer = setTimeout(() => { familyResolvers.delete(resolveId); reject(new Error("family resolution timed out")); }, 60000);
  familyResolvers.set(resolveId, { resolve, reject, timer });
  say("family-resolve", { resolveId, env });
});
// The base a delta was applied over, kept between prepares: the individuals of one collection all edit the same one,
// and re-fetching it per fly is tens of megabytes each time. One at a time, and only until `releaseBase`.
let heldBase = null;
const pending = new Map(); // mepId -> bytes, kept here so the page never holds a 28 MB payload

const ops = {
  async init({ privHex, domains, delegation }) {
    identity = { privHex, domains, delegation };
    node = new PorwNode(await loadKernel("/porw/sketch.wasm"), identity);
    return { address: hex(node.key.address) };
  },
  // model_id is the whole point of downloading a brain: the bytes are accepted only if they reproduce what the
  // MEP pins on-chain. Recomputing it is a keccak over every 4 KiB tile -- 28 MB of it, which is why it is here.
  /** What a brain's bytes are: a whole payload, or a DELTA that has to be applied to one. An individual of a
   *  collection is published as a delta -- a few hundred bytes of edits over a base everybody already has -- so
   *  `bytes` is then the base and `delta` the edits, and the model is what applying them produces. The page reads
   *  which it is from the bytes themselves and fetches the base if it has to; here the two cases only differ in
   *  where the payload comes from, and what is kept afterwards is the payload either way. */
  async deltaInfo({ bytes }) {
    const b = new Uint8Array(bytes);
    const d = isDelta3(b) ? decodeDelta3(b) : isDelta2(b) ? decodeDelta2(b) : null;
    if (!d) return { isDelta: false, bytes: b.length };
    if (d.layout !== undefined && d.layout !== LAYOUT.inplace) throw new Error("this delta is in the compact layout, which the page cannot apply yet");
    return { isDelta: true, baseModelId: hex(d.baseModelId), name: d.name ?? null, bytes: b.length };
  },
  /** Does this worker still hold the base a delta needs? Every individual of a collection is a delta over the same
   *  base, so preparing a second one should not mean fetching 77 MB again. Held only while brains are being
   *  prepared, and only one: `releaseBase` is what ends it, and the page calls that once the node is up. */
  async hasBase({ modelId }) { return { held: heldBase?.modelId === modelId?.toLowerCase(), bytes: heldBase?.bytes.length ?? 0 }; },
  async releaseBase() { const was = heldBase?.bytes.length ?? 0; heldBase = null; return { freed: was }; },
  async prepare({ mepId, bytes, delta = null, baseModelId = null }) {
    let b = bytes ? new Uint8Array(bytes) : null;
    if (!b && baseModelId && heldBase?.modelId === baseModelId.toLowerCase()) b = heldBase.bytes; // the base is already here
    if (!b) throw new Error("no bytes to prepare from");
    if (delta && baseModelId) heldBase = { modelId: baseModelId.toLowerCase(), bytes: b }; // keep it for the next individual
    // Applying is what produces the individual: byte for byte what a direct publication of it would have been, and
    // so the same model_id. The in-place layout applies in plain JS, which is why this needs no kernel and can run
    // before the node exists -- the page prepares a brain long before it decides to host one.
    if (delta) b = applyDelta(b, new Uint8Array(delta), { baseModelId: baseModelId ? unhex(baseModelId) : null });
    pending.set(mepId, b);
    const hdr = decodeHeader(b); const prof = V.profileOf(b, hdr); // model id AND the CSR roots: mep_id binds both now
    return { modelId: hex(prof.modelId), synapseRoot: hex(prof.synapseRoot), name: hdr.name, neurons: hdr.neurons, synapses: hdr.synapses, bytes: b.length, applied: !!delta };
  },
  /** `terms`: a profile registered under a beneficiary and a royalty is a DIFFERENT mep id from the same bytes,
   *  and the terms are nowhere in them -- so the host has to be told, or it serves an id nothing on-chain draws. */
  async host({ mepId, name, maxSteps, exec, wUnitQ16 = 0, baseMepId = null, terms = null, family = false }) {
    const bytes = pending.get(mepId); if (!bytes) throw new Error("no bytes prepared for this brain");
    const st = await node.loadModel(name, bytes, { maxSteps: maxSteps || 100, exec, wUnitQ16, baseMepId, terms }); // under another unit, or other terms, the same bytes are another MEP: the id check below is what catches a wrong one
    const local = hex(st.mep.mepId).toLowerCase();
    if (local === mepId.toLowerCase()) {
      st.family = family === true && familyMode;
      pending.delete(mepId);
      if (svc) svc.serve(st.mep.mepId, { tasks: !st.family });
    }
    return { localMepId: local, matches: local === mepId, neurons: st.hdr.neurons };
  },
  async relay({ url, familyMode: enabled = false, maxWorkingBytes = 2 * 1024 ** 3 }) {
    familySvc?.stop(); svc?.stop(); rc?.close();
    familyMode = enabled === true;
    rc = new RelayClient([url], node.key, { onLog: (m) => say("log", { msg: m }) }); const n = await rc.connect();
    svc = new NodeService(node, rc, { onResult: (res) => say("result", { res }) });
    if (familyMode) {
      const executionIdentity = identity;
      const namespace = JSON.stringify({ market: identity.domains?.market, instance: identity.delegation?.instance || hex(node.key.address) }).toLowerCase();
      familySvc = new FamilyNodeService(node, rc, { resolve: resolveFamily, maxWorkingBytes: Math.min(2 * 1024 ** 3, Number(maxWorkingBytes) || 2 * 1024 ** 3),
        createNode: async () => new PorwNode(await loadKernel("/porw/sketch.wasm"), executionIdentity),
        journal: new FamilyReplayJournal(namespace), onResult: (res) => say("result", { res }), onStatus: (status) => say("family-status", status) });
      familySvc.serve();
    }
    for (const st of node.models.values()) svc.serve(st.mep.mepId, { tasks: !st.family });
    return { connected: n };
  },
  async taskReplay({ taskId }) { if (!familySvc) throw new Error("family service is not enabled"); return familySvc.replay(taskId); },
  async announce({ mepId, challenge }) {
    const t0 = performance.now(); const { r } = await svc.announce(unhex(mepId), unhex(challenge)); // residency only: no inference in a claim
    const t = r.timings || {}; const slot = (t.sketchMs || 0) + (t.commitMs || 0) + (t.inferMs || 0) + (t.disputeCommitMs || 0);
    return { claimHash: hex(r.claimHash), slotMs: Math.round(slot || performance.now() - t0) };
  },
  async close() { familySvc?.stop(); svc?.stop(); for (const p of familyResolvers.values()) { clearTimeout(p.timer); p.reject(new Error("worker closed")); } familyResolvers.clear(); try { rc && rc.close(); } catch {} return {}; },
};

self.onmessage = async (ev) => {
  const m = ev.data;
  if (m.op === "familyResolved") { const p = familyResolvers.get(m.resolveId); if (p) { familyResolvers.delete(m.resolveId); clearTimeout(p.timer); m.error ? p.reject(new Error(m.error)) : p.resolve(m.manifest); } return; }
  const fn = ops[m.op];
  if (!fn) return self.postMessage({ ok: false, reqId: m.reqId, error: "unknown op " + m.op });
  try { reply(m, await fn(m)); } catch (e) { self.postMessage({ ok: false, reqId: m.reqId, error: String(e.message || e) }); }
};
