// The BNB fly-brain node page: wallet -> bond BNB -> delegate a session key (one signature) -> load the brain
// -> run the node against the relayer (claims every epoch, materialize when needed, serve audits and tasks).
// Neutral modules come from aigg-porw (served under /porw/); chain state is read through the wallet's provider.
import { encode, decodeUint, decodeBool, decodeAddress, hex, unhex } from "./abi.js";
import { loadKernel } from "/porw/porw.js";
import { PorwNode } from "/porw/node.js";
import { RelayClient } from "/porw/relay_client.js";
import { NodeService } from "/porw/node_service.js";
import { keypair } from "/porw/claim.js";
import * as E from "/porw/eip712.js";
import { decodeHeader } from "/porw/model.js";
import * as V from "/porw/verify.js";

const $ = (id) => document.getElementById(id); const log = (m) => { const el = $("log"); el.textContent += `[${new Date().toISOString().slice(11, 19)}] ${m}\n`; el.scrollTop = el.scrollHeight; };
const state = { deployment: null, wallet: null, chainOk: false, bonded: 0n, weight: 0n, exitAt: 0n, session: null, delegation: null, resolved: null, model: null, node: null, svc: null, relay: null, epoch: -1, claims: {}, materialized: {}, results: [], errors: [] };
window.app = { state, log };
const eth = () => window.ethereum;
const call = async (to, sig, args = []) => eth().request({ method: "eth_call", params: [{ to, data: encode(sig, args) }, "latest"] });
const send = async (to, sig, args = [], value = 0n) => { const hash = await eth().request({ method: "eth_sendTransaction", params: [{ from: state.wallet, to, data: encode(sig, args), value: "0x" + value.toString(16) }] }); log(`tx ${hash.slice(0, 12)}… sent`); for (let i = 0; i < 120; i++) { const r = await eth().request({ method: "eth_getTransactionReceipt", params: [hash] }); if (r) { log(`tx ${hash.slice(0, 12)}… ${r.status === "0x1" ? "confirmed" : "REVERTED"}`); return r; } await new Promise((x) => setTimeout(x, 500)); } throw new Error("receipt timeout"); };
const relayer = () => $("relayer").value.replace(/\/$/, ""); const api = async (p, body) => (await fetch(relayer() + p, body ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {})).json();
const mepId = () => state.deployment.meps[0];

