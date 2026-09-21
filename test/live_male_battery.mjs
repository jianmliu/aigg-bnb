// A male brain's standard battery, on the LIVE BSC testnet: one bonded instance holds the payload at weight
// unit 7209, the project posts the 42-run battery as ONE batched task, that instance executes it, the result is
// submitted through the relayer and settled -- and then the digests the network signed are joined, run by run,
// with the ones numpy produced offline for the same brain -- the payload as registered, not the dataset's "base".
//
//   source .env.bsc-testnet; PORW_RELAYER_API=https://… [PORW_MEP=0x… PORW_REF=/abs/row.json PORW_MODEL_NAME=…] \\
//     node test/live_male_battery.mjs <payload.bin>
//
// PORW_MEP picks the brain (default: the registered male base). For a minted fly it is that token's MEP and the
// payload is its base with its delta applied; PORW_REF is then the row run_battery.py already wrote for the same
// individual -- which, for an individual, needs no special reference: a genotype zeroes what falls under min_syn,
// so its payload and its offline row are the same network.
//
// The join is the point. A row of this dataset is a claim about a brain, and it is worth what can be checked:
// here the wasm kernel on the network and numpy at a desk have to produce the same counts digest for all 42 runs,
// under a weight unit that is NOT the default one -- so nothing can be passing by accident on FlyWire's constant.
//
// Redundancy is 1 because exactly one instance is enrolled for this brain. That settles a result but does not test
// agreement between executors, and the script says so rather than printing a number that looks like consensus.
import fs from "node:fs"; import path from "node:path";
import { parseEther, formatEther } from "viem";
import { deploymentFromEnv } from "../relayer/env.mjs";
import { clients } from "../relayer/chain.mjs";
import { postBatteryTask, announceBattery, settledAs, checkAgainstOffline, clientAllowed } from "../flybnb/battery/post_battery.mjs";
import { batteryBatch, resolvedRuns } from "../flybnb/battery/battery_batch.mjs";
import * as H from "./harness.mjs";

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const [payloadPath] = process.argv.slice(2);
const API = (process.env.PORW_RELAYER_API || "http://127.0.0.1:8799").replace(/\/$/, "");
const api = async (p, body) => (await fetch(API + p, body ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {})).json();
const battery = JSON.parse(fs.readFileSync(new URL("../flybnb/battery/battery-male-v1.json", import.meta.url)));
const REF = process.env.PORW_REF ? new URL(process.env.PORW_REF, "file://") : new URL("../flybnb/results/male/live/registered-base.json", import.meta.url);
if (!payloadPath) { console.error("usage: live_male_battery.mjs <malecns-v1.0-min2.bin>"); process.exit(2); }

const dep = deploymentFromEnv(); const pk = process.env.PORW_DEPLOYER_KEY; if (!dep || !pk) throw new Error("source .env.bsc-testnet first");
const c = clients(dep, pk); const wallet = c.account.address;
const d = await api("/deployment");
// The registered male base, pinned as a literal so test/brain_addresses.mjs can hold this file to the same
// content address as the battery, the profile and the genesis bases. PORW_MEP runs the script on another brain.
const MALE = "0xc17357517fa10c848713812c75543a7e74978bb1f4554dab75bcf7315022d214";
const MEP = (process.env.PORW_MEP || MALE).toLowerCase();
const served = await api("/meps");
const info = served.find((m) => m.mepId.toLowerCase() === MEP);
if (!info) throw new Error("the relayer does not serve the male brain");
if (info.wUnitQ16 !== battery.population.w_unit_q16) throw new Error(`the relayer says unit ${info.wUnitQ16}, the battery's population says ${battery.population.w_unit_q16}`);
log(`relayer ${d.relayer} | male MEP ${MEP.slice(0, 14)}… unit ${info.wUnitQ16} | wallet ${wallet}`);
if (!clientAllowed(d, wallet)) throw new Error(`${wallet} is not a task client of this relayer: its results would never be sponsored`);

const evidence = { chainId: dep.chainId, wallet, mepId: MEP, wUnitQ16: info.wUnitQ16, battery: { name: battery.name, version: battery.version, runs: battery.stimuli.length * battery.seeds.length }, txs: {} };

// ---- 1. enrol this instance for the male brain (it is bonded already; any value adds to the bond and enrols) ----
const ENROL = process.env.PORW_ENROL_BNB || "0.002";
if (!(await c.instances.read.isBondedFor([wallet, MEP]))) {
  const h = await c.instances.write.bond([[MEP]], { value: parseEther(ENROL) });
  const r = await c.pub.waitForTransactionReceipt({ hash: h }); evidence.txs.bond = h;
  log(`enrolled for the male brain: ${r.status}, bond now ${formatEther(await c.instances.read.bonded([wallet]))} BNB, ${await c.instances.read.weightOf([wallet])} vote(s)`);
} else log(`already enrolled for the male brain (bond ${formatEther(await c.instances.read.bonded([wallet]))} BNB, ${await c.instances.read.weightOf([wallet])} vote(s))`);

