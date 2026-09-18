// The BNB fly-brain node page: wallet -> bond BNB for the MEPs you host -> delegate a session key (one signature)
// -> load a brain per MEP -> run the node against the relayer (a claim per MEP per epoch, materialize when wanted,
// audits and tasks for every hosted MEP over the relay). Chain state is read through the wallet's provider.
// Several MEPs (e.g. the female and the male brain) can be hosted at once; the selector switches which one the
// model panel and the details refer to.
//
// This file is the page: UI, wallet, chain calls, the relayer's HTTP API. The node -- the kernel, the resident
// brains, the relay connection, the claims -- runs in node_worker.js, because proving residency is seconds of
// single-threaded wasm per brain per epoch and on this thread that is seconds of frozen page. The page never
// holds a payload: the bytes are transferred to the worker and the model_id is recomputed there.
import { encode, decodeUint, decodeAddress, hex, unhex } from "./abi.js";
import { keypair } from "/porw/claim.js";
import * as E from "/porw/eip712.js";
import { modelMemoryBytes, maxStepsWithin, WASM32_MAX_BYTES } from "/porw/mem.js";

const $ = (id) => document.getElementById(id); const log = (m) => { const el = $("log"); el.textContent += `[${new Date().toISOString().slice(11, 19)}] ${m}\n`; el.scrollTop = el.scrollHeight; };
const state = { deployment: null, meps: [], hosted: new Set(), active: null, wallet: null, chainOk: false, bonded: 0n, weight: 0n, exitAt: 0n, session: null, delegation: null, resolved: null,
  prepared: new Set(), loaded: {}, node: null, claims: {}, materialized: {}, results: [], errors: [] }; // loaded/claims/materialized keyed by mepId
window.app = { state, log };

