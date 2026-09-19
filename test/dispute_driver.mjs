// Plays an execution dispute out on-chain, move by move, from both sides. Shared by the anvil end-to-end test and
// the live testnet run so the part that is hard to get right is written once and proven once: the local replays
// must reproduce exactly what each side signed, the segment and step refinement must land on the step that was
// lied about, the binary search must walk to the neuron that was touched, and the openings must verify against
// roots the nodes produced rather than roots a fixture generator produced.
//
// Two kinds of liar. A naive one posts its real partial sums, which do not transition to the state it claimed,
// and loses at the row check. A competent one forges sums that DO add up to its claimed state -- the only way
// past the row check -- and that is what forces the dispute down to a single synapse term. `forgeRow` picks which
// one is being played; the interesting case is the competent liar.
import { parseAbi } from "viem";

export const DISPUTES_ABI = parseAbi([
  "function partyA(bytes32) view returns (address)",
  "function partyB(bytes32) view returns (address)",
  "function revealRoots(bytes32 taskId, bytes32[] actRoots)",
  "function postStepRoots(bytes32 taskId, bytes32[] roots)",
  "function postChildren(bytes32 taskId, bytes32 left, bytes32 right)",
  "function openRun(bytes32 taskId, bytes32 runExecRoot, uint32 seed, bytes32 initStateRoot, bytes32[] inputProof)",
  "function batches(bytes32) view returns (uint32 runs, uint32 level, uint32 idx)",
  "function postRowLif(bytes32 taskId, int32 v, int32 g, uint16 refr, uint16 flags, uint32 count, int64[] sums)",
  "function proveSynapseTermLif(bytes32 taskId, (uint32,bytes32,bytes32,(uint32,bytes32[],uint32,bytes32[]),(uint32,bytes,bytes32[]),(int32,int32,uint16,uint16,uint32,bytes32[]),(int32,int32,uint16,uint16,uint32,bytes32[])) pf)",
]);

/**
 * The part of a BATCH dispute that comes before the ordinary one: both sides re-execute the batch, bisect their
 * run-result trees on-chain to the first run they differ on (`postChildren`, Phase.Run), and open that run
 * (`openRun`: the run's own execRoot, and its input against the task's runs root). Returns what `driveDispute`
 * needs to carry on as that run's dispute: `{ run, replayed: { rA, rB } }`, with A.execRoot / B.execRoot set to the
 * run's roots, which is what each side is now on the hook for.
 * @param opts { taskId, disputes, mepIdBytes, steps, stride, runs }  -- `runs` as announced to the executors
 */
export async function driveBatchRun(A, B, opts, mod, hooks) {
  const { taskId, disputes, mepIdBytes, steps, stride, runs } = opts; const { V, hex } = mod; const { check, log } = hooks; const gas = { children: 0 };
  const send = async (X, fn, args) => { const h = await X.c.wallet.writeContract({ address: disputes, abi: DISPUTES_ABI, functionName: fn, args }); const r = await X.c.pub.waitForTransactionReceipt({ hash: h }); if (r.status !== "success") throw new Error(`${fn} reverted (${h})`); return Number(r.gasUsed); };
  const at = async () => { const [n, level, idx] = await A.c.pub.readContract({ address: disputes, abi: DISPUTES_ABI, functionName: "batches", args: [taskId] }); return { n: Number(n), level: Number(level), idx: Number(idx) }; };
  const bA = await A.nd.executeBatch(mepIdBytes, { steps, commitStride: stride, runs }), bB = await B.nd.executeBatch(mepIdBytes, { steps, commitStride: stride, runs });
  check("the local replays of the BATCH reproduce exactly what each side signed on-chain", hex(bA.result.execRoot) === A.execRoot && hex(bB.result.execRoot) === B.execRoot);
  let p = await at(); check(`the dispute opened in the Run phase, at the top of a tree over ${p.n} runs`, p.n === runs.length && p.idx === 0 && p.level === widths(runs.length).length - 1);
  let rounds = 0;
  while (p.level > 0) { const a = A.nd.batchNode(mepIdBytes, p.level, p.idx), b = B.nd.batchNode(mepIdBytes, p.level, p.idx);
    gas.children += await send(A, "postChildren", [taskId, hex(a[0]), hex(a[1])]); await send(B, "postChildren", [taskId, hex(b[0]), hex(b[1])]); rounds++; p = await at(); }
  const expected = bA.runs.findIndex((r, k) => hex(r.execRoot) !== hex(bB.runs[k].execRoot));
  check(`the run bisection walked ${rounds} rounds on-chain to run ${p.idx}, the first the two differ on`, p.idx === expected && expected >= 0);
  const oA = await A.nd.batchOpenRun(mepIdBytes, p.idx), oB = await B.nd.batchOpenRun(mepIdBytes, p.idx);
  const open = (X, o) => send(X, "openRun", [taskId, hex(o.execRoot), o.seed, hex(o.initStateRoot), o.inputProof.map(hex)]);
  gas.openRun = await open(A, oA); await open(B, oB);
  check("both opened the same input and different results", hex(oA.initStateRoot) === hex(oB.initStateRoot) && oA.seed === oB.seed && hex(oA.execRoot) !== hex(oB.execRoot));
  log(`run ${p.idx} of ${runs.length} opened; postChildren ${Math.round(gas.children / rounds)} gas/round x ${rounds}, openRun ${gas.openRun} gas`);
  A.execRoot = hex(oA.execRoot); B.execRoot = hex(oB.execRoot); // from here each side answers for the run's root
  return { run: p.idx, rounds, gas, seed: oA.seed, replayed: { rA: { result: oA.result }, rB: { result: oB.result } } };
}