// ---- 2. a session key, delegated through the relayer (the browser page's own move) ----
const E = await H.porw("eip712.js"); const { keypair } = await H.porw("claim.js");
const session = keypair(null); const lw = E.localWallet(pk);
const del = await E.makeDelegation(lw, d.domains.registry, H.hex(session.address), Number(await c.pub.getBlockNumber()) + 200000);
const dr = await api("/tx/delegate", { instance: del.instance, session: del.session, expiry: del.expiry, sig: del.sig });
evidence.txs.delegate = dr.hash; log(`session ${H.hex(session.address).slice(0, 12)}… delegated: ${dr.ok ? "ok " + dr.hash : JSON.stringify(dr)}`);

// ---- 3. the male brain, resident, at its own weight unit ----
const { PorwNode } = await H.porw("node.js"); const { loadKernelFromBytes } = await H.porw("porw.js");
const { RelayClient } = await H.porw("relay_client.js"); const { NodeService } = await H.porw("node_service.js");
const porw = { batch: await H.porw("batch.js"), verify: await H.porw("verify.js") };
const payload = new Uint8Array(fs.readFileSync(payloadPath));
const nd = new PorwNode(await loadKernelFromBytes(fs.readFileSync(path.join(H.porwDir, "sketch.wasm"))), { privHex: H.hex(session.priv), domains: d.domains, delegation: del });
let t0 = Date.now();
// A brain that belongs to a collection is registered WITH TERMS, and the terms are inside the id: the profile of
// the same bytes is a different MEP, and the terms are nowhere in the payload, so a node must be told them. This
// is what the relayer does too; without it a minted fly looks like the wrong payload.
const terms = info.beneficiary && info.royaltyBps ? { beneficiary: info.beneficiary, royaltyBps: info.royaltyBps } : null;
if (terms) log(`terms: ${terms.royaltyBps} bps to ${terms.beneficiary.slice(0, 10)}… -- the MEP id wraps them`);
const st = await nd.loadModel(process.env.PORW_MODEL_NAME || "malecns-v1.0-min2", payload, { maxSteps: battery.steps, exec: "lif", wUnitQ16: battery.population.w_unit_q16, terms });
if (H.hex(st.mep.mepId).toLowerCase() !== MEP) throw new Error(`this payload under unit ${battery.population.w_unit_q16} is MEP ${H.hex(st.mep.mepId)}, not ${MEP}`);
log(`resident: ${st.hdr.neurons} neurons, ${st.hdr.synapses} synapses, mepId reproduces (${((Date.now() - t0) / 1000).toFixed(1)} s)`);

const rc = new RelayClient([d.relay], nd.key); await rc.connect();
const results = [];
const svc = new NodeService(nd, rc, { onResult: async (res) => { const r = await api("/tx/result", res); res.relayer = r; results.push(res); evidence.txs.result = r.hash; log(`result submitted through the relayer: ${r.ok ? "ok " + r.hash : JSON.stringify(r).slice(0, 200)}`); } });
svc.serve(st.mep.mepId);

