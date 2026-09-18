// A headless instance on the LIVE BSC testnet deployment, against a running relayer (env: PORW_* from
// .env.bsc-testnet, PORW_RELAYER_API): bond, delegate a session key (sponsored), hold the real FlyWire brain,
// announce a claim per epoch, materialize when the root is posted, then post one task, execute it (this
// instance is the only bonded one, so sortition picks it), get the result submitted and settle.
//   PORW_RELAYER_API=http://127.0.0.1:8799 node test/live_bsc.mjs <payload.bin> [bondBNB=0.05]
import fs from "node:fs"; import path from "node:path";
import { parseEther, keccak256, encodePacked, formatEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { deploymentFromEnv } from "../relayer/env.mjs";
import { clients } from "../relayer/chain.mjs";
import * as H from "./harness.mjs";
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const [payloadPath, bondBnb = "0.05"] = process.argv.slice(2); const API = process.env.PORW_RELAYER_API || "http://127.0.0.1:8799";
const api = async (p, body) => (await fetch(API + p, body ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {})).json();
const dep = deploymentFromEnv(); const pk = process.env.PORW_DEPLOYER_KEY; const c = clients(dep, pk); const wallet = c.account.address;
const d = await api("/deployment"); const mepId = d.meps[0]; const domains = d.domains; log(`relayer ${d.relayer}, relay ${d.relay}, MEP ${mepId.slice(0, 12)}…, wallet ${wallet}`);
const evidence = { chainId: dep.chainId, wallet, mepId, txs: {} };
// 1. bond (once)
if ((await c.instances.read.bonded([wallet])) === 0n) { const h = await c.instances.write.bond([[mepId]], { value: parseEther(bondBnb) }); const r = await c.pub.waitForTransactionReceipt({ hash: h }); evidence.txs.bond = h; log(`bond ${bondBnb} BNB: ${r.status} ${h}`); }
log(`bonded ${formatEther(await c.instances.read.bonded([wallet]))} BNB, ${await c.instances.read.weightOf([wallet])} vote(s)`);
// 2. session key + delegation through the relayer
const E = await H.porw("eip712.js"); const { keypair } = await H.porw("claim.js"); const session = keypair(null); const lw = E.localWallet(pk);
const del = await E.makeDelegation(lw, domains.registry, H.hex(session.address), Number(await c.pub.getBlockNumber()) + 200000);
const dr = await api("/tx/delegate", { instance: del.instance, session: del.session, expiry: del.expiry, sig: del.sig }); evidence.txs.delegate = dr.hash; log(`delegateBySig via relayer: ${dr.ok ? "ok" : "FAILED " + dr.error} ${dr.hash || ""}`);
// 3. the real brain, resident
const { PorwNode } = await H.porw("node.js"); const { loadKernelFromBytes } = await H.porw("porw.js"); const { RelayClient } = await H.porw("relay_client.js"); const { NodeService } = await H.porw("node_service.js");
const payload = new Uint8Array(fs.readFileSync(payloadPath)); const nd = new PorwNode(await loadKernelFromBytes(fs.readFileSync(path.join(H.porwDir, "sketch.wasm"))), { privHex: H.hex(session.priv), domains, delegation: del });
let t0 = Date.now(); const st = await nd.loadModel("flywire-fafb-v783-min5", payload, { steps: 100, commitStride: 10 }); log(`model resident: ${st.hdr.neurons} neurons, mep ${H.hex(st.mep.mepId).slice(0, 12)}… (${H.hex(st.mep.mepId).toLowerCase() === mepId ? "matches the registered MEP" : "MISMATCH"}), ${((Date.now() - t0) / 1000).toFixed(1)} s`);
const rc = new RelayClient([d.relay], nd.key); await rc.connect(); const results = [];
const svc = new NodeService(nd, rc, { onResult: async (res) => { const r = await api("/tx/result", res); res.relayer = r; results.push(res); evidence.txs.result = r.hash; log(`result submitted via relayer: ${r.ok ? "ok" : "FAILED " + r.error} ${r.hash || ""}`); } }); svc.serve(st.mep.mepId);
// 4. epochs: claim each rolled epoch; materialize the previous one once its root is posted; then a task
const claims = {}, materialized = {}; let taskId = null, settled = false, wokeEpoch = null; const deadline = Date.now() + 75 * 60 * 1000;
while (Date.now() < deadline && !settled) {
  try {
    const e = await api("/epoch?mep=" + mepId);
    // announce ourselves once an epoch, the way the node page does: against a relayer running with
    // PORW_BEACON_LAZY=1 nothing else would wake the beacon and this script would wait out its deadline.
    if (wokeEpoch !== e.epoch) { wokeEpoch = e.epoch; const w = await api("/wake", { instance: wallet }).catch(() => ({})); if (w.lazy) log(`epoch ${e.epoch}: woke the relayer's beacon through ${w.wakeUntil}`); }
    if (e.rolled && !claims[e.epoch]) { t0 = Date.now(); const { r } = await svc.announce(st.mep.mepId, H.unhex(e.challenge), { stimulusSeed: 1 }); claims[e.epoch] = H.hex(r.claimHash); log(`epoch ${e.epoch}: claim announced ${claims[e.epoch].slice(0, 12)}… (slot ${((Date.now() - t0) / 1000).toFixed(1)} s incl. 100 LIF steps + commitments)`); }
    const prev = e.epoch - 1;
    if (claims[prev] && !materialized[prev]) { const p = await api(`/proof?mep=${mepId}&epoch=${prev}&instance=${wallet}`); if (p.posted) { const r = await api("/tx/materialize", { mep: mepId, epoch: prev, instance: wallet }); materialized[prev] = r.ok; evidence.txs.materialize = r.hash; log(`epoch ${prev}: materializeClaim via relayer ${r.ok ? "ok gas " + r.gasUsed : "FAILED " + r.error} ${r.hash || ""}`); } }
    // eligible this epoch (materialized claim for e-1)? post one task and execute it
    if (!taskId && materialized[prev] && (await c.instances.read.isEligible([wallet, mepId, BigInt(e.epoch)]))) {
      const nonce = keccak256(encodePacked(["uint64"], [BigInt(Date.now())]));
      const h = await c.market.write.postTask([{ mepId, stimulusSeed: 7, inputCommit: "0x" + "00".repeat(32), fee: parseEther("0.001"), deadline: BigInt(Number(await c.pub.getBlockNumber()) + 2000), redundancy: 1 }, nonce], { value: parseEther("0.001") });
      await c.pub.waitForTransactionReceipt({ hash: h }); taskId = keccak256(encodePacked(["bytes32", "uint32", "bytes32"], [mepId, 7, nonce])); evidence.txs.postTask = h; evidence.taskId = taskId;
      const ex = await c.market.read.executors([taskId]); log(`task ${taskId.slice(0, 12)}… posted ${h}; executors ${ex.join(",")}`);
      const client = new RelayClient([d.relay], keypair(null)); await client.connect();
      const resp = await client.request(H.hex(session.address), "task-announce", mepId, { taskId, stimulusSeed: 7 }, { timeoutMs: 120000, responseType: "result" }); log(`executed over the relay: execDigest ${resp.payload.execDigest.slice(0, 14)}…`); client.close();
    }
    if (taskId && results[0]?.relayer?.ok && !settled) { const s = await api("/tx/settle", { taskId, instance: wallet }); if (s.ok) { settled = true; evidence.txs.settle = s.hash; log(`settled ${s.hash}; fee paid to ${wallet}`); } }
  } catch (err) { log("loop error:", String(err.shortMessage || err.message).slice(0, 200)); }
  await H.sleep(15000);
}
evidence.claims = claims; evidence.materialized = materialized; fs.writeFileSync(process.env.PORW_EVIDENCE || "/tmp/live-bsc-evidence.json", JSON.stringify(evidence, null, 1)); log("done", JSON.stringify(evidence.txs)); rc.close(); process.exit(settled ? 0 : 1);