// ---- the worker that actually runs the node ----
let worker = null, nextReq = 1; const waiting = new Map();
function ensureWorker() {
  if (worker) return worker;
  worker = new Worker("./node_worker.js", { type: "module" });
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
const eth = () => window.ethereum;
const call = async (to, sig, args = []) => eth().request({ method: "eth_call", params: [{ to, data: encode(sig, args) }, "latest"] });
const send = async (to, sig, args = [], value = 0n) => { const hash = await eth().request({ method: "eth_sendTransaction", params: [{ from: state.wallet, to, data: encode(sig, args), value: "0x" + value.toString(16) }] }); log(`tx ${hash.slice(0, 12)}… sent`); for (let i = 0; i < 120; i++) { const r = await eth().request({ method: "eth_getTransactionReceipt", params: [hash] }); if (r) { log(`tx ${hash.slice(0, 12)}… ${r.status === "0x1" ? "confirmed" : "REVERTED"}`); return r; } await new Promise((x) => setTimeout(x, 500)); } throw new Error("receipt timeout"); };
const relayer = () => $("relayer").value.replace(/\/$/, ""); const api = async (p, body) => (await fetch(relayer() + p, body ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {})).json();
const mepById = (id) => state.meps.find((m) => m.mepId === id);
const label = (m) => `${m.name || m.mepId.slice(0, 12) + "…"} · ${m.exec} · ${m.neurons.toLocaleString()} neurons`;

function renderMeps() {
  const sel = $("mep"); sel.innerHTML = ""; const host = $("hosted"); host.innerHTML = "";
  for (const m of state.meps) {
    const o = document.createElement("option"); o.value = m.mepId; o.textContent = label(m); if (m.mepId === state.active) o.selected = true; sel.appendChild(o);
    const l = document.createElement("label"); l.style.display = "block"; const c = document.createElement("input"); c.type = "checkbox"; c.checked = state.hosted.has(m.mepId); c.dataset.mep = m.mepId;
    c.onchange = () => { c.checked ? state.hosted.add(m.mepId) : state.hosted.delete(m.mepId); renderActive(); }; l.appendChild(c); l.appendChild(document.createTextNode(" host " + label(m))); host.appendChild(l);
  }
  renderActive();
}
function renderActive() {
  const m = mepById(state.active); if (!m) return;
  $("mepInfo").textContent = `${m.mepId} · model_id ${m.modelId.slice(0, 14)}… · ${m.neurons.toLocaleString()} neurons · ${m.synapses.toLocaleString()} synapses · ${m.weightsDA}`;
  if (!$("url").value && m.weightsDA.startsWith("gnfd://") && $("sp").value) $("url").value = $("sp").value.replace(/\/$/, "") + "/view/" + m.weightsDA.slice(7);
  const l = state.loaded[m.mepId]; const steps = Number($("steps").value);
  const cost = l && Number.isInteger(steps) && steps >= 1 ? ` · ~${MB(brainBytes(m, steps))} resident at ${steps} steps` : "";
  $("model").textContent = l ? `${l.name}: ${l.neurons} neurons, ${l.synapses} synapses, model_id ${l.modelId.slice(0, 14)}… (${l.ok ? "matches the MEP" : "DOES NOT MATCH the MEP's model_id"})${cost}` : "not loaded";
  const claimed = Object.entries(state.claims[m.mepId] || {}).map(([e]) => e).join(","); $("mepStatus").textContent = `hosted: ${state.hosted.has(m.mepId) ? "yes" : "no"} · claims: epochs ${claimed || "—"} · materialized: ${Object.entries(state.materialized[m.mepId] || {}).filter(([, v]) => v).map(([e]) => e).join(",") || "—"}`;
}
async function loadDeployment() {
  state.deployment = await api("/deployment"); state.meps = await api("/meps"); if (!state.active) state.active = state.meps[0]?.mepId || null; if (!state.hosted.size && state.active) state.hosted.add(state.active);
  $("dep").textContent = `chain ${state.deployment.chainId} · claims ${state.deployment.addresses.claims.slice(0, 10)}… · relay ${state.deployment.relay} · ${state.meps.length} MEP(s)`; renderMeps(); log(`deployment loaded: ${state.meps.length} MEP(s)`); refreshEpoch();
}
async function connect() {
  if (!eth()) throw new Error("no wallet (window.ethereum)");
  const accts = await eth().request({ method: "eth_requestAccounts" }); state.wallet = accts[0].toLowerCase();
  const cid = Number(await eth().request({ method: "eth_chainId" })); state.chainOk = cid === state.deployment.chainId;
  if (!state.chainOk) { try { await eth().request({ method: "wallet_switchEthereumChain", params: [{ chainId: "0x" + state.deployment.chainId.toString(16) }] }); state.chainOk = Number(await eth().request({ method: "eth_chainId" })) === state.deployment.chainId; } catch (e) { log("chain switch refused: " + (e.message || e)); } }
  $("wallet").textContent = `${state.wallet} (chain ${cid}${state.chainOk ? "" : " ≠ " + state.deployment.chainId})`; log("wallet connected"); await refreshBond();
}
async function refreshBond() {
  const a = state.deployment.addresses.instances; state.bonded = decodeUint(await call(a, "bonded(address)", [state.wallet])); state.weight = decodeUint(await call(a, "weightOf(address)", [state.wallet])); state.exitAt = decodeUint(await call(a, "exitAt(address)", [state.wallet]));
  const bal = BigInt(await eth().request({ method: "eth_getBalance", params: [state.wallet, "latest"] }));
  const inMep = []; for (const m of state.meps) if (decodeUint(await call(a, "inMep(bytes32,address)", [m.mepId, state.wallet])) !== 0n) inMep.push(m.name || m.mepId.slice(0, 10));
  $("bond").textContent = `balance ${(Number(bal) / 1e18).toFixed(4)} BNB · bonded ${(Number(state.bonded) / 1e18).toFixed(4)} BNB · ${state.weight} votes${state.exitAt ? ` · exiting at block ${state.exitAt}` : ""} · MEPs: ${inMep.join(", ") || "none"}`;
}
/** bond for every hosted MEP (a top-up adds MEPs to an existing bond) */
async function bond() { const ids = [...state.hosted]; if (!ids.length) throw new Error("choose at least one MEP to host"); const v = BigInt(Math.round(parseFloat($("amount").value) * 1e6)) * 10n ** 12n; if (v <= 0n) throw new Error("the registry needs a positive amount (a small top-up adds MEPs to an existing bond)"); await send(state.deployment.addresses.instances, "bond(bytes32[])", [ids], v); await refreshBond(); }
async function requestExit() { await send(state.deployment.addresses.instances, "requestExit()"); await refreshBond(); }
async function finalizeExit() { await send(state.deployment.addresses.instances, "finalizeExit()"); await refreshBond(); }
function sessionKey() { if (state.session) return state.session; let priv = null; try { priv = localStorage.getItem("porw-session-priv"); } catch {} const k = keypair(priv); try { localStorage.setItem("porw-session-priv", hex(k.priv)); } catch {} state.session = k; $("session").textContent = `session key ${hex(k.address)}`; return k; }
async function delegate() {
  const k = sessionKey(); const w = E.injectedWallet(eth()); await w.connect(); const expiry = Number(await eth().request({ method: "eth_blockNumber" })) + Number($("expiry").value || 100000);
  state.delegation = await E.makeDelegation(w, state.deployment.domains.registry, hex(k.address), expiry); log("delegation signed by the wallet (the only wallet signature the node needs)");
  const r = await api("/tx/delegate", { instance: state.delegation.instance, session: state.delegation.session, expiry: state.delegation.expiry, sig: state.delegation.sig }); log(`relayer submitted delegateBySig: ${r.ok ? "ok" : "FAILED " + r.error}`);
  state.resolved = decodeAddress(await call(state.deployment.addresses.instances, "resolve(address)", [hex(k.address)])); $("session").textContent = `session key ${hex(k.address)} → instance ${state.resolved}`;
}
/** load the ACTIVE MEP's brain (file or URL). The bytes go straight to the worker, which recomputes the keccak
 *  weights root over every 4 KiB tile and reports it back: a brain is accepted only if that reproduces the
 *  model_id the MEP pins on-chain, so a wrong or hostile source can only waste the download. */
async function loadModel() {
  const m = mepById(state.active); let bytes; const f = $("file").files[0];
  if (f) bytes = new Uint8Array(await f.arrayBuffer()); else { const url = $("url").value; if (!url) throw new Error("choose a file or a URL"); bytes = new Uint8Array(await (await fetch(url)).arrayBuffer()); }
  log(`${m.name || m.mepId.slice(0, 10)}: ${(bytes.length / 1e6).toFixed(1)} MB downloaded, checking its model_id…`);
  const r = await ask("prepare", { mepId: m.mepId, bytes: bytes.buffer }, [bytes.buffer]); // transferred, not copied
  const ok = r.modelId.toLowerCase() === m.modelId.toLowerCase();
  state.prepared.add(m.mepId); state.loaded[m.mepId] = { name: r.name, neurons: r.neurons, synapses: r.synapses, bytes: r.bytes, modelId: r.modelId, ok };
  if (state.node) await hostOnNode(m); // hot-add to a running node
  renderActive(); log(`${m.name || m.mepId.slice(0, 10)}: model_id ${r.modelId.slice(0, 14)}… ${ok ? "matches the MEP" : "DOES NOT MATCH the MEP (claims would be rejected)"}`);
  $("file").value = ""; $("url").value = "";
}
const MB = (b) => `${(b / 1024 / 1024).toFixed(0)} MB`;
/** the shape `mem.js` costs a brain by; needs the model to have been prepared (nTiles and the header counts) */
const shapeOf = (m) => { const l = state.loaded[m.mepId]; return l && { nTiles: Math.floor(l.bytes / 4096), neurons: l.neurons, synapses: l.synapses, exec: m.exec === "int-lif" ? "lif" : "spmv" }; };
/** projected wasm memory for one hosted brain at the capacity the page is asking for */
const brainBytes = (m, maxSteps) => { const sh = shapeOf(m); return sh ? modelMemoryBytes({ ...sh, maxSteps }) : 0; };
function taskCapacity(m) {
  const maxSteps = Number($("steps").value);
  // TaskMarket permits 512 SPMV roots, or 512 LIF segments of at most 512 steps each — but that bounds the
  // arrays a DISPUTE round must post, not this tab's memory, and memory binds first by orders of magnitude:
  // the real brain at 5000 int-lif steps is 408 MB resident, and at the contract's own limit it is 17 GB.
  const limit = m.exec === "int-lif" ? 512 * 512 : 512;
  if (!Number.isInteger(maxSteps) || maxSteps < 1 || maxSteps > limit) throw new Error(`Max task steps must be a whole number from 1 to ${limit} for ${m.exec}`);
  const sh = shapeOf(m);
  if (sh) {
    const bytes = modelMemoryBytes({ ...sh, maxSteps });
    // a wasm32 memory cannot grow past 4 GB on any device, so this one is impossible rather than merely large
    if (bytes >= WASM32_MAX_BYTES) throw new Error(`${maxSteps} steps would need ${MB(bytes)} of memory for this brain, past the 4 GB a page can address. The most it can hold is ${maxStepsWithin(sh, WASM32_MAX_BYTES)} steps; a laptop wants far less.`);
  }
  return maxSteps;
}
async function hostOnNode(m) {
  if (!state.hosted.has(m.mepId) || !state.prepared.has(m.mepId) || state.node.models.has(m.mepId)) return;
  const r = await ask("host", { mepId: m.mepId, name: state.loaded[m.mepId].name, maxSteps: taskCapacity(m), exec: m.exec === "int-lif" ? "lif" : "spmv" });
  if (!r.matches) { log(`WARNING ${m.name || m.mepId.slice(0, 10)}: local MEP id ${r.localMepId.slice(0, 12)}… ≠ registered ${m.mepId.slice(0, 12)}… (model bytes or exec kind mismatch)`); return; }
  state.node.models.set(m.mepId, { neurons: r.neurons });
  log(`${m.name || m.mepId.slice(0, 10)}: resident on the node, serving audits and tasks`);
}
async function startNode() {
  if (!state.delegation) throw new Error("delegate first"); const ready = [...state.hosted].filter((id) => state.prepared.has(id)); if (!ready.length) throw new Error("load a model for at least one hosted MEP");
  for (const id of ready) taskCapacity(mepById(id)); // validate before creating a worker or relay connection
  { const total = ready.reduce((s, id) => s + brainBytes(mepById(id), taskCapacity(mepById(id))), 0);
    if (total) log(`hosting ${ready.length} brain(s) will hold about ${MB(total)} of wasm memory resident${total > 1024 ** 3 ? " — over a gigabyte; a laptop tab may not survive it" : ""}`); }
  const k = sessionKey();
  await ask("init", { privHex: hex(k.priv), domains: state.deployment.domains, delegation: state.delegation });
  await ask("relay", { url: state.deployment.relay });
  state.node = { models: new Map() }; // the page's view of what the worker holds resident
  for (const id of ready) await hostOnNode(mepById(id));
  log(`node running for ${state.node.models.size} MEP(s)`); setInterval(() => loop().catch((e) => log("loop error: " + (e.message || e))), 3000); renderActive();
}
async function refreshEpoch() { try { const e = await api("/epoch"); state.epochInfo = e; $("epoch").textContent = `epoch ${e.epoch} · block ${e.block} · beacon ${e.rolled ? "rolled" : e.lazy && !e.warm ? "cold (waking up)" : "pending"}`; return e; } catch (err) { return null; } }
/** every hosted + resident MEP: one claim per epoch, materialize the previous epoch once its root is posted */
async function loop() {
  const e = await refreshEpoch(); if (!e || !state.node) return;
  // tell the relayer we are here, once per epoch: where the beacon is lazy, a mesh nobody is using stops
  // producing one, and this is what wakes it and keeps it awake while this tab hosts a brain.
  const me = state.resolved || state.wallet;
  if (me && state.wokeEpoch !== e.epoch) { state.wokeEpoch = e.epoch; api("/wake", { instance: me }).catch(() => {}); }
  if (!e.rolled) return;
  for (const id of state.hosted) {
    const m = mepById(id); if (!state.node || !state.node.models.has(id)) continue; state.claims[id] ||= {}; state.materialized[id] ||= {};
    if (!state.claims[id][e.epoch]) { const info = await api("/epoch?mep=" + id); const r = await ask("announce", { mepId: id, challenge: info.challenge }); state.claims[id][e.epoch] = r.claimHash; log(`${m.name || id.slice(0, 10)} epoch ${e.epoch}: claim announced (slot ${r.slotMs} ms)`); }
    const prev = e.epoch - 1;
    if ($("auto").checked && state.claims[id][prev] && !state.materialized[id][prev]) { const p = await api(`/proof?mep=${id}&epoch=${prev}&instance=${state.resolved}`); if (p.posted) { const r = await api("/tx/materialize", { mep: id, epoch: prev, instance: state.resolved }); state.materialized[id][prev] = r.ok; log(`${m.name || id.slice(0, 10)} epoch ${prev}: materialized via relayer ${r.ok ? "ok (gas " + r.gasUsed + ")" : "FAILED " + r.error}`); } }
  }
  renderActive();
}
const wrap = (fn) => async () => { try { await fn(); } catch (e) { state.errors.push(String(e.message || e)); log("ERROR " + (e.message || e)); } };
$("btnDep").onclick = wrap(loadDeployment); $("btnConnect").onclick = wrap(connect); $("btnBond").onclick = wrap(bond); $("btnExit").onclick = wrap(requestExit); $("btnFinalize").onclick = wrap(finalizeExit);
$("btnDelegate").onclick = wrap(delegate); $("btnModel").onclick = wrap(loadModel); $("btnStart").onclick = wrap(startNode); $("btnRefresh").onclick = wrap(refreshBond);
$("mep").onchange = () => { state.active = $("mep").value; $("url").value = ""; renderActive(); };
$("steps").oninput = () => renderActive(); // the memory a capacity buys, as it is typed
window.appActions = { loadDeployment, connect, bond, delegate, loadModel, startNode, refreshBond, loop, setActive: (id) => { state.active = id; renderMeps(); }, host: (id, on) => { on ? state.hosted.add(id) : state.hosted.delete(id); renderMeps(); } };
window.__ready = true;
