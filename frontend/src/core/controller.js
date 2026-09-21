// The node: wallet -> bond BNB for the MEPs you host -> delegate a session key (one signature) -> load a brain per
// MEP -> run the node against the relayer (a claim per MEP per epoch, materialize when wanted, audits and tasks for
// every hosted MEP over the relay). Chain state is read through the wallet's provider. Several MEPs (e.g. the
// female and the male brain) can be hosted at once; `state.active` is the one the model panel refers to.
//
// This file is deliberately React-free and holds the only mutable state in the page. Two reasons, and both are
// load-bearing. `test/frontend_memory.mjs` runs this source in a `vm` with a stub `document` and a stub `Worker`
// to exercise the memory arithmetic without allocating gigabytes -- so nothing here may reach for a framework, and
// the import lines it strips must stay one per line. And the memory accounting is the part that decides whether a
// laptop tab survives: it belongs somewhere a re-render cannot reorder it.
//
// The UI observes by subscribing (`setOnChange`) and reading `state`; it never owns any of it. The page never
// holds a payload either: the bytes are transferred to node_worker.js and the model_id is recomputed there.
import { encode, decodeUint, decodeAddress, hex, keccakWords } from "./abi.js";
import { keypair } from "/porw/claim.js";
import * as E from "/porw/eip712.js";
import { modelMemoryBytes, maxStepsWithin, WASM32_MAX_BYTES } from "/porw/mem.js";

const $ = (id) => document.getElementById(id);

// The one channel out of this module. A plain callback rather than an event emitter: there is exactly one
// subscriber (the React root), and under `vm` it has to be harmless to call with nobody listening.
let onChange = () => {};
export const setOnChange = (fn) => { onChange = fn || (() => {}); };
/** for the modules that keep their own slice of `state` (flies.js): say that it moved */
export const notify = () => onChange();

export const log = (m) => {
  const el = $("log"); const stamp = new Date().toISOString().slice(11, 19);
  el.textContent += `[${stamp}] ${m}\n`; el.scrollTop = el.scrollHeight;
  state.lastLog = m; onChange();
};

export const state = { deployment: null, unit: null /* wei per vote, read from this deployment */, meps: [], hosted: new Set(), active: null, wallet: null, chainId: null, chainOk: false,
  walletConnecting: false, walletError: null, walletName: null,
  balance: 0n, bonded: 0n, weight: 0n, exitAt: 0n, inMep: [], session: null, delegation: null, resolved: null, epochInfo: null,
  prepared: new Set(), loaded: {}, node: null, claims: {}, materialized: {}, results: [], errors: [], tasks: [], lastLog: null,
  flies: null, // the collection, as flies.js reads it: null until a deployment that names one is loaded
  flyTerms: null }; // its terms alone -- what a fly costs and how a fee is split. The docs page needs these and no individual