const widths = (m) => { const w = [m]; while (w[w.length - 1] > 1) w.push((w[w.length - 1] + 1) >> 1); return w; };

/**
 * @param A,B         { c: viem clients, nd: PorwNode, addr } -- A honest, B the liar
 * @param opts        { taskId, mepId, mepIdBytes, disputes, n, steps, stride, seed, challengeBytes, sLie, neuron, delta, forgeRow }
 * @param dep         { D: dispute.js, V: verify.js, L: lif.js, hex }
 * @param hooks       { check(name, ok), log(msg) }
 */
export async function driveDispute(A, B, opts, mod, hooks) {
  const { taskId, disputes, mepIdBytes, n, steps, stride, seed, challengeBytes, sLie, neuron, delta, chunkSize, forgeRow = true, wUnitQ16 = undefined } = opts; // wUnitQ16: the MEP's kind's weight unit (default: FlyWire's)
  const { D, V, L, hex } = mod; const { check, log } = hooks;
  const gas = {};
  const send = async (X, fn, args) => {
    const h = await X.c.wallet.writeContract({ address: disputes, abi: DISPUTES_ABI, functionName: fn, args });
    const r = await X.c.pub.waitForTransactionReceipt({ hash: h });
    if (r.status !== "success") throw new Error(`${fn} reverted (${h})`);
    return Number(r.gasUsed);
  };

  // each side replays its own run locally so it has its own commitments to post -- unless the run was just reopened
  // out of a batch (driveBatchRun), in which case the nodes already hold it and `replayed` carries its results
  const rA = opts.replayed ? opts.replayed.rA : await A.nd.challenge(mepIdBytes, challengeBytes, { steps, commitStride: stride, stimulusSeed: seed });
  const rB = opts.replayed ? opts.replayed.rB : await B.nd.challenge(mepIdBytes, challengeBytes, { steps, commitStride: stride, stimulusSeed: seed });
  check("the local replays reproduce exactly what each side signed on-chain", hex(rA.result.execRoot) === A.execRoot && hex(rB.result.execRoot) === B.execRoot);

  gas.reveal = await send(A, "revealRoots", [taskId, rA.result.actRoots.map(hex)]);
  await send(B, "revealRoots", [taskId, rB.result.actRoots.map(hex)]);
  const segStar = D.firstDifferingStep(rA.result.actRoots, rB.result.actRoots) - 1;
  check(`segment ${segStar} is the first the two disagree on (the lie is at step ${sLie}, stride ${stride})`, segStar === Math.floor((sLie - 1) / stride));
  log(`segment ${segStar} disputed; revealRoots ${gas.reveal} gas`);

  const segA = await A.nd.lifSegmentRoots(mepIdBytes, segStar), segB = await B.nd.lifSegmentRoots(mepIdBytes, segStar);
  gas.stepRoots = await send(A, "postStepRoots", [taskId, segA.roots.map(hex)]);
  await send(B, "postStepRoots", [taskId, segB.roots.map(hex)]);
  const ref = D.refineSegment({ seg: segStar, stride, steps, prevAgreed: rA.result.actRoots[segStar - 1], segRootA: rA.result.actRoots[segStar], segRootB: rB.result.actRoots[segStar], rootsA: segA.roots, rootsB: segB.roots });
  check(`refining the segment lands on step ${sLie} (got ${ref.step})`, ref.step === sLie);
  log(`refined to step ${ref.step}; postStepRoots ${gas.stepRoots} gas`);

  // binary search down the state tree until one neuron is left
  const w = widths(n); let level = w.length - 1, idx = 0, rounds = 0;
  while (level > 0) {
    const l = 2 * idx, r = 2 * idx + 1, cw = w[level - 1];
    const a = [await A.nd.lifNode(mepIdBytes, sLie, level - 1, l), r < cw ? await A.nd.lifNode(mepIdBytes, sLie, level - 1, r) : await A.nd.lifNode(mepIdBytes, sLie, level - 1, l)];
    const b = [await B.nd.lifNode(mepIdBytes, sLie, level - 1, l), r < cw ? await B.nd.lifNode(mepIdBytes, sLie, level - 1, r) : await B.nd.lifNode(mepIdBytes, sLie, level - 1, l)];
    const g = await send(A, "postChildren", [taskId, hex(a[0]), hex(a[1])]); if (!rounds) gas.children = g;
    await send(B, "postChildren", [taskId, hex(b[0]), hex(b[1])]);
    idx = !V.eq(a[0], b[0]) ? l : (r < cw ? r : l); level--; rounds++;
    if (rounds % 4 === 0) log(`  bisection round ${rounds}: down to ${w[level]} candidate${w[level] === 1 ? "" : "s"}`);
  }
  check(`the bisection walked ${rounds} rounds down to neuron ${idx}, which is the one that was lied about`, idx === neuron);

  // the neuron's row
  const psA = await A.nd.lifPartialSums(mepIdBytes, sLie, neuron);
  const stA = (await A.nd.lifOpenState(mepIdBytes, sLie, neuron)).state, stB = (await B.nd.lifOpenState(mepIdBytes, sLie, neuron)).state;
  const prevSelf = await A.nd.lifOpenState(mepIdBytes, sLie - 1, neuron);
  const len = psA.sums.length, jStar = len >> 1;
  let bSums;
  if (forgeRow) { bSums = Array.from(psA.sums); for (let j = jStar; j < len; j++) bSums[j] += BigInt(delta);
    check("the liar's forged row transitions to exactly the state it claimed (so the row check cannot catch it)", L.sameState(L.transition(prevSelf.state, bSums[len - 1], neuron, sLie, seed, wUnitQ16), stB)); }
  else bSums = Array.from((await B.nd.lifPartialSums(mepIdBytes, sLie, neuron)).sums);
  const row = (X, st, sums) => send(X, "postRowLif", [taskId, st.v, st.g, st.refr, st.flags, st.count, sums]);
  gas.row = await row(A, stA, Array.from(psA.sums)); await row(B, stB, bSums);
  const j = D.firstDivergentTerm(psA.sums, bSums);
  check(`the two rows agree for ${j} terms and first differ at term ${j} of ${len}`, j === (forgeRow ? jStar : j) && j >= 0);
  log(`row posted (in-degree ${len}); postRowLif ${gas.row} gas`);

  // one synapse term decides it
  const kStar = psA.k0 + j;
  const chunk = A.nd.openCsrChunk(mepIdBytes, Math.floor(kStar / chunkSize));
  const rec = L.recordSigned(chunk.records.subarray((kStar - chunk.k0) * 10, (kStar - chunk.k0) * 10 + 10));
  check(`the term's synapse record targets the disputed neuron (post ${rec.post})`, rec.post === neuron);
  const rowStart = A.nd.openRowStart(mepIdBytes, neuron), rowEnd = A.nd.openRowStart(mepIdBytes, neuron + 1);
  const pre = await A.nd.lifOpenState(mepIdBytes, sLie - 1, rec.pre);
  const SO = (o) => [o.state.v, o.state.g, o.state.refr, o.state.flags, o.state.count, o.proof.map(hex)];
  const proof = [kStar, hex(rA.result.csrRoot), hex(rA.result.rowRoot),
    [rowStart.value, rowStart.proof.map(hex), rowEnd.value, rowEnd.proof.map(hex)],
    [chunk.c, hex(chunk.records), chunk.proof.map(hex)], SO(prevSelf), SO(pre)];
  const bondB0 = await A.c.instances.read.bonded([B.wallet.address]), bondA0 = await A.c.instances.read.bonded([A.wallet.address]);
  gas.term = await send(A, "proveSynapseTermLif", [taskId, proof]);
  const bondB1 = await A.c.instances.read.bonded([B.wallet.address]), bondA1 = await A.c.instances.read.bonded([A.wallet.address]);
  check(`the liar's bond was slashed on-chain (${Number(bondB0 - bondB1) / 1e18} BNB taken)`, bondB1 < bondB0);
  check("the honest executor's own bond was untouched", bondA1 === bondA0);
  log(`gas: revealRoots ${gas.reveal}, postStepRoots ${gas.stepRoots}, postChildren ${gas.children}/round x ${rounds} x2, postRowLif ${gas.row}, proveSynapseTermLif ${gas.term}`);
  return { segStar, rounds, jStar: j, kStar, preNeuron: rec.pre, gas, slashed: (bondB0 - bondB1).toString(), inDegree: len };
}
