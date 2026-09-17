// End to end on a local anvil: deploy (BNB parameters, commit-reveal beacon) -> register a MEP -> relayer
// (hub + aggregator + beacon + sponsor) -> two wallets bond BNB and delegate session keys through the relayer
// -> browser-style nodes announce claims over the relay -> the relayer posts the epoch root -> instances
// materialize through the relayer -> a client posts a task, the executors answer over the relay, the relayer
// submits their signed results and settles -> fees paid. Everything the frontend does, without the browser.
import fs from "node:fs"; import path from "node:path";
import { parseEther, formatEther, keccak256, encodePacked } from "viem";
import * as H from "./harness.mjs";
let fails = 0; const check = (n, ok) => { console.log((ok ? "  ok   " : "  FAIL ") + n); if (!ok) fails++; };
const anvil = await H.startAnvil(8555);
try {
  const dep = await H.deploy(anvil.rpc); check("deployed; deployments/31337.json written", dep.addresses.claims && dep.epochBlocks === 40);
  const { mep, mepId, payload, steps } = await H.registerSyntheticMep(dep, H.KEYS[0]);
  const R = await H.startRelayer(dep, H.KEYS[3], [mepId]); const d = await R.api("/deployment");
  check("relayer up: relay + api + domains + mep", d.relay.startsWith("ws://") && d.domains.claimManager.verifyingContract === dep.addresses.claims && d.meps[0] === mepId.toLowerCase());
  const domains = d.domains;
  // ---- wallets bond BNB; tabs get session keys delegated through the relayer (sponsored) ----
  const E = await H.porw("eip712.js"); const { keypair } = await H.porw("claim.js"); const { PorwNode } = await H.porw("node.js"); const { loadKernelFromBytes } = await H.porw("porw.js"); const { RelayClient } = await H.porw("relay_client.js"); const { NodeService, resultSigningHash } = await H.porw("node_service.js"); const V = await H.porw("verify.js"); const Vf = await H.porw("verifier.js");
  const wasm = fs.readFileSync(path.join(H.porwDir, "sketch.wasm"));
  const mkInstance = async (walletKey, sessionByte) => {
    const c = H.clientsFor(dep, walletKey); const wallet = E.localWallet(walletKey); const session = keypair("0x" + sessionByte.repeat(32));
    await c.pub.waitForTransactionReceipt({ hash: await c.instances.write.bond([[mepId]], { value: parseEther("0.5") }) }); // 10 votes at UNIT 0.05
    const del = await E.makeDelegation(wallet, domains.registry, H.hex(session.address), 100000);
    const r = await R.api("/tx/delegate", { instance: del.instance, session: del.session, expiry: del.expiry, sig: del.sig });
    const nd = new PorwNode(await loadKernelFromBytes(wasm), { privHex: "0x" + sessionByte.repeat(32), domains, delegation: del }); await nd.loadModel("flywire-female", payload, { steps });
    const rc = new RelayClient([d.relay], nd.key); await rc.connect(); const results = [];
    const svc = new NodeService(nd, rc, { onResult: async (res) => { results.push(res); res.relayer = await R.api("/tx/result", res); } }); svc.serve(mep.mepId);
    return { c, wallet, session, del, delegateTx: r, nd, rc, svc, results, addr: wallet.address.toLowerCase() };
  };
  const A = await mkInstance(H.KEYS[1], "11"), B = await mkInstance(H.KEYS[2], "22");
  check("both wallets bonded (10 votes each) and session keys delegated by the relayer (sponsored txs)", (await A.c.instances.read.weightOf([A.wallet.address])) === 10n && A.delegateTx.ok && B.delegateTx.ok && (await A.c.instances.read.resolve([H.hex(A.session.address)])).toLowerCase() === A.addr);
  // ---- epoch 1: the relayer commits (end of epoch 0), reveals + rolls (start of epoch 1); instances claim ----
  const EPOCH = dep.epochBlocks; const toBlock = async (b) => { const cur = await anvil.block(); if (b > cur) await anvil.mine(b - cur); };
  const waitFor = async (pred, ms = 20000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await pred()) return true; await H.sleep(300); } return false; };
  const REVEAL = 10;
  /** drive the chain into epoch e: commit (end of e-1), reveal (start of e), beacon ready + rolled (after the reveal window) */
  const enterEpoch = async (e) => {
    await toBlock(e * EPOCH - 5); const c = await waitFor(async () => (await R.api("/status")).commits.includes(e));
    await toBlock(e * EPOCH + 2); const r = await waitFor(async () => (await R.api("/status")).reveals.includes(e));
    await toBlock(e * EPOCH + REVEAL + 2); const rolled = await waitFor(async () => (await R.api("/status")).epochsRolled.includes(e));
    return { c, r, rolled };
  };
  const e1 = await enterEpoch(1); check("epoch 1: relayer committed, revealed, and rolled the claim manager", e1.c && e1.r && e1.rolled);
  const ep = await R.api("/epoch?mep=" + mepId); check(`epoch info: epoch 1, beacon rolled, challenge for the MEP`, ep.epoch === 1 && ep.rolled && ep.challenge.length === 66);
  for (const X of [A, B]) await X.svc.announce(mep.mepId, H.unhex(ep.challenge), { stimulusSeed: 1 });
  check("aggregator collected both claims for epoch 1", await waitFor(async () => { const s = await R.api("/status"); const a = s.aggregators[0].epochs.find((e) => e.epoch === 1); return a && a.claims === 2; }));
  // ---- epoch 2: root posted; instances materialize (sponsored); eligibility ----
  const e2 = await enterEpoch(2); check("epoch 2 entered", e2.rolled);
  check("relayer posted the epoch-1 root (2 claims) in epoch 2", await waitFor(async () => (await R.api("/status")).rootsPosted.some((r) => r.epoch === 1 && r.count === 2)));
  const pA = await R.api(`/proof?mep=${mepId}&epoch=1&instance=${A.addr}`); check("A's inclusion proof served by the relayer", pA.index !== undefined && pA.proof.length >= 1 && pA.posted);
  // two sponsored requests at once: sends are serialized with consecutive local nonces
  const [mA, mB] = await Promise.all([R.api("/tx/materialize", { mep: mepId, epoch: 1, instance: A.addr }), R.api("/tx/materialize", { mep: mepId, epoch: 1, instance: B.addr })]);
  check(`materialized A and B through the relayer (gas ${mA.gasUsed}, ${mB.gasUsed})`, mA.ok && mB.ok && (await A.c.claims.read.hasValidClaim([A.wallet.address, mepId, 1n])) && (await A.c.claims.read.hasValidClaim([B.wallet.address, mepId, 1n])));
  check("both eligible in epoch 2 (bonded + materialized epoch-1 claims)", (await A.c.instances.read.isEligible([A.wallet.address, mepId, 2n])) && (await A.c.instances.read.isEligible([B.wallet.address, mepId, 2n])));
  { const st0 = await R.api("/status"); const seq = st0.txs.map((t) => t.nonce); check(`relayer nonces are consecutive across ${seq.length} serialized sends (${seq.join(",")})`, seq.every((n, i) => i === 0 || n === seq[i - 1] + 1)); }
  // desync the relayer's account on purpose: a transaction it did not send consumes the next nonce
  { const RK = H.clientsFor(dep, H.KEYS[3]); await RK.pub.waitForTransactionReceipt({ hash: await RK.wallet.sendTransaction({ to: H.KEYS[3] && RK.account.address, value: 0n }) }); }
  // ---- a task: posted by a client, announced over the relay to the executors' session inboxes, results sponsored, settled ----
  const C = H.clientsFor(dep, H.KEYS[0]); const nonce = "0x" + "31".repeat(32);
  const h = await C.market.write.postTask([{ mepId, stimulusSeed: 9, inputCommit: "0x" + "00".repeat(32), fee: parseEther("0.01"), deadline: BigInt(await anvil.block() + 50), redundancy: 2 }, nonce], { value: parseEther("0.01") });
  await C.pub.waitForTransactionReceipt({ hash: h });
  const taskId = keccak256(encodePacked(["bytes32", "uint32", "bytes32"], [mepId, 9, nonce])); const ex = (await C.market.read.executors([taskId])).map((x) => x.toLowerCase());
  check("sortition picked both bonded instances", ex.length === 2 && ex.includes(A.addr) && ex.includes(B.addr));
  const client = new RelayClient([d.relay], keypair(H.KEYS[0])); await client.connect();
  const balA = await A.c.pub.getBalance({ address: A.wallet.address });
  for (const X of [A, B]) { const resp = await client.request(H.hex(X.session.address), "task-announce", mepId, { taskId, stimulusSeed: 9 }, { timeoutMs: 20000, responseType: "result" }); check(`executor ${X.addr.slice(0, 8)} returned a signed result over the relay`, resp.payload.taskId === taskId); }
  check("both results submitted on-chain by the relayer (sponsored)", await waitFor(async () => A.results[0]?.relayer?.ok && B.results[0]?.relayer?.ok) && (await C.market.read.submitted([taskId, A.wallet.address])) && (await C.market.read.submitted([taskId, B.wallet.address])));
  const s = await R.api("/tx/settle", { taskId }); check("settled: identical results, fee split to the executors", s.ok && (await A.c.pub.getBalance({ address: A.wallet.address })) === balA + parseEther("0.005"));
  const re = Vf.reexecute(await loadKernelFromBytes(wasm), payload, { stimulusSeed: 9, execDigest: H.unhex(A.results[0].execDigest) }, mep); check("the client re-executes and matches the settled digest", re.matches);
  const st = await R.api("/status"); console.log(`relayer txs: ${st.txs.length} (${st.txs.filter((t) => t.ok).length} ok), errors: ${st.errors.length}${st.errors.length ? " " + JSON.stringify(st.errors.slice(0, 3)) : ""}; nonce resyncs: ${st.nonce.resyncs}`);
  check("after the external desync the relayer resynced its pending nonce and its later sends still succeeded", st.nonce.resyncs >= 2 && st.txs.slice(-3).every((t) => t.ok) && st.errors.length === 0);
  for (const X of [A, B]) X.rc.close(); client.close(); R.stop();
} catch (e) { console.error(e); fails++; } finally { anvil.stop(); }
console.log(fails ? `${fails} FAILURES` : "ALL PASS"); process.exit(fails ? 1 : 0);
