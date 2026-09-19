// A batched task, end to end on a local anvil: one task, several runs of the same brain, posted with
// TaskMarket.postBatch, announced to the sortitioned executors as one "batch-announce", executed by two live nodes,
// submitted through the relayer and settled -- and then the same again with one node lying about ONE neuron at ONE
// step of ONE run. The market notices when it tries to settle; the dispute first bisects the two run-result trees to
// the run (Phase.Run), both sides open it, and from there it is the ordinary dispute, shared with e2e_dispute.mjs,
// down to a single signed synapse term and the liar's bond.
//
// What a batch buys is in the numbers the test prints: the chain's cost for N runs is the cost of one task.
import fs from "node:fs"; import path from "node:path";
import { parseEther } from "viem";
import * as H from "./harness.mjs";
let fails = 0; const check = (n, ok) => { console.log((ok ? "  ok   " : "  FAIL ") + n); if (!ok) fails++; };
const anvil = await H.startAnvil(8565);
try {
  const dep = await H.deploy(anvil.rpc);
  const { synthesizePayloadV2 } = await H.porw("synth.js"); const { PorwNode } = await H.porw("node.js"); const { loadKernelFromBytes } = await H.porw("porw.js");
  const { RelayClient } = await H.porw("relay_client.js"); const { NodeService } = await H.porw("node_service.js"); const { keypair } = await H.porw("claim.js");
  const E = await H.porw("eip712.js"); const V = await H.porw("verify.js"); const D = await H.porw("dispute.js"); const L = await H.porw("lif.js"); const B = await H.porw("batch.js");
  const wasm = fs.readFileSync(path.join(H.porwDir, "sketch.wasm"));
  const STEPS = 20, STRIDE = 5, SEED = 9, NEURONS = 3000, SYNAPSES = 30000, STAR = 3;
  const payload = synthesizePayloadV2("lif-batch", NEURONS, SYNAPSES);

  // ---- the brain, and the runs: seeds, an explicit stimulus set, a silence set; run STAR is the canonical one ----
  const probe = new PorwNode(await loadKernelFromBytes(wasm), { privHex: H.KEYS[4] });
  const pst = await probe.loadModel("lif-batch", payload, { maxSteps: STEPS, exec: "lif" }); const mep = pst.mep, mepId = H.hex(mep.mepId), n = pst.hdr.neurons;
  { const c = H.clientsFor(dep, H.KEYS[0]);
    await c.pub.waitForTransactionReceipt({ hash: await c.meps.write.registerMEP([{ modelId: H.hex(mep.modelId), schemeDigest: H.hex(mep.schemeDigest), execKind: H.hex(mep.execKind), neurons: n, synapses: pst.hdr.synapses, synapseRoot: H.hex(pst.csr.synapseRoot), weightsDA: "0x" + Buffer.from("gnfd://aigg-brains/lif-batch.bin").toString("hex") }]) }); }
  const sets = { ears: Array.from({ length: 250 }, (_, j) => j * 9), quiet: [40, 41, 42, 900, 1500, 2200] };
  const RUNS = [{ stimulusSeed: 3 }, { stimulusSeed: 4 }, { stimulusSeed: 5, silenceSet: "quiet" }, { stimulusSeed: SEED }, { stimulusSeed: 7, stimulusSet: "ears" }, { stimulusSeed: 7, stimulusSet: "ears", silenceSet: "quiet" }];
  const resolved = RUNS.map((r) => ({ stimulusSeed: r.stimulusSeed, stimulusIds: r.stimulusSet ? Uint32Array.from(sets[r.stimulusSet]) : null, silenceIds: r.silenceSet ? Uint32Array.from(sets[r.silenceSet]) : null }));
  const { runsRoot } = await probe.batchRunsRoot(mep.mepId, resolved);

  // ---- a neuron in run STAR where lying about the input changes the state (as in e2e_dispute) ----
  const challengeBytes = new Uint8Array(32).fill(7);
  await probe.challenge(mep.mepId, challengeBytes, { steps: STEPS, commitStride: STRIDE, stimulusSeed: SEED });
  const S_LIE = 8; const prevStates = await probe.lifStates(mep.mepId, S_LIE - 1); let NEURON = -1, DELTA = 40;
  for (let i = 1; i < n && NEURON < 0; i++) { const S = L.decodeState(prevStates, i * 16); if (S.refr > 0 || (S.flags & 1)) continue;
    const ps = await probe.lifPartialSums(mep.mepId, S_LIE, i); if (ps.sums.length < 3) continue; const last = ps.sums[ps.sums.length - 1];
    for (const cand of [40, 400, 4000, 40000, 400000]) if (!L.sameState(L.transition(S, last, i, S_LIE, SEED), L.transition(S, last + BigInt(cand), i, S_LIE, SEED))) { NEURON = i; DELTA = cand; break; } }
  check(`a neuron whose state changes if one input term is inflated (neuron ${NEURON}, delta ${DELTA})`, NEURON > 0);

  // ---- two bonded instances behind the relayer, eligible from epoch 2 ----
  const R = await H.startRelayer(dep, H.KEYS[3], [mepId]); const d0 = await R.api("/deployment"); const domains = d0.domains;
  const mk = async (walletKey, sessionByte) => {
    const c = H.clientsFor(dep, walletKey); const wallet = E.localWallet(walletKey); const session = keypair("0x" + sessionByte.repeat(32));
    await c.pub.waitForTransactionReceipt({ hash: await c.instances.write.bond([[mepId]], { value: parseEther("0.5") }) });
    const del = await E.makeDelegation(wallet, domains.registry, H.hex(session.address), 100000); await R.api("/tx/delegate", { instance: del.instance, session: del.session, expiry: del.expiry, sig: del.sig });
    const nd = new PorwNode(await loadKernelFromBytes(wasm), { privHex: "0x" + sessionByte.repeat(32), domains, delegation: del }); await nd.loadModel("lif-batch", payload, { maxSteps: STEPS, exec: "lif" });
    const rc = new RelayClient([d0.relay], nd.key); await rc.connect(); const results = [];
    const svc = new NodeService(nd, rc, { onResult: async (res) => { results.push(res); res.relayer = await R.api("/tx/result", res); } }); svc.serve(mep.mepId);
    return { c, wallet, session, nd, rc, svc, results, addr: wallet.address.toLowerCase() };
  };
  const A = await mk(H.KEYS[1], "11"), Bn = await mk(H.KEYS[2], "22");
  const EPOCH = dep.epochBlocks; const toBlock = async (b) => { const cur = await anvil.block(); if (b > cur) await anvil.mine(b - cur); };
  const waitFor = async (p, ms = 25000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await p()) return true; await H.sleep(250); } return false; };
  const enterEpoch = async (e) => { await toBlock(e * EPOCH - 5); await waitFor(async () => (await R.api("/status")).commits.includes(e)); await toBlock(e * EPOCH + 2); await waitFor(async () => (await R.api("/status")).reveals.includes(e)); await toBlock(e * EPOCH + 12); return waitFor(async () => (await R.api("/status")).epochsRolled.includes(e)); };
  check("epoch 1 rolled", await enterEpoch(1)); const ep = await R.api("/epoch?mep=" + mepId); for (const X of [A, Bn]) await X.svc.announce(mep.mepId, H.unhex(ep.challenge));
  check("epoch 2 rolled, the epoch-1 root posted", (await enterEpoch(2)) && await waitFor(async () => (await R.api("/status")).rootsPosted.some((r) => r.epoch === 1 && r.count === 2)));
  const mA = await R.api("/tx/materialize", { mep: mepId, epoch: 1, instance: A.addr }), mB = await R.api("/tx/materialize", { mep: mepId, epoch: 1, instance: Bn.addr }); check("both eligible", mA.ok && mB.ok);

  // ---- post, announce, collect: shared by the honest batch and the disputed one ----
  const C = H.clientsFor(dep, H.KEYS[0]); const client = new RelayClient([d0.relay], keypair(H.KEYS[0])); await client.connect();
  const runBatch = async (nonce) => {
    const task = { mepId, stimulusSeed: 0, steps: STEPS, commitStride: STRIDE, initStateRoot: H.hex(runsRoot), fee: parseEther("0.01"), deadline: BigInt(await anvil.block() + 400), redundancy: 2 };
    const rcpt = await C.pub.waitForTransactionReceipt({ hash: await C.market.write.postBatch([task, RUNS.length, nonce], { value: task.fee }) }); const taskId = H.batchIdOf(task, RUNS.length, nonce);
    check(`postBatch: ${RUNS.length} runs, ${rcpt.gasUsed} gas, the id covers the run count`, rcpt.status === "success" && Number(await C.market.read.batchRuns([taskId])) === RUNS.length);
    const ex = (await C.market.read.executors([taskId])).map((x) => x.toLowerCase()); check("sortition picked both executors", ex.length === 2 && ex.includes(A.addr) && ex.includes(Bn.addr));
    const i0 = A.results.length, replies = [];
    for (const X of [A, Bn]) replies.push((await client.request(H.hex(X.session.address), "batch-announce", mepId, { taskId, steps: STEPS, commitStride: STRIDE, initStateRoot: H.hex(runsRoot), sets, runs: RUNS }, { timeoutMs: 120000, responseType: "result" })).payload);
    check("both results submitted on-chain through the relayer", await waitFor(async () => A.results[i0]?.relayer?.ok && Bn.results[i0]?.relayer?.ok));
    return { task, taskId, replies, gas: Number(rcpt.gasUsed) + A.results[i0].relayer.gasUsed + Bn.results[i0].relayer.gasUsed, a: A.results[i0], b: Bn.results[i0] };
  };

  // ---- 1. the honest batch ----
  const one = await runBatch("0x" + "41".repeat(32)); const balA = await C.pub.getBalance({ address: A.wallet.address });
  check("the two executors signed the same batch", one.a.execRoot === one.b.execRoot && one.a.execDigest === H.hex(B.batchDigest(H.unhex(one.a.execRoot))));
  const s1 = await R.api("/tx/settle", { taskId: one.taskId, instance: A.addr }); check("settled; the fee is for the batch, split between them", s1.ok && (await C.pub.getBalance({ address: A.wallet.address })) === balA + parseEther("0.005"));
  console.log(`  chain cost of the batch: ${one.gas + s1.gasUsed} gas for ${RUNS.length} runs = ${Math.round((one.gas + s1.gasUsed) / RUNS.length)} per run (a single task costs the same total)`);
  // what a client does with a settled batch: the rows are the per-run roots in the reply; they must hash to the settled
  // root, and any one of them can be re-executed and checked on its own
  const settledRoot = (await C.market.read.resultOf([one.taskId, A.wallet.address]))[1]; const rows = one.replies[0].runs;
  check("the reply's per-run roots are the settled batch", H.hex(V.merkleRoot(rows.map((r, k) => B.runResultLeaf(k, H.unhex(r.execRoot))))) === settledRoot);
  { const k = 5, re = await probe.execute(mep.mepId, { steps: STEPS, commitStride: STRIDE, ...resolved[k] });
    check(`a client re-executes run ${k} (stimulus set + silence set) and gets the row that was settled`, H.hex(re.result.execRoot) === rows[k].execRoot && H.hex(re.result.execDigest) === rows[k].countsDigest && B.verifyRunResult(H.unhex(settledRoot), RUNS.length, k, re.result.execRoot, V.merkleProof(rows.map((r, j) => B.runResultLeaf(j, H.unhex(r.execRoot))), k))); }

  // ---- 2. the same batch again, and this time B lies in run STAR ----
  Bn.nd.batchLie = { run: STAR, lie: { step: S_LIE, neuron: NEURON, delta: DELTA, kind: "input" } };
  const two = await runBatch("0x" + "42".repeat(32));
  check(`B's batch differs from A's, and only in run ${STAR}`, two.a.execRoot !== two.b.execRoot && two.replies[0].runs.every((r, k) => (r.execRoot === two.replies[1].runs[k].execRoot) === (k !== STAR)));
  const s2 = await R.api("/tx/settle", { taskId: two.taskId, instance: A.addr }); const disp = dep.addresses.disputes;
  const { driveBatchRun, driveDispute, DISPUTES_ABI } = await import("./dispute_driver.mjs");
  const partyA = await C.pub.readContract({ address: disp, abi: DISPUTES_ABI, functionName: "partyA", args: [two.taskId] }).catch(() => null);
  check("settle opened a dispute instead of paying anyone", s2.ok && partyA && partyA !== "0x0000000000000000000000000000000000000000");
  A.execRoot = two.a.execRoot; Bn.execRoot = two.b.execRoot; const mod = { D, V, L, hex: H.hex }, hooks = { check, log: (m) => console.log("  " + m) };
  const found = await driveBatchRun(A, Bn, { taskId: two.taskId, disputes: disp, mepIdBytes: mep.mepId, steps: STEPS, stride: STRIDE, runs: resolved }, mod, hooks);
  check(`the chain found run ${STAR}`, found.run === STAR && found.seed === SEED);
  const out = await driveDispute(A, Bn, { taskId: two.taskId, disputes: disp, mepIdBytes: mep.mepId, n, steps: STEPS, stride: STRIDE, seed: SEED, challengeBytes, sLie: S_LIE, neuron: NEURON, delta: DELTA, chunkSize: pst.csr.chunk, replayed: found.replayed }, mod, hooks);
  check("and convicted the liar of one term of one step of that run", BigInt(out.slashed) > 0n);
  fs.writeFileSync(process.env.PORW_EVIDENCE || "/tmp/batch-evidence.json", JSON.stringify({ mepId, runs: RUNS.length, honest: { taskId: one.taskId, gas: one.gas + s1.gasUsed }, disputed: { taskId: two.taskId, run: found.run, runPhase: found.gas, ...out } }, null, 1));
  for (const X of [A, Bn]) X.rc.close(); client.close(); R.stop();
} catch (e) { console.error(e); fails++; } finally { anvil.stop(); }
console.log(fails ? `${fails} FAILURES` : "ALL PASS"); process.exit(fails ? 1 : 0);
