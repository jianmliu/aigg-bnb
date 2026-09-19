// A real execution dispute, end to end on a local anvil: two bonded instances execute the same task, one of them
// lies about a single neuron's accumulated input at one step, the market notices the disagreement when it tries
// to settle, and the interactive dispute narrows it -- segment, then step, then a binary search down the
// activation tree to one neuron, then that neuron's row -- until one signed synapse term decides it on-chain and
// the liar's bond goes to the honest executor. This is the claim the whole design rests on and, until now, it had
// only ever run against Solidity fixtures, never against two live nodes on a chain.
import fs from "node:fs"; import path from "node:path";
import { parseEther, keccak256, encodePacked, parseAbi } from "viem";
import * as H from "./harness.mjs";
let fails = 0; const check = (n, ok) => { console.log((ok ? "  ok   " : "  FAIL ") + n); if (!ok) fails++; };
const anvil = await H.startAnvil(8559);
try {
  const dep = await H.deploy(anvil.rpc);
  const { synthesizePayloadV2 } = await H.porw("synth.js"); const { PorwNode } = await H.porw("node.js"); const { loadKernelFromBytes } = await H.porw("porw.js");
  const { RelayClient } = await H.porw("relay_client.js"); const { NodeService } = await H.porw("node_service.js"); const { keypair } = await H.porw("claim.js");
  const E = await H.porw("eip712.js"); const V = await H.porw("verify.js"); const D = await H.porw("dispute.js"); const L = await H.porw("lif.js");
  const wasm = fs.readFileSync(path.join(H.porwDir, "sketch.wasm"));
  const STEPS = 20, STRIDE = 5, SEED = 9, NEURONS = 3000, SYNAPSES = 30000;
  // LIF_WUNIT=<q16>: run the whole dispute under another int-lif KIND -- the same rule with another weight unit, which is
  // what a connectome counted on another scale pins (MaleCNS). The kind is declared on-chain first; the nodes load the
  // model under it; the chain's row check then has to use that unit too, or the honest row would not verify.
  const WUNIT = Number(process.env.LIF_WUNIT || 0); const lifOpts = { maxSteps: STEPS, exec: "lif", ...(WUNIT ? { wUnitQ16: WUNIT } : {}) };
  const payload = synthesizePayloadV2("lif-dispute", NEURONS, SYNAPSES);

  // ---- register the LIF MEP ----
  const probe = new PorwNode(await loadKernelFromBytes(wasm), { privHex: H.KEYS[4] });
  const pst = await probe.loadModel("lif-dispute", payload, lifOpts);
  const mep = pst.mep, mepId = H.hex(mep.mepId); const n = pst.hdr.neurons;
  { const c = H.clientsFor(dep, H.KEYS[0]);
    if (WUNIT) { await c.pub.waitForTransactionReceipt({ hash: await c.meps.write.declareLifKind([WUNIT]) });
      check(`kind declared on-chain: weight unit ${WUNIT}, and its digest is the node's`, Number(await c.meps.read.lifWeightUnit([H.hex(mep.execKind)])) === WUNIT && H.hex(mep.execKind) === H.hex(L.lifExecKind(WUNIT)) && H.hex(mep.execKind) !== H.hex(L.lifExecKind())); }
    await c.pub.waitForTransactionReceipt({ hash: await c.meps.write.registerMEP([{ modelId: H.hex(mep.modelId), schemeDigest: H.hex(mep.schemeDigest), execKind: H.hex(mep.execKind), neurons: pst.hdr.neurons, synapses: pst.hdr.synapses, synapseRoot: H.hex(pst.csr.synapseRoot), weightsDA: "0x" + Buffer.from("gnfd://aigg-brains/lif-dispute.bin").toString("hex") }]) }); }
  check(`LIF MEP registered: ${n} neurons, ${STEPS} steps, stride ${STRIDE}`, await (await H.clientsFor(dep, H.KEYS[0])).meps.read.exists([mepId]));

  // ---- pick a neuron where lying about the input actually changes the state ----
  const challengeBytes = new Uint8Array(32).fill(7);
  await probe.challenge(mep.mepId, challengeBytes, { steps: STEPS, commitStride: STRIDE, stimulusSeed: SEED });
  const S_LIE = 8; const prevStates = await probe.lifStates(mep.mepId, S_LIE - 1);
  let NEURON = -1, inDeg = 0, DELTA = 40;
  for (let i = 1; i < n; i++) {
    const S = L.decodeState(prevStates, i * 16); if (S.refr > 0 || (S.flags & 1)) continue;
    const ps = await probe.lifPartialSums(mep.mepId, S_LIE, i); if (ps.sums.length < 3) continue;
    const last = ps.sums[ps.sums.length - 1];
    let d = 0; for (const cand of [40, 400, 4000, 40000, 400000]) { if (!L.sameState(L.transition(S, last, i, S_LIE, SEED, WUNIT || undefined), L.transition(S, last + BigInt(cand), i, S_LIE, SEED, WUNIT || undefined))) { d = cand; break; } }
    if (!d) continue;
    NEURON = i; inDeg = ps.sums.length; DELTA = d; break;
  }
  check(`found a neuron whose state changes if one input term is inflated (neuron ${NEURON}, in-degree ${inDeg}, delta ${DELTA})`, NEURON > 0);

  // ---- two bonded instances, session keys delegated through the relayer ----
  const R = await H.startRelayer(dep, H.KEYS[3], [mepId]); const d0 = await R.api("/deployment"); const domains = d0.domains;
  const mk = async (walletKey, sessionByte) => {
    const c = H.clientsFor(dep, walletKey); const wallet = E.localWallet(walletKey); const session = keypair("0x" + sessionByte.repeat(32));
    await c.pub.waitForTransactionReceipt({ hash: await c.instances.write.bond([[mepId]], { value: parseEther("0.5") }) });
    const del = await E.makeDelegation(wallet, domains.registry, H.hex(session.address), 100000);
    await R.api("/tx/delegate", { instance: del.instance, session: del.session, expiry: del.expiry, sig: del.sig });
    const nd = new PorwNode(await loadKernelFromBytes(wasm), { privHex: "0x" + sessionByte.repeat(32), domains, delegation: del });
    await nd.loadModel("lif-dispute", payload, lifOpts);
    const rc = new RelayClient([d0.relay], nd.key); await rc.connect(); const results = [];
    const svc = new NodeService(nd, rc, { onResult: async (res) => { results.push(res); res.relayer = await R.api("/tx/result", res); } }); svc.serve(mep.mepId);
    return { c, wallet, session, nd, rc, svc, results, addr: wallet.address.toLowerCase() };
  };
  const A = await mk(H.KEYS[1], "11"), B = await mk(H.KEYS[2], "22");
  check("both executors bonded and delegated", (await A.c.instances.read.weightOf([A.wallet.address])) === 10n && (await B.c.instances.read.weightOf([B.wallet.address])) === 10n);

  // ---- an epoch, honest claims from both, materialized so sortition can pick them ----
  const EPOCH = dep.epochBlocks, REVEAL = 10;
  const toBlock = async (b) => { const cur = await anvil.block(); if (b > cur) await anvil.mine(b - cur); };
  const waitFor = async (p, ms = 25000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await p()) return true; await H.sleep(250); } return false; };
  const enterEpoch = async (e) => { await toBlock(e * EPOCH - 5); await waitFor(async () => (await R.api("/status")).commits.includes(e));
    await toBlock(e * EPOCH + 2); await waitFor(async () => (await R.api("/status")).reveals.includes(e));
    await toBlock(e * EPOCH + REVEAL + 2); return waitFor(async () => (await R.api("/status")).epochsRolled.includes(e)); };
  check("epoch 1 rolled", await enterEpoch(1));
  const ep = await R.api("/epoch?mep=" + mepId);
  for (const X of [A, B]) await X.svc.announce(mep.mepId, H.unhex(ep.challenge));
  check("both residency claims collected", await waitFor(async () => (await R.api("/status")).aggregators[0].epochs.some((x) => x.epoch === 1 && x.claims === 2)));
  check("epoch 2 rolled", await enterEpoch(2));
  check("epoch-1 root posted", await waitFor(async () => (await R.api("/status")).rootsPosted.some((r) => r.epoch === 1 && r.count === 2)));
  const mA = await R.api("/tx/materialize", { mep: mepId, epoch: 1, instance: A.addr }), mB = await R.api("/tx/materialize", { mep: mepId, epoch: 1, instance: B.addr });
  check("both claims materialized, both eligible", mA.ok && mB.ok && (await A.c.instances.read.isEligible([A.wallet.address, mepId, 2n])) && (await A.c.instances.read.isEligible([B.wallet.address, mepId, 2n])));

  // ---- now B starts lying about one neuron's accumulated input, and a task is posted ----
  B.nd.execLie = { step: S_LIE, neuron: NEURON, delta: DELTA, kind: "input" };
  const C = H.clientsFor(dep, H.KEYS[0]); const nonce = "0x" + "31".repeat(32);
  const task = { mepId, stimulusSeed: SEED, steps: STEPS, commitStride: STRIDE, initStateRoot: "0x" + "00".repeat(32), fee: parseEther("0.01"), deadline: BigInt(await anvil.block() + 200), redundancy: 2 };
  await C.pub.waitForTransactionReceipt({ hash: await C.market.write.postTask([task, nonce], { value: parseEther("0.01") }) });
  const taskId = H.taskIdOf(task, nonce);
  const ex = (await C.market.read.executors([taskId])).map((x) => x.toLowerCase());
  check("sortition picked both executors", ex.length === 2 && ex.includes(A.addr) && ex.includes(B.addr));
  const client = new RelayClient([d0.relay], keypair(H.KEYS[0])); await client.connect();
  for (const X of [A, B]) await client.request(H.hex(X.session.address), "task-announce", mepId, { taskId, stimulusSeed: SEED, steps: STEPS, commitStride: STRIDE }, { timeoutMs: 40000, responseType: "result" });
  const bothIn = await waitFor(async () => A.results[0]?.relayer?.ok && B.results[0]?.relayer?.ok);
  console.log(`  A execDigest ${A.results[0]?.execDigest} (relayer ${JSON.stringify(A.results[0]?.relayer)?.slice(0, 80)})`);
  console.log(`  B execDigest ${B.results[0]?.execDigest} (relayer ${JSON.stringify(B.results[0]?.relayer)?.slice(0, 80)})`);
  // both executors ran the same stimulus, so execDigest (the spike-count digest) agrees; B's lie shows up in
  // execRoot, the Merkle root over the per-segment state roots, and settle() compares both.
  check("both results submitted on-chain, and their execRoots disagree", bothIn && A.results[0].execRoot !== B.results[0].execRoot);

  // ---- settle finds the disagreement and opens the dispute instead of paying ----
  const s = await R.api("/tx/settle", { taskId, instance: A.addr });
  const disp = dep.addresses.disputes;
  const DISP_ABI = parseAbi(["function partyA(bytes32) view returns (address)", "function partyB(bytes32) view returns (address)"]);
  const partyA = await C.pub.readContract({ address: disp, abi: DISP_ABI, functionName: "partyA", args: [taskId] }).catch(() => "0x0000000000000000000000000000000000000000");
  check(`settle opened a dispute instead of paying anyone (partyA ${partyA})`, s.ok && partyA !== "0x0000000000000000000000000000000000000000");

  // ---- now play the dispute out, move by move, both sides on-chain (shared with the live testnet run) ----
  const { driveDispute } = await import("./dispute_driver.mjs");
  A.execRoot = A.results[0].execRoot; B.execRoot = B.results[0].execRoot;
  const out = await driveDispute(A, B, { taskId, disputes: disp, mepIdBytes: mep.mepId, n, steps: STEPS, stride: STRIDE, seed: SEED, challengeBytes, sLie: S_LIE, neuron: NEURON, delta: DELTA, chunkSize: pst.csr.chunk, wUnitQ16: WUNIT || undefined },
    { D, V, L, hex: H.hex }, { check, log: (m) => console.log("  " + m) });
  fs.writeFileSync(process.env.PORW_EVIDENCE || "/tmp/dispute-evidence.json", JSON.stringify({ taskId, mepId, neurons: n, steps: STEPS, stride: STRIDE, lie: { step: S_LIE, neuron: NEURON, delta: DELTA, kind: "input" }, ...out, honest: A.addr, liar: B.addr }, null, 1));
  for (const X of [A, B]) X.rc.close(); client.close(); R.stop();
} catch (e) { console.error(e); fails++; } finally { anvil.stop(); }
console.log(fails ? `${fails} FAILURES` : "ALL PASS");
process.exit(fails ? 1 : 0);