async function loadDeployment() { state.deployment = await api("/deployment"); $("dep").textContent = `chain ${state.deployment.chainId} · claims ${state.deployment.addresses.claims.slice(0, 10)}… · relay ${state.deployment.relay} · MEP ${mepId().slice(0, 12)}…`; log("deployment loaded"); refreshEpoch(); }
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
  $("bond").textContent = `balance ${(Number(bal) / 1e18).toFixed(4)} BNB · bonded ${(Number(state.bonded) / 1e18).toFixed(4)} BNB · ${state.weight} votes${state.exitAt ? ` · exiting at block ${state.exitAt}` : ""}`;
}
async function bond() { const v = BigInt(Math.round(parseFloat($("amount").value) * 1e6)) * 10n ** 12n; await send(state.deployment.addresses.instances, "bond(bytes32[])", [[mepId()]], v); await refreshBond(); }
async function requestExit() { await send(state.deployment.addresses.instances, "requestExit()"); await refreshBond(); }
async function finalizeExit() { await send(state.deployment.addresses.instances, "finalizeExit()"); await refreshBond(); }
function sessionKey() { if (state.session) return state.session; let priv = null; try { priv = localStorage.getItem("porw-session-priv"); } catch {} const k = keypair(priv); try { localStorage.setItem("porw-session-priv", hex(k.priv)); } catch {} state.session = k; $("session").textContent = `session key ${hex(k.address)}`; return k; }
async function delegate() {
  const k = sessionKey(); const w = E.injectedWallet(eth()); await w.connect(); const expiry = Number(await eth().request({ method: "eth_blockNumber" })) + Number($("expiry").value || 100000);
  state.delegation = await E.makeDelegation(w, state.deployment.domains.registry, hex(k.address), expiry); log("delegation signed by the wallet (the only wallet signature the node needs)");
  const r = await api("/tx/delegate", { instance: state.delegation.instance, session: state.delegation.session, expiry: state.delegation.expiry, sig: state.delegation.sig }); log(`relayer submitted delegateBySig: ${r.ok ? "ok" : "FAILED " + r.error}`);
  state.resolved = decodeAddress(await call(state.deployment.addresses.instances, "resolve(address)", [hex(k.address)])); $("session").textContent = `session key ${hex(k.address)} → instance ${state.resolved}`;
}
async function loadModel() {
  let bytes; const f = $("file").files[0];
  if (f) bytes = new Uint8Array(await f.arrayBuffer()); else { const url = $("url").value; if (!url) throw new Error("choose a file or a URL"); bytes = new Uint8Array(await (await fetch(url)).arrayBuffer()); }
  const nT = Math.floor(bytes.length / 4096); const lv = []; for (let t = 0; t < nT; t++) lv.push(V.weightsLeaf(t, bytes.subarray(t * 4096, (t + 1) * 4096)));
  const modelId = hex(V.merkleRoot(lv)); const mepModel = state.deployment.mepModelIds ? state.deployment.mepModelIds[0] : null;
  const hdr = decodeHeader(bytes); state.model = { bytes, modelId, hdr }; $("model").textContent = `${hdr.name}: ${hdr.neurons} neurons, ${hdr.synapses} synapses, model_id ${modelId.slice(0, 14)}…`; log(`model loaded and verified locally (model_id ${modelId.slice(0, 14)}…)`);
}
async function startNode() {
  if (!state.model || !state.delegation) throw new Error("load a model and delegate first");
  const kernel = await loadKernel("/porw/sketch.wasm"); const k = sessionKey();
  const node = new PorwNode(kernel, { privHex: hex(k.priv), domains: state.deployment.domains, delegation: state.delegation });
  const st = await node.loadModel(state.model.hdr.name, state.model.bytes, { steps: Number($("steps").value || 2) });
  if (hex(st.mep.mepId).toLowerCase() !== mepId().toLowerCase()) { log(`WARNING: this model + steps gives MEP ${hex(st.mep.mepId).slice(0, 12)}…, the relayer serves ${mepId().slice(0, 12)}…`); }
  const rc = new RelayClient([state.deployment.relay], k); await rc.connect(); state.relay = rc;
  state.svc = new NodeService(node, rc, { onResult: async (res) => { const r = await api("/tx/result", res); res.submitted = r.ok; state.results.push(res); log(`task ${res.taskId.slice(0, 12)}… executed; relayer submitResult ${r.ok ? "ok" : "FAILED " + r.error}`); } });
  state.svc.serve(st.mep.mepId); state.node = node; state.st = st; log("node running: serving audits and tasks over the relay"); setInterval(loop, 3000);
}
async function refreshEpoch() { try { const e = await api("/epoch?mep=" + mepId()); state.epochInfo = e; $("epoch").textContent = `epoch ${e.epoch} · block ${e.block} · beacon ${e.rolled ? "rolled" : "pending"}`; return e; } catch (err) { return null; } }
async function loop() {
  const e = await refreshEpoch(); if (!e || !e.rolled || !state.svc) return;
  if (!state.claims[e.epoch]) { const { r } = await state.svc.announce(state.st.mep.mepId, unhex(e.challenge), { stimulusSeed: 1 }); state.claims[e.epoch] = hex(r.claimHash); log(`epoch ${e.epoch}: claim announced (${hex(r.claimHash).slice(0, 12)}…, slot ${(r.timings.sketchMs + r.timings.commitMs + r.timings.inferMs + (r.timings.disputeCommitMs || 0)).toFixed(0)} ms)`); }
  const prev = e.epoch - 1;
  if ($("auto").checked && state.claims[prev] && !state.materialized[prev]) { const p = await api(`/proof?mep=${mepId()}&epoch=${prev}&instance=${state.resolved}`); if (p.posted) { const r = await api("/tx/materialize", { mep: mepId(), epoch: prev, instance: state.resolved }); state.materialized[prev] = r.ok; log(`epoch ${prev}: materialized via relayer ${r.ok ? "ok (gas " + r.gasUsed + ")" : "FAILED " + r.error}`); } }
}
const wrap = (fn) => async () => { try { await fn(); } catch (e) { state.errors.push(String(e.message || e)); log("ERROR " + (e.message || e)); } };
$("btnDep").onclick = wrap(loadDeployment); $("btnConnect").onclick = wrap(connect); $("btnBond").onclick = wrap(bond); $("btnExit").onclick = wrap(requestExit); $("btnFinalize").onclick = wrap(finalizeExit);
$("btnDelegate").onclick = wrap(delegate); $("btnModel").onclick = wrap(loadModel); $("btnStart").onclick = wrap(startNode); $("btnRefresh").onclick = wrap(refreshBond);
window.appActions = { loadDeployment, connect, bond, delegate, loadModel, startNode, refreshBond, loop };
window.__ready = true;
