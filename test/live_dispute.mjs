// A real execution dispute on the LIVE BSC testnet deployment, against the real FlyWire brain. This is the claim
// the whole design rests on -- that a wrong result can be narrowed on-chain to the single synapse term that was
// wrong, and paid for by the party that lied -- and until it happens on a public chain it is a claim about a test.
//
// Needs a relayer running against the same deployment (see README), an instance A that is already bonded, and a
// funded key for instance B, which will lie and lose its bond to A. Every move is a real transaction.
//   PORW_RELAYER_API=http://127.0.0.1:8799 node test/live_dispute.mjs <payload.bin> <B private key>
import fs from "node:fs"; import path from "node:path";
import { parseEther, formatEther, keccak256, encodePacked } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { deploymentFromEnv } from "../relayer/env.mjs";
import { clients } from "../relayer/chain.mjs";
import * as H from "./harness.mjs";
import { driveDispute, DISPUTES_ABI } from "./dispute_driver.mjs";
let fails = 0; const check = (n, ok) => { console.log((ok ? "  ok   " : "  FAIL ") + n); if (!ok) fails++; };
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const API = process.env.PORW_RELAYER_API || "http://127.0.0.1:8799";
const api = async (p, body) => (await fetch(API + p, body ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {})).json();
const [payloadPath, bKey] = process.argv.slice(2);
if (!payloadPath || !bKey) { console.log("usage: PORW_RELAYER_API=... live_dispute.mjs <payload.bin> <B private key>"); process.exit(2); }

const dep = deploymentFromEnv(); if (!dep) throw new Error("source the .env.<network> first");
const aKey = process.env.PORW_DEPLOYER_KEY; if (!aKey) throw new Error("PORW_DEPLOYER_KEY (instance A)");
const cA = clients(dep, aKey), cB = clients(dep, bKey);
const d = await api("/deployment"); const mepId = d.meps[0]; const domains = d.domains; const disputes = dep.addresses.disputes;
const SEED = 11, S_LIE = 18; const FEE = parseEther("0.0002"); const evidence = { chainId: dep.chainId, mepId, txs: {} };
log(`relayer ${d.relayer} at ${API}; A ${cA.account.address}; B ${cB.account.address}; disputes ${disputes}`);

// ---- 0. can anybody afford this? the beacon deposit is what actually gates the relayer ----
const DEPOSIT = parseEther("0.1");
const bal = async (a) => cA.pub.getBalance({ address: a });
const [balR, balA, balB] = await Promise.all([bal(d.relayer), bal(cA.account.address), bal(cB.account.address)]);
log(`balances: relayer ${formatEther(balR)}, A ${formatEther(balA)}, B ${formatEther(balB)} BNB`);
check(`the relayer can cover a beacon deposit (needs > 0.1 BNB, has ${formatEther(balR)})`, balR > DEPOSIT);
if (balB < parseEther("0.052")) { log(`funding B with 0.055 from A…`); const h = await cA.wallet.sendTransaction({ to: cB.account.address, value: parseEther("0.055") }); await cA.pub.waitForTransactionReceipt({ hash: h }); evidence.txs.fundB = h; }
if (fails) { console.log("\nfund the relayer key before running this: with a lazy beacon it looks healthy at zero balance until the first wake."); process.exit(1); }

// ---- 1. both instances bonded and delegated ----
const mkInstance = async (c, key, tag) => {
  const E = await H.porw("eip712.js"); const { keypair } = await H.porw("claim.js");
  if ((await c.instances.read.weightOf([c.account.address])) === 0n) { log(`${tag}: bonding 0.05…`); const h = await c.instances.write.bond([[mepId]], { value: parseEther("0.05") }); await c.pub.waitForTransactionReceipt({ hash: h }); evidence.txs["bond" + tag] = h; }
  const session = keypair(null); const wallet = E.localWallet(key);
  const del = await E.makeDelegation(wallet, domains.registry, H.hex(session.address), Number(await c.pub.getBlockNumber()) + 200000);
  const r = await api("/tx/delegate", { instance: del.instance, session: del.session, expiry: del.expiry, sig: del.sig });
  if (!r.ok) throw new Error(`${tag} delegate failed: ${r.error}`);
  evidence.txs["delegate" + tag] = r.hash;
  return { c, wallet, session, del, addr: c.account.address.toLowerCase() };
};
const A = await mkInstance(cA, aKey, "A"), B = await mkInstance(cB, bKey, "B");
check("both instances carry sortition weight and have delegated session keys", (await cA.instances.read.weightOf([cA.account.address])) > 0n && (await cA.instances.read.weightOf([cB.account.address])) > 0n);