// ---- the worker that actually runs the node ----
let worker = null, nextReq = 1; const waiting = new Map();
function ensureWorker() {
  if (worker) return worker;
  worker = new Worker("/node_worker.js", { type: "module" });
  worker.onmessage = (ev) => {
    const m = ev.data;
    if (m.op === "log") return log(m.msg);
    if (m.op === "result") return onTaskResult(m.res);
    const w = waiting.get(m.reqId); if (!w) return;
    waiting.delete(m.reqId); m.ok ? w.res(m) : w.rej(new Error(m.error));
  };
  worker.onerror = (e) => log("node worker error: " + (e.message || e));
  return worker;
}
const ask = (op, data = {}, transfer = []) => new Promise((res, rej) => { const reqId = nextReq++; waiting.set(reqId, { res, rej }); ensureWorker().postMessage({ op, reqId, ...data }, transfer); });
/** a task the node answered over the relay: the page is what talks to the relayer's API */
async function onTaskResult(res) {
  const r = await api("/tx/result", res); res.submitted = r.ok; state.results.push(res);
  log(`task ${res.taskId.slice(0, 12)}… executed; relayer submitResult ${r.ok ? "ok" : "FAILED " + r.error}`);
}
// EIP-6963 avoids the last-installed extension winning window.ethereum. Keep the
// chosen provider for all reads and signatures, even if another extension replaces the global.
const walletProviders = new Map();
let selectedWallet = null;
window.addEventListener?.("eip6963:announceProvider", ({ detail }) => {
  if (detail?.info?.uuid && typeof detail.provider?.request === "function") walletProviders.set(detail.info.uuid, detail);
});
const discoverWallets = () => window.dispatchEvent?.(new Event("eip6963:requestProvider"));
discoverWallets();
function preferredWallet() {
  const announced = [...walletProviders.values()];
  const meta = announced.find((w) => w.info.rdns === "io.metamask");
  if (meta) return { provider: meta.provider, name: "MetaMask" };
  const legacy = window.ethereum?.providers?.find((p) => p.isMetaMask && !p.isTrust && !p.isBraveWallet);
  if (legacy) return { provider: legacy, name: "MetaMask" };
  if (announced.length) return { provider: announced[0].provider, name: announced[0].info.name };
  return { provider: window.ethereum, name: window.ethereum?.isMetaMask ? "MetaMask" : "wallet" };
}
export const eth = () => selectedWallet || window.ethereum;
// Looking needs no wallet. A read goes through the wallet only when one is connected AND on this deployment's chain --
// the node that just mined your transaction is the one that knows about it -- and otherwise to the deployment's own RPC,
// which the relayer names: a visitor without a wallet can still see the colony, and a wallet left on another chain
// cannot answer for this one. Writes are always the wallet's.
export const read = async (method, params = []) => {
  if (eth() && state.wallet && state.chainOk) return eth().request({ method, params });
  const url = state.deployment?.rpc; if (!url) throw new Error("nothing to read the chain with: no wallet is connected and the deployment names no RPC");
  const r = await (await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) })).json();
  if (r.error) throw new Error(r.error.message || "RPC error"); return r.result;
};
export const call = async (to, sig, args = [], block = "latest") => read("eth_call", [{ to, data: encode(sig, args) }, block]);
export const send = async (to, sig, args = [], value = 0n) => {
  const expectedChain=state.deployment?.chainId, from=state.wallet;
  if(!expectedChain||!from)throw new Error("Connect your wallet on the deployment chain first.");
  const actualChain=await eth().request({method:"eth_chainId"});
  if(Number(actualChain)!==Number(expectedChain))throw new Error("Wallet chain changed; reconnect on the deployment chain.");
  const accounts=await eth().request({method:"eth_accounts"});
  if(accounts[0]?.toLowerCase()!==from.toLowerCase()||state.wallet!==from)throw new Error("Wallet account changed; reconnect before sending.");
  if(state.deployment?.chainId!==expectedChain)throw new Error("Deployment chain changed.");
  const hash = await eth().request({ method: "eth_sendTransaction", params: [{ from, chainId:"0x"+Number(expectedChain).toString(16), to, data: encode(sig, args), value: "0x" + value.toString(16) }] }); log(`tx ${hash.slice(0, 12)}… sent`); for (let i = 0; i < 120; i++) { const r = await eth().request({ method: "eth_getTransactionReceipt", params: [hash] }); if (r) { log(`tx ${hash.slice(0, 12)}… ${r.status === "0x1" ? "confirmed" : "REVERTED"}`); return r; } await new Promise((x) => setTimeout(x, 500)); } throw new Error("receipt timeout"); };

// The relayer URL is read from the DOM rather than from React state on purpose: the field is uncontrolled, so a
// test (or a paste) that sets `#relayer.value` directly is what the next request uses.
export const relayer = () => $("relayer").value.replace(/\/$/, "");
export const api = async (p, body) => (await fetch(relayer() + p, body ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {})).json();

export const mepById = (id) => state.meps.find((m) => m.mepId === id);
export const mepName = (m) => m.name || m.mepId.slice(0, 10);
export const label = (m) => `${m.name || m.mepId.slice(0, 12) + "…"} · ${m.exec} · ${m.neurons.toLocaleString()} neurons`;

