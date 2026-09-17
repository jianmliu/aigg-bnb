// The BNB fly-brain node page: wallet -> bond BNB for the MEPs you host -> delegate a session key (one signature)
// -> load a brain per MEP -> run the node against the relayer (a claim per MEP per epoch, materialize when wanted,
// audits and tasks for every hosted MEP over the relay). Neutral modules come from aigg-porw (served under /porw/);
// chain state is read through the wallet's provider. Several MEPs (e.g. the female and the male brain) can be hosted
// at once; the selector switches which one the model panel and the details refer to.
import { encode, decodeUint, decodeAddress, hex, unhex } from "./abi.js";
import { loadKernel } from "/porw/porw.js";
import { PorwNode } from "/porw/node.js";
import { RelayClient } from "/porw/relay_client.js";
import { NodeService } from "/porw/node_service.js";
import { keypair } from "/porw/claim.js";
import * as E from "/porw/eip712.js";
import { decodeHeader } from "/porw/model.js";
import * as V from "/porw/verify.js";
import { makeMep } from "/porw/mep.js";
import { lifExecKind } from "/porw/lif.js";

const $ = (id) => document.getElementById(id); const log = (m) => { const el = $("log"); el.textContent += `[${new Date().toISOString().slice(11, 19)}] ${m}\n`; el.scrollTop = el.scrollHeight; };
const state = { deployment: null, meps: [], hosted: new Set(), active: null, wallet: null, chainOk: false, bonded: 0n, weight: 0n, exitAt: 0n, session: null, delegation: null, resolved: null,
  models: {}, loaded: {}, node: null, svc: null, relay: null, claims: {}, materialized: {}, results: [], errors: [] }; // models/loaded/claims/materialized keyed by mepId