// ---- 2. the real brain, resident in both nodes ----
const { PorwNode } = await H.porw("node.js"); const { loadKernelFromBytes } = await H.porw("porw.js");
const { RelayClient } = await H.porw("relay_client.js"); const { NodeService } = await H.porw("node_service.js");
const V = await H.porw("verify.js"), D = await H.porw("dispute.js"), L = await H.porw("lif.js");
const payload = new Uint8Array(fs.readFileSync(payloadPath)); const wasm = fs.readFileSync(path.join(H.porwDir, "sketch.wasm"));
const m = await cA.meps.read.getMEP([mepId]); const STEPS = Number(process.env.PORW_STEPS || 100), STRIDE = Number(process.env.PORW_STRIDE || 10); // the task's now, not the MEP's
for (const [X, tag] of [[A, "A"], [B, "B"]]) {
  const t0 = Date.now();
  X.nd = new PorwNode(await loadKernelFromBytes(wasm), { privHex: H.hex(X.session.priv), domains, delegation: X.del });
  X.st = await X.nd.loadModel("flywire", payload, { maxSteps: STEPS, exec: "lif" });
  if (H.hex(X.st.mep.mepId).toLowerCase() !== mepId) throw new Error(`${tag}: local mep_id does not match the registered MEP`);
  X.rc = new RelayClient([d.relay], X.nd.key, { onLog: (s) => log(`${tag} relay: ${s}`) }); await X.rc.connect();
  X.results = []; X.svc = new NodeService(X.nd, X.rc, { onResult: async (res) => { X.results.push(res); res.relayer = await api("/tx/result", res); } }); X.svc.serve(X.st.mep.mepId);
  log(`${tag}: ${X.st.hdr.neurons} neurons resident in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}
const n = A.st.hdr.neurons, mepIdBytes = A.st.mep.mepId, challengeBytes = new Uint8Array(32);
check(`the registered brain is resident in both nodes (${n} neurons, ${STEPS} steps, stride ${STRIDE})`, n > 0 && S_LIE <= STEPS && Math.floor((S_LIE - 1) / STRIDE) >= 1);

// ---- 3. pick a neuron where inflating one input term changes the outcome ----
log("running the task stimulus once to choose a neuron to lie about…");
await A.nd.challenge(mepIdBytes, challengeBytes, { steps: STEPS, commitStride: STRIDE, stimulusSeed: SEED });
const prev = await A.nd.lifStates(mepIdBytes, S_LIE - 1);
let NEURON = -1, DELTA = 0, inDeg = 0;
for (let i = 1; i < n; i++) {
  const S = L.decodeState(prev, i * 16); if (S.refr > 0 || (S.flags & 1)) continue;
  const ps = await A.nd.lifPartialSums(mepIdBytes, S_LIE, i); if (ps.sums.length < 3) continue;
  const last = ps.sums[ps.sums.length - 1];
  for (const c of [40, 400, 4000, 40000, 400000, 4000000]) { if (!L.sameState(L.transition(S, last, i, S_LIE, SEED), L.transition(S, last + BigInt(c), i, S_LIE, SEED))) { DELTA = c; break; } }
  if (DELTA) { NEURON = i; inDeg = ps.sums.length; break; }
}
check(`chose neuron ${NEURON} (in-degree ${inDeg}); inflating one of its input terms by ${DELTA} changes its state at step ${S_LIE}`, NEURON > 0);
Object.assign(evidence, { neurons: n, steps: STEPS, stride: STRIDE, lie: { step: S_LIE, neuron: NEURON, delta: DELTA, kind: "input", inDegree: inDeg } });

// ---- 4. wait out the epochs: a claim from each, then materialize, so sortition can pick both ----
const waitFor = async (p, ms, what) => { const t0 = Date.now(); let last = 0; while (Date.now() - t0 < ms) { if (await p()) return true; const el = Math.floor((Date.now() - t0) / 1000); if (el - last >= 30) { last = el; log(`  still waiting on ${what} (${el}s)`); } await sleep(5000); } return false; };
let woke = null;
const tick = async () => { const e = await api("/epoch?mep=" + mepId); if (woke !== e.epoch) { woke = e.epoch; for (const X of [A, B]) await api("/wake", { instance: X.addr }); } return e; };
log("waking the relayer and waiting for a rolled epoch (up to two epochs ~20 min with a lazy beacon)…");
let ep = await tick();
check("the relayer produced a beacon and rolled an epoch", await waitFor(async () => { ep = await tick(); return ep.rolled; }, 45 * 60000, "a rolled epoch"));
const claimEpoch = ep.epoch;
for (const X of [A, B]) { const { r } = await X.svc.announce(mepIdBytes, H.unhex(ep.challenge)); log(`claim announced for epoch ${claimEpoch}: ${H.hex(r.claimHash).slice(0, 14)}…`); }
evidence.claimEpoch = claimEpoch;
check(`both residency claims collected for epoch ${claimEpoch}`, await waitFor(async () => { await tick(); const s = await api("/status"); return s.aggregators?.[0]?.epochs?.some((x) => x.epoch === claimEpoch && x.claims === 2); }, 10 * 60000, "the aggregator"));
check(`the epoch-${claimEpoch} root was posted in the next epoch`, await waitFor(async () => { await tick(); const s = await api("/status"); return s.rootsPosted?.some((r) => r.epoch === claimEpoch && r.count === 2); }, 30 * 60000, "the epoch root"));
for (const [X, tag] of [[A, "A"], [B, "B"]]) { const r = await api("/tx/materialize", { mep: mepId, epoch: claimEpoch, instance: X.addr }); evidence.txs["materialize" + tag] = r.hash; check(`${tag}'s claim materialized (gas ${r.gasUsed})`, r.ok); }
const nowEpoch = (await api("/epoch")).epoch;
check("both instances are eligible to be picked for a task", (await cA.instances.read.isEligible([cA.account.address, mepId, BigInt(nowEpoch)])) && (await cA.instances.read.isEligible([cB.account.address, mepId, BigInt(nowEpoch)])));

// ---- 5. B starts lying, a task goes out, and the two answers disagree ----
B.nd.execLie = { step: S_LIE, neuron: NEURON, delta: DELTA, kind: "input" };
log(`B is now lying about neuron ${NEURON} at step ${S_LIE}; posting a task with redundancy 2`);
const nonce = keccak256(encodePacked(["uint64"], [BigInt(Date.now())]));
const task = { mepId, stimulusSeed: SEED, steps: STEPS, commitStride: STRIDE, inputCommit: "0x" + "00".repeat(32), fee: FEE, deadline: BigInt(Number(await cA.pub.getBlockNumber()) + 3000), redundancy: 2 };
const ph = await cA.market.write.postTask([task, nonce], { value: FEE });
await cA.pub.waitForTransactionReceipt({ hash: ph }); evidence.txs.postTask = ph;
const taskId = H.taskIdOf(task, nonce); evidence.taskId = taskId;
const ex = (await cA.market.read.executors([taskId])).map((x) => x.toLowerCase());
check(`sortition picked both instances (${ex.join(", ")})`, ex.length === 2 && ex.includes(A.addr) && ex.includes(B.addr));
const { keypair } = await H.porw("claim.js");
const client = new RelayClient([d.relay], keypair(null)); await client.connect();
for (const [X, tag] of [[A, "A"], [B, "B"]]) { const resp = await client.request(H.hex(X.session.address), "task-announce", mepId, { taskId, stimulusSeed: SEED }, { timeoutMs: 180000, responseType: "result" }); log(`${tag} answered: execRoot ${resp.payload.execRoot.slice(0, 14)}…`); }
check("both results are on-chain and the two execRoots disagree", await waitFor(async () => A.results[0]?.relayer?.ok && B.results[0]?.relayer?.ok, 5 * 60000, "both results") && A.results[0].execRoot !== B.results[0].execRoot);
evidence.txs.resultA = A.results[0]?.relayer?.hash; evidence.txs.resultB = B.results[0]?.relayer?.hash;

// ---- 6. settle refuses to pay and opens the dispute ----
const s = await api("/tx/settle", { taskId, instance: A.addr }); evidence.txs.settle = s.hash;
const pA = await cA.pub.readContract({ address: disputes, abi: DISPUTES_ABI, functionName: "partyA", args: [taskId] });
check(`settle opened a dispute instead of paying (partyA ${pA})`, s.ok && pA !== "0x0000000000000000000000000000000000000000");

// ---- 7. play it out ----
A.execRoot = A.results[0].execRoot; B.execRoot = B.results[0].execRoot;
const out = await driveDispute(A, B, { taskId, disputes, mepIdBytes, n, steps: STEPS, stride: STRIDE, seed: SEED, challengeBytes, sLie: S_LIE, neuron: NEURON, delta: DELTA, chunkSize: A.st.csr.chunk },
  { D, V, L, hex: H.hex }, { check, log: (x) => log("  " + x) });
Object.assign(evidence, out, { honest: A.addr, liar: B.addr });
fs.writeFileSync(process.env.PORW_EVIDENCE || "/tmp/live-dispute-evidence.json", JSON.stringify(evidence, null, 1));
log("evidence written; " + JSON.stringify(evidence.txs));
for (const X of [A, B]) X.rc.close(); client.close();
console.log(fails ? `${fails} FAILURES` : "ALL PASS");
process.exit(fails ? 1 : 0);