export async function loadDeployment() {
  const [deployment, meps] = await Promise.all([api("/deployment"), api("/meps")]);
  state.deployment = deployment; state.meps = meps;
  if (!state.active) state.active = state.meps[0]?.mepId || null;
  if (!state.hosted.size && state.active) state.hosted.add(state.active);
  onChange(); log(`deployment loaded: ${state.meps.length} MEP(s)`); refreshEpoch();
  // what one vote costs is a parameter of THIS deployment (0.05 BNB is the mainnet intent; a testnet's is smaller)
  try { state.unit = decodeUint(await call(deployment.addresses.instances, "UNIT()")); onChange(); } catch (e) { log("could not read UNIT: " + (e.message || e)); }
}
export async function connect() {
  if (state.walletConnecting) return;
  state.walletConnecting = true; state.walletError = null;
  try {
    discoverWallets();
    const choice = selectedWallet ? { provider: selectedWallet, name: state.walletName } : preferredWallet();
    if (!choice.provider) throw new Error("No wallet detected. Enable MetaMask for this site, or open this page in the MetaMask mobile browser.");
    selectedWallet = choice.provider; state.walletName = choice.name; onChange();
    const accts = await eth().request({ method: "eth_requestAccounts" });
    if (!accts?.length) throw new Error("No account selected. Open your wallet and approve the connection.");
    state.wallet = accts[0].toLowerCase();
    const cid = Number(await eth().request({ method: "eth_chainId" })); state.chainId = cid; state.chainOk = cid === state.deployment.chainId;
    if (!state.chainOk) {
      try { await eth().request({ method: "wallet_switchEthereumChain", params: [{ chainId: "0x" + state.deployment.chainId.toString(16) }] }); }
      catch (e) { state.walletError = "Switch your wallet to chain " + state.deployment.chainId + ": " + (e.message || e); log(state.walletError); }
      state.chainId = Number(await eth().request({ method: "eth_chainId" })); state.chainOk = state.chainId === state.deployment.chainId;
    }
    onChange(); log("wallet connected"); await refreshBond();
  } catch (e) {
    state.walletError = Number(e.code) === -32002 ? "A connection request is already pending. Open your wallet extension to approve or cancel it."
      : Number(e.code) === 4001 ? "Connection rejected. Click Connect wallet to try again."
      : String(e.message || e);
    if (!state.wallet) selectedWallet = null;
    throw new Error(state.walletError);
  } finally { state.walletConnecting = false; onChange(); }
}
export async function refreshBond() {
  const a = state.deployment.addresses.instances;
  state.bonded = decodeUint(await call(a, "bonded(address)", [state.wallet]));
  state.weight = decodeUint(await call(a, "weightOf(address)", [state.wallet]));
  state.exitAt = decodeUint(await call(a, "exitAt(address)", [state.wallet]));
  state.balance = BigInt(await eth().request({ method: "eth_getBalance", params: [state.wallet, "latest"] }));
  const inMep = []; for (const m of state.meps) if (decodeUint(await call(a, "inMep(bytes32,address)", [m.mepId, state.wallet])) !== 0n) inMep.push(mepName(m));
  state.inMep = inMep; onChange();
}
/** bond for every hosted MEP (a top-up adds MEPs to an existing bond) */
export async function bond() {
  const ids = [...state.hosted]; if (!ids.length) throw new Error("choose at least one MEP to host");
  const v = BigInt(Math.round(parseFloat($("amount").value) * 1e6)) * 10n ** 12n;
  if (v <= 0n) throw new Error("the registry needs a positive amount (a small top-up adds MEPs to an existing bond)");
  await send(state.deployment.addresses.instances, "bond(bytes32[])", [ids], v); await refreshBond();
}
export async function requestExit() { await send(state.deployment.addresses.instances, "requestExit()"); await refreshBond(); }
export async function finalizeExit() { await send(state.deployment.addresses.instances, "finalizeExit()"); await refreshBond(); }

export function sessionKey() {
  if (state.session) return state.session;
  let priv = null; try { priv = localStorage.getItem("porw-session-priv"); } catch {}
  const k = keypair(priv); try { localStorage.setItem("porw-session-priv", hex(k.priv)); } catch {}
  state.session = k; onChange(); return k;
}
export async function delegate() {
  const k = sessionKey(); const w = E.injectedWallet(eth()); await w.connect();
  const expiry = Number(await eth().request({ method: "eth_blockNumber" })) + Number($("expiry").value || 100000);
  state.delegation = await E.makeDelegation(w, state.deployment.domains.registry, hex(k.address), expiry);
  log("delegation signed by the wallet (the only wallet signature the node needs)");
  const r = await api("/tx/delegate", { instance: state.delegation.instance, session: state.delegation.session, expiry: state.delegation.expiry, sig: state.delegation.sig });
  log(`relayer submitted delegateBySig: ${r.ok ? "ok" : "FAILED " + r.error}`);
  state.resolved = decodeAddress(await call(state.deployment.addresses.instances, "resolve(address)", [hex(k.address)])); onChange();
}
/** load the ACTIVE MEP's brain (file or URL). The bytes go straight to the worker, which recomputes the keccak
 *  weights root over every 4 KiB tile and reports it back: a brain is accepted only if that reproduces the
 *  model_id the MEP pins on-chain, so a wrong or hostile source can only waste the download. */
