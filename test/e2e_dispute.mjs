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
  const payload = synthesizePayloadV2("lif-dispute", NEURONS, SYNAPSES);

  // ---- register the LIF MEP ----
  const probe = new PorwNode(await loadKernelFromBytes(wasm), { privHex: H.KEYS[4] });
  const pst = await probe.loadModel("lif-dispute", payload, { steps: STEPS, exec: "lif", commitStride: STRIDE });
  const mep = pst.mep, mepId = H.hex(mep.mepId); const n = pst.hdr.neurons;
  { const c = H.clientsFor(dep, H.KEYS[0]);
    await c.pub.waitForTransactionReceipt({ hash: await c.meps.write.registerMEP([{ modelId: H.hex(mep.modelId), schemeDigest: H.hex(mep.schemeDigest), execKind: H.hex(mep.execKind), steps: mep.steps, clampQ16: mep.clampQ16, neurons: pst.hdr.neurons, synapses: pst.hdr.synapses, synapseRoot: H.hex(pst.csr.synapseRoot), weightsDA: "0x" + Buffer.from("gnfd://aigg-brains/lif-dispute.bin").toString("hex") }]) }); }
  check(`LIF MEP registered: ${n} neurons, ${STEPS} steps, stride ${STRIDE}`, await (await H.clientsFor(dep, H.KEYS[0])).meps.read.exists([mepId]));

  // ---- pick a neuron where lying about the input actually changes the state ----
  const challengeBytes = new Uint8Array(32).fill(7);
  await probe.challenge(mep.mepId, challengeBytes, { stimulusSeed: SEED });
  const S_LIE = 8; const prevStates = await probe.lifStates(mep.mepId, S_LIE - 1);
  let NEURON = -1, inDeg = 0, DELTA = 40;
  for (let i = 1; i < n; i++) {
    const S = L.decodeState(prevStates, i * 16); if (S.refr > 0 || (S.flags & 1)) continue;
    const ps = await probe.lifPartialSums(mep.mepId, S_LIE, i); if (ps.sums.length < 3) continue;
    const last = ps.sums[ps.sums.length - 1];
    let d = 0; for (const cand of [40, 400, 4000, 40000, 400000]) { if (!L.sameState(L.transition(S, last, i, S_LIE, SEED), L.transition(S, last + BigInt(cand), i, S_LIE, SEED))) { d = cand; break; } }
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
    await nd.loadModel("lif-dispute", payload, { steps: STEPS, exec: "lif", commitStride: STRIDE });
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
  for (const X of [A, B]) await X.svc.announce(mep.mepId, H.unhex(ep.challenge), { stimulusSeed: 1 });
  check("both residency claims collected", await waitFor(async () => (await R.api("/status")).aggregators[0].epochs.some((x) => x.epoch === 1 && x.claims === 2)));
  check("epoch 2 rolled", await enterEpoch(2));
  check("epoch-1 root posted", await waitFor(async () => (await R.api("/status")).rootsPosted.some((r) => r.epoch === 1 && r.count === 2)));
  const mA = await R.api("/tx/materialize", { mep: mepId, epoch: 1, instance: A.addr }), mB = await R.api("/tx/materialize", { mep: mepId, epoch: 1, instance: B.addr });
  check("both claims materialized, both eligible", mA.ok && mB.ok && (await A.c.instances.read.isEligible([A.wallet.address, mepId, 2n])) && (await A.c.instances.read.isEligible([B.wallet.address, mepId, 2n])));

  // ---- now B starts lying about one neuron's accumulated input, and a task is posted ----
  B.nd.execLie = { step: S_LIE, neuron: NEURON, delta: DELTA, kind: "input" };
  const C = H.clientsFor(dep, H.KEYS[0]); const nonce = "0x" + "31".repeat(32);
  await C.pub.waitForTransactionReceipt({ hash: await C.market.write.postTask([{ mepId, stimulusSeed: SEED, inputCommit: "0x" + "00".repeat(32), fee: parseEther("0.01"), deadline: BigInt(await anvil.block() + 200), redundancy: 2 }, nonce], { value: parseEther("0.01") }) });
  const taskId = keccak256(encodePacked(["bytes32", "uint32", "bytes32"], [mepId, SEED, nonce]));
  const ex = (await C.market.read.executors([taskId])).map((x) => x.toLowerCase());
  check("sortition picked both executors", ex.length === 2 && ex.includes(A.addr) && ex.includes(B.addr));
  const client = new RelayClient([d0.relay], keypair(H.KEYS[0])); await client.connect();
  for (const X of [A, B]) await client.request(H.hex(X.session.address), "task-announce", mepId, { taskId, stimulusSeed: SEED }, { timeoutMs: 40000, responseType: "result" });
  const bothIn = await waitFor(async () => A.results[0]?.relayer?.ok && B.results[0]?.relayer?.ok);
  console.log(`  A execDigest ${A.results[0]?.execDigest} (relayer ${JSON.stringify(A.results[0]?.relayer)?.slice(0, 80)})`);
  console.log(`  B execDigest ${B.results[0]?.execDigest} (relayer ${JSON.stringify(B.results[0]?.relayer)?.slice(0, 80)})`);
  // execDigest is the canonical residency digest and is the same for both; the task run shows up in execRoot,
  // the Merkle root over the per-segment state roots, and settle() compares both.
  check("both results submitted on-chain, and their execRoots disagree", bothIn && A.results[0].execRoot !== B.results[0].execRoot);

  // ---- settle finds the disagreement and opens the dispute instead of paying ----
  const s = await R.api("/tx/settle", { taskId, instance: A.addr });
  const disp = dep.addresses.disputes;
  const DISP_ABI = parseAbi(["function partyA(bytes32) view returns (address)", "function partyB(bytes32) view returns (address)"]);
  const partyA = await C.pub.readContract({ address: disp, abi: DISP_ABI, functionName: "partyA", args: [taskId] }).catch(() => "0x0000000000000000000000000000000000000000");
  check(`settle opened a dispute instead of paying anyone (partyA ${partyA})`, s.ok && partyA !== "0x0000000000000000000000000000000000000000");

  // ---- now play the dispute out, move by move, both sides on-chain ----
  const DA = parseAbi([
    "function revealRoots(bytes32 taskId, bytes32[] actRoots)",
    "function postStepRoots(bytes32 taskId, bytes32[] roots)",
    "function postChildren(bytes32 taskId, bytes32 left, bytes32 right)",
    "function postRowLif(bytes32 taskId, int32 v, int32 g, uint16 refr, uint16 flags, uint32 count, int64[] sums)",
    "function proveSynapseTermLif(bytes32 taskId, (uint32,bytes32,bytes32,(uint32,bytes32[],uint32,bytes32[]),(uint32,bytes,bytes32[]),(int32,int32,uint16,uint16,uint32,bytes32[]),(int32,int32,uint16,uint16,uint32,bytes32[])) pf)",
  ]);
  const send = async (X, fn, args) => { const h = await X.c.wallet.writeContract({ address: disp, abi: DA, functionName: fn, args }); const r = await X.c.pub.waitForTransactionReceipt({ hash: h }); if (r.status !== "success") throw new Error(fn + " reverted"); return Number(r.gasUsed); };
  let gas = {};
  // the two runs, replayed locally so each side has its own commitments to post
  const rA = await A.nd.challenge(mep.mepId, challengeBytes, { stimulusSeed: SEED });
  const rB = await B.nd.challenge(mep.mepId, challengeBytes, { stimulusSeed: SEED });
  check("the local replays reproduce exactly what each side signed on-chain", H.hex(rA.result.execRoot) === A.results[0].execRoot && H.hex(rB.result.execRoot) === B.results[0].execRoot);

  gas.reveal = await send(A, "revealRoots", [taskId, rA.result.actRoots.map(H.hex)]);
  await send(B, "revealRoots", [taskId, rB.result.actRoots.map(H.hex)]);
  const segStar = D.firstDifferingStep(rA.result.actRoots, rB.result.actRoots) - 1;
  check(`segment ${segStar} is the first the two disagree on (the lie is at step ${S_LIE}, stride ${STRIDE})`, segStar === Math.floor((S_LIE - 1) / STRIDE));

  const segA = await A.nd.lifSegmentRoots(mep.mepId, segStar), segB = await B.nd.lifSegmentRoots(mep.mepId, segStar);
  gas.stepRoots = await send(A, "postStepRoots", [taskId, segA.roots.map(H.hex)]);
  await send(B, "postStepRoots", [taskId, segB.roots.map(H.hex)]);
  const ref = D.refineSegment({ seg: segStar, stride: STRIDE, steps: STEPS, prevAgreed: rA.result.actRoots[segStar - 1], segRootA: rA.result.actRoots[segStar], segRootB: rB.result.actRoots[segStar], rootsA: segA.roots, rootsB: segB.roots });
  check(`refining the segment lands on step ${S_LIE} (got ${ref.step})`, ref.step === S_LIE);

  // binary search down the state tree until one neuron is left
  const widths = (m) => { const w = [m]; while (w[w.length - 1] > 1) w.push((w[w.length - 1] + 1) >> 1); return w; };
  const w = widths(n); let level = w.length - 1, idx = 0, rounds = 0;
  while (level > 0) {
    const l = 2 * idx, r = 2 * idx + 1, cw = w[level - 1];
    const a = [await A.nd.lifNode(mep.mepId, S_LIE, level - 1, l), r < cw ? await A.nd.lifNode(mep.mepId, S_LIE, level - 1, r) : await A.nd.lifNode(mep.mepId, S_LIE, level - 1, l)];
    const b = [await B.nd.lifNode(mep.mepId, S_LIE, level - 1, l), r < cw ? await B.nd.lifNode(mep.mepId, S_LIE, level - 1, r) : await B.nd.lifNode(mep.mepId, S_LIE, level - 1, l)];
    const g = await send(A, "postChildren", [taskId, H.hex(a[0]), H.hex(a[1])]); if (!rounds) gas.children = g;
    await send(B, "postChildren", [taskId, H.hex(b[0]), H.hex(b[1])]);
    idx = !V.eq(a[0], b[0]) ? l : (r < cw ? r : l); level--; rounds++;
  }
  check(`the bisection walked ${rounds} rounds down to neuron ${idx}, which is the one that was lied about`, idx === NEURON);

  // the neuron's row: each side posts its claimed state and its CSR-ordered partial sums
  const psA = await A.nd.lifPartialSums(mep.mepId, S_LIE, NEURON), psB = await B.nd.lifPartialSums(mep.mepId, S_LIE, NEURON);
  const stA = (await A.nd.lifOpenState(mep.mepId, S_LIE, NEURON)).state, stB = (await B.nd.lifOpenState(mep.mepId, S_LIE, NEURON)).state;
  // Two kinds of liar. A naive one posts its real partial sums, which do not add up to the state it claimed, and
  // loses right here at the row check. A competent one forges sums that DO transition to its claimed state --
  // the only way to survive the row check -- and that is what forces the dispute down to a single synapse term.
  // B is the competent one: it inflates the tail of the row by exactly the amount it lied about, so the last
  // partial sum matches the input it pretended to receive, and the first forged term is where it will be caught.
  const len = psA.sums.length, jStar = len >> 1;
  const lied = Array.from(psA.sums); for (let j = jStar; j < len; j++) lied[j] += BigInt(DELTA);
  check("the liar's forged row transitions to exactly the state it claimed (so the row check cannot catch it)", L.sameState(L.transition((await A.nd.lifOpenState(mep.mepId, S_LIE - 1, NEURON)).state, lied[len - 1], NEURON, S_LIE, SEED), stB));
  const row = (X, st, sums) => send(X, "postRowLif", [taskId, st.v, st.g, st.refr, st.flags, st.count, sums]);
  gas.row = await row(A, stA, Array.from(psA.sums)); await row(B, stB, lied);
  check(`the two rows agree for ${jStar} terms and first differ at term ${jStar} of ${len}`, D.firstDivergentTerm(psA.sums, lied) === jStar);

  // one synapse term decides it
  const kStar = psA.k0 + jStar;
  const chunk = A.nd.openCsrChunk(mep.mepId, Math.floor(kStar / pst.csr.chunk));
  const rec = L.recordSigned(chunk.records.subarray((kStar - chunk.k0) * 10, (kStar - chunk.k0) * 10 + 10));
  check(`the term's synapse record targets the disputed neuron (post ${rec.post})`, rec.post === NEURON);
  const rowStart = A.nd.openRowStart(mep.mepId, NEURON), rowEnd = A.nd.openRowStart(mep.mepId, NEURON + 1);
  const self = await A.nd.lifOpenState(mep.mepId, S_LIE - 1, NEURON), pre = await A.nd.lifOpenState(mep.mepId, S_LIE - 1, rec.pre);
  const SO = (o) => [o.state.v, o.state.g, o.state.refr, o.state.flags, o.state.count, o.proof.map(H.hex)];
  const proof = [kStar, H.hex(rA.result.csrRoot), H.hex(rA.result.rowRoot),
    [rowStart.value, rowStart.proof.map(H.hex), rowEnd.value, rowEnd.proof.map(H.hex)],
    [chunk.c, H.hex(chunk.records), chunk.proof.map(H.hex)], SO(self), SO(pre)];
  const bondB0 = await A.c.instances.read.bonded([B.wallet.address]), bondA0 = await A.c.instances.read.bonded([A.wallet.address]);
  gas.term = await send(A, "proveSynapseTermLif", [taskId, proof]);
  const bondB1 = await A.c.instances.read.bonded([B.wallet.address]), bondA1 = await A.c.instances.read.bonded([A.wallet.address]);
  check(`the liar's bond was slashed on-chain (${Number(bondB0 - bondB1) / 1e18} BNB taken)`, bondB1 < bondB0);
  check("the honest executor's own bond was untouched", bondA1 === bondA0);
  console.log(`  gas: revealRoots ${gas.reveal}, postStepRoots ${gas.stepRoots}, postChildren ${gas.children}/round x ${rounds} rounds x2, postRowLif ${gas.row}, proveSynapseTermLif ${gas.term}`);
  const evidence = { taskId, mepId, neurons: n, steps: STEPS, stride: STRIDE, lie: { step: S_LIE, neuron: NEURON, delta: DELTA, kind: "input", inDegree: inDeg }, segStar, rounds, jStar, kStar, preNeuron: rec.pre, gas, slashed: (bondB0 - bondB1).toString(), honest: A.addr, liar: B.addr };
  fs.writeFileSync(process.env.PORW_EVIDENCE || "/tmp/dispute-evidence.json", JSON.stringify(evidence, null, 1));
  for (const X of [A, B]) X.rc.close(); client.close(); R.stop();
} catch (e) { console.error(e); fails++; } finally { anvil.stop(); }
console.log(fails ? `${fails} FAILURES` : "ALL PASS");
process.exit(fails ? 1 : 0);