// ---- 4. an epoch's claim, materialized, until this instance is eligible ----
const claims = {}, materialized = {}; let woke = null, att = null, settled = false, posted = process.env.PORW_TASK_ID ? { taskId: process.env.PORW_TASK_ID, fee: 0n, redundancy: 1 } : null, runsRoot = null;
const EV = process.env.PORW_EVIDENCE || "/tmp/live-male-battery.json";
const deadline = Date.now() + Number(process.env.PORW_DEADLINE_MIN || 75) * 60 * 1000;
while (Date.now() < deadline && !settled) {
  try {
    const e = await api("/epoch?mep=" + MEP);
    if (woke !== e.epoch) { woke = e.epoch; const w = await api("/wake", { instance: wallet }).catch(() => ({})); if (w.lazy) log(`epoch ${e.epoch}: woke the beacon through ${w.wakeUntil}`); }
    if (e.rolled && !claims[e.epoch]) { const { r } = await svc.announce(st.mep.mepId, H.unhex(e.challenge)); claims[e.epoch] = H.hex(r.claimHash); log(`epoch ${e.epoch}: claim announced`); }
    const prev = e.epoch - 1;
    if (claims[prev] && !materialized[prev]) {
      const p = await api(`/proof?mep=${MEP}&epoch=${prev}&instance=${wallet}`);
      if (p.posted) { const r = await api("/tx/materialize", { mep: MEP, epoch: prev, instance: wallet }); if (r.ok) { materialized[prev] = r.hash; evidence.txs.materialize = r.hash; log(`epoch ${prev}: materialized ${r.hash}`); } }
    }
    if (!att && materialized[prev] && (await c.instances.read.isEligible([wallet, MEP, BigInt(e.epoch)]))) {
      if (!runsRoot) { t0 = Date.now(); runsRoot = (await nd.batchRunsRoot(st.mep.mepId, resolvedRuns(batteryBatch(battery)))).runsRoot; log(`runs root over ${batteryBatch(battery).runs.length} runs (${((Date.now() - t0) / 1000).toFixed(0)} s)`); }
      // A task is posted AT MOST ONCE. Announcing is what fails on a flaky RPC, and re-posting to retry it pays the
      // fee again -- which is exactly what this script did thirteen times before it was split in two.
      if (!posted) { posted = await postBatteryTask({ battery, mepId: MEP, runsRoot, chain: c, fee: parseEther(process.env.PORW_FEE || "0.002"), redundancy: 1, deadlineBlocks: 4000, log: (m) => log("  " + m) }); evidence.taskId = posted.taskId; evidence.txs.postBatch = posted.txHash; evidence.gasUsed = posted.gasUsed; fs.writeFileSync(EV, JSON.stringify(evidence, null, 1)); }
      t0 = Date.now();
      att = await announceBattery({ battery, mepId: MEP, runsRoot, chain: c, relay: rc, porw, ...posted, timeoutMs: 40 * 60 * 1000, log: (m) => log("  " + m) });
      log(`executed and returned in ${((Date.now() - t0) / 60000).toFixed(1)} min: ${att.rows.length} rows, batch root ${att.batchRoot || "(single executor)"}`);
      if (!att.rows.length) { log(`  no rows came back: ${JSON.stringify(att.replies).slice(0, 240)} -- will retry the ANNOUNCE for the same task`); att = null; }
    }
    if (att && results[0]?.relayer?.ok && !settled) {
      const s = await api("/tx/settle", { taskId: att.taskId, instance: wallet });
      if (s.ok) { settled = true; evidence.txs.settle = s.hash; log(`settled ${s.hash}`); }
    }
  } catch (err) { log("loop:", String(err.shortMessage || err.message).slice(0, 220)); }
  if (!settled) await H.sleep(15000);
}

// ---- 5. what it is worth: the network's digests against the offline runner's, run by run ----
if (att) {
  const on = await settledAs(c, att); evidence.settled = on;
  log(`on chain the task settled on ${on.onChain.join(", ")}`);
  // The reference is a row for THE PAYLOAD THIS MEP IS, recomputed by flybnb/male/recompute_live.py. It is not the
  // dataset's "base" row: run_battery.py's base is the published wiring, the >= 2-synapse export thresholded at five,
  // and the >= 2 export itself -- the substrate individuals are drawn on, and what is registered here -- is a denser
  // network than that. Joining against the wrong one of the two is what this script did the first time, and all 42
  // digests differed, which is the right answer to the wrong question.
  const ref = fs.existsSync(REF) ? JSON.parse(fs.readFileSync(REF, "utf8")) : null;
  const join = ref ? checkAgainstOffline(att, ref, battery) : null; if (join) evidence.offline = { id: ref.id, ...join };
  console.log("");
  console.log(`  executors drawn        ${att.executors.length}${att.executors.length < 2 ? " (redundancy 1: settled and attested, but nothing cross-checked it on the network)" : ""}`);
  console.log(`  every reply complete   ${att.complete}   agreement between executors: ${att.agreed}`);
  console.log(`  runs                   ${att.rows.length}`);
  if (!join) console.log(`  no offline reference at ${REF.pathname} -- build one with flybnb/male/recompute_live.py`);
  else {
    console.log(`  digests equal offline  ${join.matched}/${join.expected}${join.ok ? "  <- the wasm kernel on the network and numpy at a desk agree, at unit " + battery.population.w_unit_q16 : ""}`);
    for (const m of join.mismatches.slice(0, 10)) console.log(`    MISMATCH run ${m.run} ${m.stimulus} seed ${m.seed}: network ${m.network} offline ${m.offline}`);
  }
  fs.writeFileSync(EV, JSON.stringify({ ...evidence, attestation: att }, null, 1)); log(`evidence -> ${EV}`);
  process.exit(join?.ok && settled ? 0 : 1);
}
log("no battery was posted before the deadline"); process.exit(1);