/** Fetch a brain's bytes, and SAY what went wrong when they do not arrive.
 *
 *  A storage provider answers a refusal with a body, not a hang, and the page used to drop both on the floor: the
 *  error went to the log, `loaded` was never set, and every view kept showing "loading" for ever. That is how a
 *  spent read quota looks from a tab -- the commonest failure a host will meet, because a hundred individuals of a
 *  collection all pull the same tens of megabytes of base, and the bucket's allowance is finite. Greenfield answers
 *  it as 406 with `<Message>bucket quota overflow</Message>`, which is a sentence worth passing on rather than
 *  swallowing: nothing about it is the host's fault, and nothing about it gets better by waiting. */
async function fetchOne(url) {
  let r; try { r = await fetch(url); } catch (e) { throw new Error(`could not reach ${new URL(url, location.href).host} — ${e.message}`); }
  // A static host that does not have the file often says so with a PAGE rather than a status: Cloudflare Pages
  // answers 200 and its index.html for anything missing. Taking that for a brain gets "bad payload magic" three
  // steps later, so it is read here for what it is -- the file is not there, whatever the status line claims.
  if (r.ok && /^text\/html/i.test(r.headers.get("content-type") || "")) throw new Error("answered 404 in spirit: a web page where a brain should be");
  if (!r.ok) {
    const body = await r.text().catch(() => ""); const said = /<Message>([^<]+)<\/Message>/.exec(body)?.[1] || body.trim().slice(0, 120);
    const hint = r.status === 406 ? " — a spent read quota: it has to be topped up, or the brain fetched from somewhere else" : "";
    throw new Error(`answered ${r.status}${said ? ` (${said})` : ""}${hint}`);
  }
  return new Uint8Array(await r.arrayBuffer());
}
/** A brain from a host that will not take it whole.
 *
 *  Cloudflare Pages refuses any file over 25 MiB and a brain is tens of megabytes, so a mirror there publishes
 *  parts and a manifest beside them. Nothing about that is trusted: the parts are concatenated and the worker
 *  recomputes model_id over the result, which the chain pins -- a missing part, a reordered part or a hostile part
 *  fails exactly as a wrong whole file does. The manifest only says where to look next.
 *  Tried only when the whole object is not there, so a mirror that can hold it just holds it. */
async function fetchParts(url, what) {
  const r = await fetch(url + ".parts.json"); if (!r.ok) throw new Error(`answered ${r.status}, and has no .parts.json either`);
  const m = await r.json();
  if (!Number.isInteger(m.parts) || m.parts < 1 || m.parts > 4096 || !Number.isInteger(m.size) || m.size < 1) throw new Error("its .parts.json makes no sense");
  log(`${what}: not there whole — taking it in ${m.parts} parts`);
  const chunks = []; let got = 0;
  for (let i = 0; i < m.parts; i++) {
    const p = await fetch(`${url}.part${i}`); if (!p.ok) throw new Error(`part ${i} of ${m.parts} answered ${p.status}`);
    const b = new Uint8Array(await p.arrayBuffer()); chunks.push(b); got += b.length;
  }
  if (got !== m.size) throw new Error(`the parts came to ${got} bytes and the manifest said ${m.size}`);
  const all = new Uint8Array(got); let at = 0; for (const c of chunks) { all.set(c, at); at += c.length; }
  return all;
}
/** Try each source in turn. Every refusal is reported in the words it came in -- a source that is out of quota and
 *  one that is unreachable are different problems and a host can act on the difference. */
async function fetchBrain(sources, what) {
  if (!sources.length) throw new Error(`${what}: nowhere to fetch it from`);
  const failed = [];
  for (const [i, s] of sources.entries()) {
    try {
      let bytes; try { bytes = await fetchOne(s.url); }
      catch (whole) { if (!/answered 404/.test(whole.message)) throw whole; bytes = await fetchParts(s.url, `${what}: ${s.where}`); }
      if (i > 0 || sources.length > 1) log(`${what}: served by ${s.where}`); return bytes;
    }
    catch (e) { failed.push(`${s.where}: ${e.message}`); if (i < sources.length - 1) log(`${what}: ${s.where} — ${e.message}; trying the next source`); }
  }
  throw new Error(`${what}: no source had it — ${failed.join(" | ")}`);
}
/** The URL a MEP's `weightsDA` points at, given a storage provider. */
const daUrl = (da, sp) => (da || "").startsWith("gnfd://") && sp ? sp.replace(/\/$/, "") + "/view/" + da.slice(7) : da;
/** Everywhere a brain's bytes might be, best first.
 *
 *  A brain is CONTENT ADDRESSED: the worker recomputes model_id over the bytes and the page refuses them unless it
 *  matches what the MEP pins on-chain. So a mirror cannot lie, only fail -- which is what makes an ordinary static
 *  host safe here, and worth having. Without one, every host of a collection pulls the same tens of megabytes from
 *  the one storage provider the MEP names: a single point of failure, and a read quota that empties as the mesh
 *  grows. The pointer on-chain stays what it was; these are only ways of carrying it.
 *
 *  Mirrors first, the storage provider last: the SP is the thing whose allowance runs out. */
