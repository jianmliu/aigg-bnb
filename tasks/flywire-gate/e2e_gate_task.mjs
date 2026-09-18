// The gate experiment end to end on a local anvil under the scheme of this checkout (sketch-tile-keccak:v2): deploy ->
// register the three real-payload MEPs (profile only: steps and stride are the Task's) -> relayer -> two executors bond,
// delegate session keys, load the three brains (the edited ones from their FLYDELTAv1 deltas) -> epoch-1 residency claims
// (no inference) -> epoch-2 materialize -> the six tasks through post_tasks.mjs (5000 steps, stride 500 on the Task,
// redundancy 2) -> sponsored results, client-paid settle -> digests checked against task.json. Writes e2e_anvil_log.json.
//   FOUNDRY_BIN=$HOME/.foundry/bin node tasks/flywire-gate/e2e_gate_task.mjs /path/to/flywire-783-min5.bin
import fs from "node:fs"; import path from "node:path"; import { parseEther, formatEther } from "viem";
const here = path.dirname(new URL(import.meta.url).pathname); const H = await import(path.join(here, "../../test/harness.mjs")); const { runTasks } = await import(path.join(here, "post_tasks.mjs"));
const basePath = process.argv[2]; if (!basePath) { console.log("usage: e2e_gate_task.mjs <flywire-783-min5.bin>"); process.exit(2); }
const T = JSON.parse(fs.readFileSync(path.join(here, "task.json"), "utf8")); const MODELS = Object.keys(T.models); const V = await H.porw("verify.js"); const S = V.SCHEME_ID;
let fails = 0; const log = { startedAt: new Date().toISOString(), scheme: S, steps: T.steps, commitStride: T.commitStride, seed: T.stimulusSeed, meps: {}, epochs: {} }; const check = (n, ok) => { console.log((ok ? "  ok   " : "  FAIL ") + n); if (!ok) fails++; };
const anvil = await H.startAnvil(8556);
try {
  const dep = await H.deploy(anvil.rpc, { EPOCH_BLOCKS: "200" }); check(`deployed on anvil (chain 31337, 200-block epochs), scheme ${S}`, !!dep.addresses.market); log.addresses = dep.addresses;
  const E = await H.porw("eip712.js"); const { keypair } = await H.porw("claim.js"); const { PorwNode } = await H.porw("node.js"); const { loadKernelFromBytes } = await H.porw("porw.js"); const { RelayClient } = await H.porw("relay_client.js"); const { NodeService } = await H.porw("node_service.js"); const { applyDelta } = await H.porw("delta.js");
  const wasm = fs.readFileSync(path.join(H.porwDir, "sketch.wasm")); const base = new Uint8Array(fs.readFileSync(basePath));
  const payloads = Object.fromEntries(MODELS.map((m) => [m, T.models[m].delta ? applyDelta(base, new Uint8Array(fs.readFileSync(path.join(here, T.models[m].delta.file)))) : base]));
  const C = H.clientsFor(dep, H.KEYS[0]); const meps = {};
  for (const m of MODELS) {
    const nd = new PorwNode(await loadKernelFromBytes(wasm), { privHex: H.KEYS[4] }); const st = await nd.loadModel(m, payloads[m], { maxSteps: 1 }); const mep = st.mep; const rec = T.models[m].mepByScheme?.[S];
    const fields = { modelId: H.hex(mep.modelId), schemeDigest: H.hex(mep.schemeDigest), execKind: H.hex(mep.execKind), neurons: st.hdr.neurons, synapses: st.hdr.synapses, synapseRoot: H.hex(st.csr.synapseRoot), weightsDA: "0x" + Buffer.from(`gnfd://aigg-brains/${m}.bin`).toString("hex") };
    const h = await C.meps.write.registerMEP([fields]); const rc = await C.pub.waitForTransactionReceipt({ hash: h }); meps[m] = { mepId: H.hex(mep.mepId), bytes: mep.mepId }; log.meps[m] = { mepId: meps[m].mepId, registerTx: h, gas: String(rc.gasUsed), fromDelta: !!T.models[m].delta };
    check(`registered ${m} ${meps[m].mepId.slice(0, 12)}… = the ${S.split(":").pop()} id in task.json (gas ${rc.gasUsed}${T.models[m].delta ? ", payload rebuilt from its delta" : ""})`, rc.status === "success" && rec && rec.mepId === meps[m].mepId && (await C.meps.read.exists([meps[m].mepId])));
  }
  const mepIds = MODELS.map((m) => meps[m].mepId); const R = await H.startRelayer(dep, H.KEYS[3], mepIds); const d = await R.api("/deployment"); const domains = d.domains; check("relayer up, serving the three MEPs", d.meps.length === 3);
  const api = async (...a) => { for (let i = 0; ; i++) { try { return await R.api(...a); } catch (e) { if (i >= 2) throw e; await H.sleep(300); } } }; // long wasm runs outlive the API's keep-alive
  const selfPaid = [];
  const mkInstance = async (walletKey, sessionByte) => {
    const c = H.clientsFor(dep, walletKey); const wallet = E.localWallet(walletKey); const session = keypair("0x" + sessionByte.repeat(32));
    await c.pub.waitForTransactionReceipt({ hash: await c.instances.write.bond([mepIds], { value: parseEther("0.5") }) });
    const del = await E.makeDelegation(wallet, domains.registry, H.hex(session.address), 100000); const r = await api("/tx/delegate", { instance: del.instance, session: del.session, expiry: del.expiry, sig: del.sig });
    const nd = new PorwNode(await loadKernelFromBytes(wasm), { privHex: "0x" + sessionByte.repeat(32), domains, delegation: del }); for (const m of MODELS) await nd.loadModel(m, payloads[m], { maxSteps: T.steps });
    const rc = new RelayClient([d.relay], nd.key); await rc.connect(); const results = []; // the relayer sponsors submitResult out of a per-instance, per-epoch gas budget; past it the executor pays for its own result
    const svc = new NodeService(nd, rc, { onResult: async (res) => { results.push(res); res.relayer = await api("/tx/result", res);
      if (!res.relayer.ok) { const sh = await c.market.write.submitResult([res.taskId, { execDigest: res.execDigest, execRoot: res.execRoot }, res.signature]); const r2 = await c.pub.waitForTransactionReceipt({ hash: sh }); res.self = { ok: r2.status === "success", hash: sh, gasUsed: String(r2.gasUsed), after: res.relayer.error }; selfPaid.push({ instance: wallet.address.toLowerCase(), taskId: res.taskId, why: res.relayer.error, gasUsed: String(r2.gasUsed) }); } } }); for (const m of MODELS) svc.serve(meps[m].bytes);
    return { c, wallet, session, delegateTx: r, nd, rc, svc, results, addr: wallet.address.toLowerCase() };
  };
  const A = await mkInstance(H.KEYS[1], "11"), B = await mkInstance(H.KEYS[2], "22"); log.instances = { A: A.addr, B: B.addr };
  check("both executors bonded on the three MEPs and delegated (sponsored)", (await A.c.instances.read.weightOf([A.wallet.address])) === 10n && A.delegateTx.ok && B.delegateTx.ok);
  const EPOCH = dep.epochBlocks, REVEAL = 10; const toBlock = async (b) => { const cur = await anvil.block(); if (b > cur) await anvil.mine(b - cur); }; const waitFor = async (pred, ms = 30000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await pred()) return true; await H.sleep(300); } return false; };
  const enterEpoch = async (e) => { await toBlock(e * EPOCH - 5); const c = await waitFor(async () => (await api("/status")).commits.includes(e)); await toBlock(e * EPOCH + 2); const r = await waitFor(async () => (await api("/status")).reveals.includes(e)); await toBlock(e * EPOCH + REVEAL + 2); const rolled = await waitFor(async () => (await api("/status")).epochsRolled.includes(e)); return { c, r, rolled }; };
  const e1 = await enterEpoch(1); check("epoch 1: committed, revealed, rolled", e1.c && e1.r && e1.rolled);
  let t0 = performance.now(); for (const m of MODELS) { const ep = await api("/epoch?mep=" + meps[m].mepId); for (const X of [A, B]) await X.svc.announce(meps[m].bytes, H.unhex(ep.challenge)); } log.epochs.claimsMs = Math.round(performance.now() - t0);
  check(`six residency claims in ${log.epochs.claimsMs} ms (no inference; the v1 run needed ~70,000 ms), 2 per MEP collected`, await waitFor(async () => (await api("/status")).aggregators.every((a) => a.epochs.find((e) => e.epoch === 1)?.claims === 2)));
  const e2 = await enterEpoch(2); check("epoch 2 entered", e2.rolled);
  check("relayer posted ONE epoch-1 root over the six claims of the three MEPs", await waitFor(async () => { const r = (await api("/status")).rootsPosted.filter((r) => r.epoch === 1); return r.length === 1 && r[0].count === 6 && r[0].meps === 3; }));
  for (const m of MODELS) for (const X of [A, B]) { const r = await api("/tx/materialize", { mep: meps[m].mepId, epoch: 1, instance: X.addr }); if (!r.ok) console.log("materialize failed", m, X.addr, r); }
  check("both executors eligible on all three MEPs in epoch 2", (await Promise.all(MODELS.flatMap((m) => [A, B].map((X) => A.c.instances.read.isEligible([X.wallet.address, meps[m].mepId, 2n]))))).every(Boolean));
  const balA = await A.c.pub.getBalance({ address: A.wallet.address }); t0 = performance.now();
  const res = await runTasks(C, H.KEYS[0], api, { fee: "0.01", deadlineBlocks: 150, log: (m) => console.log("       " + m) }); log.tasks = res; log.tasksMs = Math.round(performance.now() - t0);
  check("six tasks posted with steps and stride on the Task, sortition picked both executors each time", res.length === 6 && res.every((r) => r.executors?.length === 2 && r.executors.includes(A.addr) && r.executors.includes(B.addr)));
  check("both executors returned the expected digest over the relay for every task", res.every((r) => Object.values(r.results || {}).length === 2 && Object.values(r.results).every((x) => x.ok)));
  check("all six settled by the client; every result reached the chain", res.every((r) => r.submitted && r.settle?.ok));
  const sp = (await api("/status")).sponsor; log.sponsorship = { epochGasLimit: sp.epochGasLimit, refused: sp.refused.length, selfPaid };
  check(`sponsorship guard: ${12 - selfPaid.length} of 12 results sponsored; ${selfPaid.length} refused past the ${sp.epochGasLimit}-gas per-instance epoch budget and paid by the executors themselves`, selfPaid.length === sp.refused.length && selfPaid.every((x) => /budget/.test(x.why)));
  const earned = (await A.c.pub.getBalance({ address: A.wallet.address })) - balA; log.earnedA = formatEther(earned);
  check(`executor A earned 6 x 0.005 BNB minus the gas of its self-paid results (${formatEther(earned)} BNB net)`, earned <= parseEther("0.03") && earned > parseEther("0.025"));
  const D = (m, s) => res.find((t) => t.model === m && t.stimulusSet === s).results[A.addr].execDigest;
  check("the settled digests encode the claim: full+gate differs from full and from ablate4+gate; the three joLR digests agree", D(MODELS[0], "joLR+gate") !== D(MODELS[0], "joLR") && D(MODELS[0], "joLR+gate") !== D(MODELS[1], "joLR+gate") && D(MODELS[0], "joLR") === D(MODELS[1], "joLR") && D(MODELS[0], "joLR") === D(MODELS[2], "joLR"));
  const st = await api("/status"); log.relayer = { txs: st.txs.length, txOk: st.txs.filter((t) => t.ok).length, errors: st.errors }; console.log(`relayer txs: ${st.txs.length} (${log.relayer.txOk} ok), errors: ${st.errors.length}`);
  for (const X of [A, B]) X.rc.close(); R.stop();
} catch (e) { console.error(e); fails++; log.error = String(e); try { console.log("--- relayer log (tail) ---\n" + (globalThis.__R?.log() || "").slice(-3000)); } catch {} } finally { anvil.stop(); }
log.finishedAt = new Date().toISOString(); log.fails = fails; fs.writeFileSync(path.join(here, "e2e_anvil_log.json"), JSON.stringify(log, (k, v) => (typeof v === "bigint" ? String(v) : v), 1));
console.log(fails ? `${fails} FAILURES` : "ALL PASS"); process.exit(fails ? 1 : 0);
