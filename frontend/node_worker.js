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
import * as V from "/porw/verify.js";
import { decodeHeader } from "/porw/model.js";

const hex = (b) => "0x" + Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const unhex = (s) => Uint8Array.from(s.slice(2).match(/../g).map((h) => parseInt(h, 16)));
const reply = (m, data) => self.postMessage({ ok: true, reqId: m.reqId, ...data });
const say = (op, data) => self.postMessage({ op, ...data });

let node = null, rc = null, svc = null;
const pending = new Map(); // mepId -> bytes, kept here so the page never holds a 28 MB payload

const ops = {
  async init({ privHex, domains, delegation }) {
    node = new PorwNode(await loadKernel("/porw/sketch.wasm"), { privHex, domains, delegation });
    return { address: hex(node.key.address) };
  },
  // model_id is the whole point of downloading a brain: the bytes are accepted only if they reproduce what the
  // MEP pins on-chain. Recomputing it is a keccak over every 4 KiB tile -- 28 MB of it, which is why it is here.
  async prepare({ mepId, bytes }) {
    const b = new Uint8Array(bytes); pending.set(mepId, b);
    const nT = Math.floor(b.length / V.TILE_BYTES); const lv = [];
    for (let t = 0; t < nT; t++) lv.push(V.weightsLeaf(t, b.subarray(t * V.TILE_BYTES, (t + 1) * V.TILE_BYTES)));
    const hdr = decodeHeader(b);
    return { modelId: hex(V.merkleRoot(lv)), name: hdr.name, neurons: hdr.neurons, synapses: hdr.synapses, bytes: b.length };
  },
  async host({ mepId, name, steps, exec, commitStride }) {
    const bytes = pending.get(mepId); if (!bytes) throw new Error("no bytes prepared for this brain");
    const st = await node.loadModel(name, bytes, { steps, exec, commitStride });
    const local = hex(st.mep.mepId).toLowerCase();
    if (svc && local === mepId) svc.serve(st.mep.mepId);
    return { localMepId: local, matches: local === mepId, neurons: st.hdr.neurons };
  },
  async relay({ url }) { rc = new RelayClient([url], node.key, { onLog: (m) => say("log", { msg: m }) }); const n = await rc.connect();
    svc = new NodeService(node, rc, { onResult: (res) => say("result", { res }) }); return { connected: n }; },
  async announce({ mepId, challenge }) {
    const t0 = performance.now(); const { r } = await svc.announce(unhex(mepId), unhex(challenge), { stimulusSeed: 1 });
    const t = r.timings || {}; const slot = (t.sketchMs || 0) + (t.commitMs || 0) + (t.inferMs || 0) + (t.disputeCommitMs || 0);
    return { claimHash: hex(r.claimHash), slotMs: Math.round(slot || performance.now() - t0) };
  },
  async close() { try { rc && rc.close(); } catch {} return {}; },
};

self.onmessage = async (ev) => {
  const m = ev.data; const fn = ops[m.op];
  if (!fn) return self.postMessage({ ok: false, reqId: m.reqId, error: "unknown op " + m.op });
  try { reply(m, await fn(m)); } catch (e) { self.postMessage({ ok: false, reqId: m.reqId, error: String(e.message || e) }); }
};