const sourcesFor = (da, sp) => {
  const out = []; const object = (da || "").startsWith("gnfd://") ? da.slice(7) : null;
  if (object) for (const m of state.deployment?.brainMirrors || []) out.push({ url: `${m.replace(/\/$/, "")}/${object}`, where: new URL(m, location.href).host });
  const direct = daUrl(da, sp); if (direct) out.push({ url: direct, where: object ? `the storage provider${sp ? ` (${new URL(sp, location.href).host})` : ""}` : "the link given" });
  return out;
};
/** A base this deployment already serves, by model id: an individual is published as a delta over one of them, and
 *  the collection's bases are served for exactly this reason, so the page never has to be told where to find one. */
const servedBaseFor = (modelId) => state.meps.find((x) => x.modelId?.toLowerCase() === modelId.toLowerCase());

export async function loadModel() {
  const m = mepById(state.active); let bytes; const f = $("file").files[0];
  if (f) bytes = new Uint8Array(await f.arrayBuffer());
  else { const url = $("url").value; if (!url) throw new Error("choose a file or a URL"); bytes = await fetchBrain([{ url, where: "the link given" }], mepName(m)); }
  // An individual of a collection is published as a DELTA -- a few hundred bytes of edits over a base the network
  // already holds -- so what arrives may not be a brain at all. The bytes say which, and the delta says which base
  // it edits; the base is then whichever served MEP has that model id, fetched the same way as any other brain.
  let delta = null, baseModelId = null;
  const info = await ask("deltaInfo", { bytes: bytes.buffer });
  if (info.isDelta) {
    delta = bytes; baseModelId = info.baseModelId; bytes = null;
    const base = servedBaseFor(baseModelId);
    if (!base) throw new Error(`this is a delta over model ${baseModelId.slice(0, 12)}…, which this mesh does not serve: nothing to apply it to`);
    // The individuals of one collection all edit the SAME base, so the worker keeps the last one it applied: the
    // second fly costs a 228-byte download rather than another 77 MB of somebody's connection.
    const held = await ask("hasBase", { modelId: baseModelId });
    if (held.held) log(`${mepName(m)}: a ${delta.length}-byte delta over ${mepName(base)}, whose base is already here — nothing to download`);
    else {
      const sources = sourcesFor(base.weightsDA, $("sp")?.value);
      if (!sources.length) throw new Error(`this is a delta over ${mepName(base)}; give that brain's storage provider above, or name a mirror, so its base can be fetched`);
      log(`${mepName(m)}: a ${delta.length}-byte delta over ${mepName(base)} — fetching the base from ${sources.length === 1 ? sources[0].where : `${sources.length} possible sources`}…`);
      bytes = await fetchBrain(sources, `${mepName(m)}: its base (${mepName(base)})`);
    }
  }
  if (bytes) log(`${mepName(m)}: ${(bytes.length / 1e6).toFixed(1)} MB ${delta ? "base " : ""}downloaded, checking its model_id…`);
  const r = await ask("prepare", { mepId: m.mepId, ...(bytes ? { bytes: bytes.buffer } : {}), ...(delta ? { delta: delta.buffer, baseModelId } : {}) },
    [bytes?.buffer, delta?.buffer].filter(Boolean)); // transferred, not copied
  const ok = r.modelId.toLowerCase() === m.modelId.toLowerCase();
  state.prepared.add(m.mepId); state.loaded[m.mepId] = { name: r.name, neurons: r.neurons, synapses: r.synapses, bytes: r.bytes, modelId: r.modelId, ok };
  if (state.node) await hostOnNode(m); // hot-add to a running node
  onChange(); log(`${mepName(m)}: model_id ${r.modelId.slice(0, 14)}… ${ok ? "matches the MEP" : "DOES NOT MATCH the MEP (claims would be rejected)"}`);
  $("file").value = ""; $("url").value = "";
}
// Leave room for the kernel heap, alignment, and execution/dispute scratch.
const HOST_MEMORY_BUDGET = WASM32_MAX_BYTES - 64 * 1024 ** 2;
const reservedBytes = (bytes) => Math.ceil(bytes * 1.01);
function requireMemory(bytes) {
  if (bytes > HOST_MEMORY_BUDGET) throw new Error(`Hosting these brains needs about ${MB(bytes)} of memory; the shared wasm heap must stay below 4 GB with room for execution. Reduce Max task steps or host fewer brains.`);
}
export const MB = (b) => `${(b / 1024 / 1024).toFixed(0)} MB`;
/** the shape `mem.js` costs a brain by; needs the model to have been prepared (nTiles and the header counts) */
export const shapeOf = (m) => { const l = state.loaded[m.mepId]; return l && { nTiles: Math.floor(l.bytes / 4096), neurons: l.neurons, synapses: l.synapses, exec: m.exec === "int-lif" ? "lif" : "spmv" }; };
/** projected wasm memory for one hosted brain at the capacity the page is asking for */
export const brainBytes = (m, maxSteps) => { const sh = shapeOf(m); return sh ? modelMemoryBytes({ ...sh, maxSteps }) : 0; };
/** TaskMarket permits 512 SPMV roots, or 512 LIF segments of at most 512 steps each */
export const stepLimit = (m) => (m.exec === "int-lif" ? 512 * 512 : 512);
export function taskCapacity(m) {
  const maxSteps = Number($("steps").value);
  // That contract limit bounds the arrays a DISPUTE round must post, not this tab's memory, and memory binds
  // first by orders of magnitude: the real brain at 5000 int-lif steps is 408 MB resident, and at the contract's
  // own limit it is 17 GB.
  const limit = stepLimit(m);
  if (!Number.isInteger(maxSteps) || maxSteps < 1 || maxSteps > limit) throw new Error(`Max task steps must be a whole number from 1 to ${limit} for ${m.exec}`);
  const sh = shapeOf(m);
  if (sh) {
    const bytes = modelMemoryBytes({ ...sh, maxSteps });
    // a wasm32 memory cannot grow past 4 GB on any device, so this one is impossible rather than merely large
    if (reservedBytes(bytes) > HOST_MEMORY_BUDGET) throw new Error(`${maxSteps} steps would need ${MB(bytes)} of memory for this brain, above the hosting budget after reserving space in the 4 GB wasm heap. The most it can hold is ${maxStepsWithin(sh, Math.floor(HOST_MEMORY_BUDGET / 1.01))} steps; a laptop wants far less.`);
  }
  return maxSteps;
}
export async function hostOnNode(m) {
  if (!state.hosted.has(m.mepId) || !state.prepared.has(m.mepId) || state.node.models.has(m.mepId)) return;
  const maxSteps = taskCapacity(m), bytes = reservedBytes(brainBytes(m, maxSteps));
  requireMemory(state.node.memoryBytes + bytes);
  // Reserve before awaiting: concurrent hot-adds, mismatched MEPs and failed loads still consume heap.
  state.node.memoryBytes += bytes;
  // The TERMS, when the brain is an individual of a collection: its mep id is keccak(profile, beneficiary, bps) and
  // the terms are nowhere in the bytes, so a host that is not told them serves an id the chain never draws.
  const terms = m.royaltyBps > 0 && m.beneficiary ? { beneficiary: m.beneficiary, royaltyBps: m.royaltyBps } : null;
  const r = await ask("host", { mepId: m.mepId, name: state.loaded[m.mepId].name, maxSteps, exec: m.exec === "int-lif" ? "lif" : "spmv", wUnitQ16: m.wUnitQ16 || 0, terms }); // the brain's kind's weight unit, from the relayer's /meps (0: the default)
  if (!r.matches) { log(`WARNING ${mepName(m)}: local MEP id ${r.localMepId.slice(0, 12)}… ≠ registered ${m.mepId.slice(0, 12)}… (model bytes or exec kind mismatch)`); return; }
  state.node.models.set(m.mepId, { neurons: r.neurons, maxSteps, memoryBytes: bytes });
  log(`${mepName(m)}: resident on the node, serving audits and tasks`);
}
export async function startNode() {
  if (!state.delegation) throw new Error("delegate first");
  const ready = [...state.hosted].filter((id) => state.prepared.has(id));
  if (!ready.length) throw new Error("load a model for at least one hosted MEP");
  for (const id of ready) taskCapacity(mepById(id)); // validate before creating a worker or relay connection
  { const total = ready.reduce((s, id) => s + reservedBytes(brainBytes(mepById(id), taskCapacity(mepById(id)))), 0);
    requireMemory(total);
    if (total) log(`hosting ${ready.length} brain(s) will hold about ${MB(total)} of wasm memory resident${total > 1024 ** 3 ? " — over a gigabyte; a laptop tab may not survive it" : ""}`); }
  const k = sessionKey();
  await ask("init", { privHex: hex(k.priv), domains: state.deployment.domains, delegation: state.delegation });
  await ask("relay", { url: state.deployment.relay });
  state.node = { models: new Map(), memoryBytes: 0 }; // the page's view of what the worker holds resident
  for (const id of ready) await hostOnNode(mepById(id));
  // Nothing is prepared from here on, so the base kept for applying deltas is dead weight in the worker's heap.
  { const f = await ask("releaseBase"); if (f.freed) log(`released the ${MB(f.freed)} base the individuals were applied over`); }
  log(`node running for ${state.node.models.size} MEP(s)`);
  setInterval(() => loop().catch((e) => log("loop error: " + (e.message || e))), 3000); onChange();
}
export async function refreshEpoch() { try { state.epochInfo = await api("/epoch"); onChange(); return state.epochInfo; } catch (err) { return null; } }
/** every hosted + resident MEP: one claim per epoch, materialize the previous epoch once its root is posted */
// One pass at a time. The interval is 3 s and a pass can outlast it -- a residency claim on the real brain is ~5 s
// of wasm, a sponsored materialize waits for a receipt -- and `claims` / `materialized` are only written after
// those awaits. A second pass would announce the same claim again, and its materialize, which by then reverts in
// the relayer's simulation, would overwrite the first one's success and retry every tick until the epoch ends.
// A tick that lands mid-pass gets the pass already running, so a caller awaiting `loop()` still waits for the work.
let pass = null;
export function loop() { return pass ||= runPass().finally(() => { pass = null; }); }
async function runPass() {
  const e = await refreshEpoch(); if (!e || !state.node) return;
  // tell the relayer we are here, once per epoch: where the beacon is lazy, a mesh nobody is using stops
  // producing one, and this is what wakes it and keeps it awake while this tab hosts a brain.
  const me = state.resolved || state.wallet;
  if (me && state.wokeEpoch !== e.epoch) { state.wokeEpoch = e.epoch; api("/wake", { instance: me }).catch(() => {}); }
  if (!e.rolled) return;
  for (const id of state.hosted) {
    const m = mepById(id); if (!state.node || !state.node.models.has(id)) continue;
    state.claims[id] ||= {}; state.materialized[id] ||= {};
    if (!state.claims[id][e.epoch]) { const info = await api("/epoch?mep=" + id); const r = await ask("announce", { mepId: id, challenge: info.challenge }); state.claims[id][e.epoch] = r.claimHash; log(`${mepName(m)} epoch ${e.epoch}: claim announced (slot ${r.slotMs} ms)`); }
    const prev = e.epoch - 1;
    // A valid claim keeps this instance eligible for `claimValidityEpochs` epochs, so materialize only when the standing
    // would otherwise lapse NEXT epoch: eligible in x iff lastMaterialized >= x - k. One transaction every k epochs.
    const k = state.deployment?.claimValidityEpochs || 1; const lastM = Math.max(-Infinity, ...Object.entries(state.materialized[id]).filter(([, ok]) => ok).map(([ep]) => Number(ep)));
    const lapsing = !(lastM >= e.epoch + 1 - k);
    if ($("auto").checked && lapsing && state.claims[id][prev] && !state.materialized[id][prev]) { const p = await api(`/proof?mep=${id}&epoch=${prev}&instance=${state.resolved}`); if (p.posted) { const r = await api("/tx/materialize", { mep: id, epoch: prev, instance: state.resolved }); state.materialized[id][prev] = r.ok; log(`${mepName(m)} epoch ${prev}: materialized via relayer ${r.ok ? "ok (gas " + r.gasUsed + ")" : "FAILED " + r.error}`); } }
  }
  onChange();
}
export function setActive(id) { state.active = id; onChange(); }
export function host(id, on) { on ? state.hosted.add(id) : state.hosted.delete(id); onChange(); }
/** the MEP's gnfd:// pointer plus an SP endpoint is a fetchable URL; filling the box beats making anyone paste it */
export function autofillUrl() {
  const m = mepById(state.active); const url = $("url"), sp = $("sp"); if (!m || !url || !sp) return;
  if (!url.value) { const u = daUrl(m.weightsDA, sp.value); if (u && u !== m.weightsDA) url.value = u; }
}
/** every action the UI can fire, wrapped so a rejection lands in the log instead of an unhandled rejection */
export const wrap = (fn) => async (...args) => { try { return await fn(...args); } catch (e) { state.errors.push(String(e.message || e)); log("ERROR " + (e.message || e)); onChange(); } };