window.app = { state, log };
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
  $("mepInfo").textContent = `${m.mepId} · model_id ${m.modelId.slice(0, 14)}… · steps ${m.steps}${m.exec === "int-lif" ? " · stride " + m.commitStride : ""} · ${m.synapses.toLocaleString()} synapses · ${m.weightsDA}`;
  $("steps").value = m.steps; if (!$("url").value && m.weightsDA.startsWith("gnfd://") && $("sp").value) $("url").value = $("sp").value.replace(/\/$/, "") + "/view/" + m.weightsDA.slice(7);
  const l = state.loaded[m.mepId]; $("model").textContent = l ? `${l.name}: ${l.neurons} neurons, ${l.synapses} synapses, model_id ${l.modelId.slice(0, 14)}… (${l.ok ? "matches the MEP" : "DOES NOT MATCH the MEP's model_id"})` : "not loaded";
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
/** load the ACTIVE MEP's model (file or URL); verified locally: the bytes must reproduce the MEP's model_id */
async function loadModel() {
  const m = mepById(state.active); let bytes; const f = $("file").files[0];
  if (f) bytes = new Uint8Array(await f.arrayBuffer()); else { const url = $("url").value; if (!url) throw new Error("choose a file or a URL"); bytes = new Uint8Array(await (await fetch(url)).arrayBuffer()); }
  const nT = Math.floor(bytes.length / 4096); const lv = []; for (let t = 0; t < nT; t++) lv.push(V.weightsLeaf(t, bytes.subarray(t * 4096, (t + 1) * 4096)));
  const modelId = hex(V.merkleRoot(lv)); const ok = modelId.toLowerCase() === m.modelId.toLowerCase(); const hdr = decodeHeader(bytes);
  state.models[m.mepId] = bytes; state.loaded[m.mepId] = { name: hdr.name, neurons: hdr.neurons, synapses: hdr.synapses, modelId, ok };
  if (state.node) await hostOnNode(m); // hot-add to a running node
  renderActive(); log(`${m.name || m.mepId.slice(0, 10)}: model loaded, model_id ${modelId.slice(0, 14)}… ${ok ? "matches the MEP" : "DOES NOT MATCH the MEP (claims would be rejected)"}`);
  $("file").value = ""; $("url").value = "";
}
async function hostOnNode(m) {
  if (!state.hosted.has(m.mepId) || !state.models[m.mepId] || state.node.models.has(m.mepId)) return;
  const st = await state.node.loadModel(state.loaded[m.mepId].name, state.models[m.mepId], { steps: m.steps, exec: m.exec === "int-lif" ? "lif" : "spmv", commitStride: m.commitStride });
  if (hex(st.mep.mepId).toLowerCase() !== m.mepId) { log(`WARNING ${m.name || m.mepId.slice(0, 10)}: local MEP id ${hex(st.mep.mepId).slice(0, 12)}… ≠ registered ${m.mepId.slice(0, 12)}… (model/steps/exec kind mismatch)`); return; }
  state.svc.serve(st.mep.mepId); log(`${m.name || m.mepId.slice(0, 10)}: resident on the node, serving audits and tasks`);
}
async function startNode() {
  if (!state.delegation) throw new Error("delegate first"); const ready = [...state.hosted].filter((id) => state.models[id]); if (!ready.length) throw new Error("load a model for at least one hosted MEP");
  const kernel = await loadKernel("/porw/sketch.wasm"); const k = sessionKey();
  state.node = new PorwNode(kernel, { privHex: hex(k.priv), domains: state.deployment.domains, delegation: state.delegation });
  const rc = new RelayClient([state.deployment.relay], k); await rc.connect(); state.relay = rc;
  state.svc = new NodeService(state.node, rc, { onResult: async (res) => { const r = await api("/tx/result", res); res.submitted = r.ok; state.results.push(res); log(`task ${res.taskId.slice(0, 12)}… executed; relayer submitResult ${r.ok ? "ok" : "FAILED " + r.error}`); } });
  for (const id of ready) await hostOnNode(mepById(id));
  log(`node running for ${state.node.models.size} MEP(s)`); setInterval(loop, 3000); renderActive();
}
async function refreshEpoch() { try { const e = await api("/epoch"); state.epochInfo = e; $("epoch").textContent = `epoch ${e.epoch} · block ${e.block} · beacon ${e.rolled ? "rolled" : "pending"}`; return e; } catch (err) { return null; } }
/** every hosted + resident MEP: one claim per epoch, materialize the previous epoch once its root is posted */
async function loop() {
  const e = await refreshEpoch(); if (!e || !e.rolled || !state.svc) return;
  for (const id of state.hosted) {
    const m = mepById(id); if (!state.node.models.has(id)) continue; state.claims[id] ||= {}; state.materialized[id] ||= {};
    if (!state.claims[id][e.epoch]) { const info = await api("/epoch?mep=" + id); const { r } = await state.svc.announce(unhex(id), unhex(info.challenge), { stimulusSeed: 1 }); state.claims[id][e.epoch] = hex(r.claimHash); log(`${m.name || id.slice(0, 10)} epoch ${e.epoch}: claim announced (slot ${(r.timings.sketchMs + r.timings.commitMs + r.timings.inferMs + (r.timings.disputeCommitMs || 0)).toFixed(0)} ms)`); }
    const prev = e.epoch - 1;
    if ($("auto").checked && state.claims[id][prev] && !state.materialized[id][prev]) { const p = await api(`/proof?mep=${id}&epoch=${prev}&instance=${state.resolved}`); if (p.posted) { const r = await api("/tx/materialize", { mep: id, epoch: prev, instance: state.resolved }); state.materialized[id][prev] = r.ok; log(`${m.name || id.slice(0, 10)} epoch ${prev}: materialized via relayer ${r.ok ? "ok (gas " + r.gasUsed + ")" : "FAILED " + r.error}`); } }
  }
  renderActive();
}
const wrap = (fn) => async () => { try { await fn(); } catch (e) { state.errors.push(String(e.message || e)); log("ERROR " + (e.message || e)); } };
$("btnDep").onclick = wrap(loadDeployment); $("btnConnect").onclick = wrap(connect); $("btnBond").onclick = wrap(bond); $("btnExit").onclick = wrap(requestExit); $("btnFinalize").onclick = wrap(finalizeExit);
$("btnDelegate").onclick = wrap(delegate); $("btnModel").onclick = wrap(loadModel); $("btnStart").onclick = wrap(startNode); $("btnRefresh").onclick = wrap(refreshBond);
$("mep").onchange = () => { state.active = $("mep").value; $("url").value = ""; renderActive(); };
window.appActions = { loadDeployment, connect, bond, delegate, loadModel, startNode, refreshBond, loop, setActive: (id) => { state.active = id; renderMeps(); }, host: (id, on) => { on ? state.hosted.add(id) : state.hosted.delete(id); renderMeps(); } };
window.__ready = true;