// ---- posting a task: the scene is chosen here, at post time ----
//
// A task IS its scene. `stimulusSeed` is a uint32 the task pins on-chain, and every party -- the executor, an
// auditor re-executing, a dispute round on-chain -- derives the same stimulus from it. That is what makes a
// result checkable at all, and it is why the scene cannot be something the executor picks afterwards: it is
// settled in the same transaction as the fee and the deadline.
//
// The names below are this page's labels for a few fixed seeds. Nothing on-chain knows them; the number is the
// scene. `initStateRoot` stays zero, which is "start from the model's own initial state" -- a scene chosen by seed
// alone, with no client-supplied input to commit to.
export const SCENES = [
  { id: 7, name: "Looming disc", about: "the classic escape stimulus: something large arriving fast" },
  { id: 11, name: "Open field", about: "wide unstructured drive; no single feature dominates" },
  { id: 23, name: "Bar sweep", about: "a moving edge across the eye, left to right" },
  { id: 42, name: "Giant fiber", about: "the seed the demo meshes use for the escape pathway" },
];
const randomNonce = () => hex(crypto.getRandomValues(new Uint8Array(32)));

/** what this page will let you post for the active brain, mirroring TaskMarket's own dispute-round bounds */
export function checkTask(m, { steps, commitStride, redundancy }) {
  if (!m) return "choose a brain first";
  if (!Number.isInteger(steps) || steps < 1) return "steps must be a whole number of at least 1";
  if (!Number.isInteger(commitStride) || commitStride < 1 || commitStride > steps) return "commit stride must be between 1 and steps";
  if (!Number.isInteger(redundancy) || redundancy < 1) return "redundancy must be at least 1";
  if (m.exec === "int-lif") {
    if (Math.ceil(steps / commitStride) > 512 || commitStride > 512) return "a dispute round posts at most 512 segment roots: raise the stride or shorten the task";
  } else if (steps > 512 || commitStride !== 1) return "int-spmv-q16 commits every step: at most 512 steps, stride 1";
  return null;
}

/** post a task for the ACTIVE brain against the scene chosen here. The fee is the value sent with it. */
export async function postTask({ seed, steps, commitStride, redundancy, feeBnb, deadlineIn }) {
  const m = mepById(state.active); const problem = checkTask(m, { steps, commitStride, redundancy });
  if (problem) throw new Error(problem);
  if (!state.wallet) throw new Error("connect a wallet first: the fee is paid from it");
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) throw new Error("the scene seed is a uint32");
  const fee = BigInt(Math.round(parseFloat(feeBnb || "0") * 1e6)) * 10n ** 12n;
  if (fee < 0n) throw new Error("the fee cannot be negative");
  const block = Number(await read("eth_blockNumber"));
  const deadline = BigInt(block + Math.max(1, Number(deadlineIn) || 0));
  const nonce = randomNonce();
  const task = [m.mepId, seed, steps, commitStride, "0x" + "0".repeat(64), fee, deadline, redundancy];
  const taskId = keccakWords([...task, nonce]);
  if (state.epochInfo && !state.epochInfo.rolled) log("note: this epoch has no beacon yet — TaskMarket will reject the post until it rolls");
  log(`${mepName(m)}: posting task ${taskId.slice(0, 12)}… · scene seed ${seed} · ${steps} steps (stride ${commitStride}) · ${feeBnb} BNB · deadline block ${deadline}`);
  await send(state.deployment.addresses.market, "postTask((bytes32,uint32,uint32,uint32,bytes32,uint256,uint64,uint8),bytes32)", [task, nonce], fee);
  state.tasks.unshift({ taskId, mepId: m.mepId, seed, steps, commitStride, redundancy, fee, deadline: Number(deadline), at: Date.now() });
  onChange(); log(`task ${taskId.slice(0, 12)}… posted; sortition picks its executors from this epoch's eligible votes`);
  return taskId;
}
