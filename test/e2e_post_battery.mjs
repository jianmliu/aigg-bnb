// Posting an individual's battery, end to end on a local anvil, under the MALE brain's exec kind (weight unit 7209).
//
// A requester with nothing but a funded key and the brain's payload posts a battery as one batched task through
// flybnb/battery/post_battery.mjs: it finds the executors' session keys on chain, announces, collects, and gets an
// attestation whose per-run digests it then joins with the OFFLINE runner's rows (flybnb/analysis/run_battery.py, numpy).
// That join is the dataset's claim in one line: a row computed at a desk is the row the network signed. Two independent
// implementations (the wasm kernel in the nodes, numpy offline) under a non-default weight unit have to agree bit for bit.
//
// The offline half needs Python with numpy (FLYBNB_PYTHON, default python3). Without it the join is reported as SKIPPED.
import fs from "node:fs"; import os from "node:os"; import path from "node:path"; import { spawnSync } from "node:child_process";
import { parseEther } from "viem";
import * as H from "./harness.mjs";
import { postBattery, settledAs, checkAgainstOffline, sessionsOf, kindMatches, clientAllowed } from "../flybnb/battery/post_battery.mjs";
import { batteryBatch, resolvedRuns } from "../flybnb/battery/battery_batch.mjs";
let fails = 0; const check = (n, ok) => { console.log((ok ? "  ok   " : "  FAIL ") + n); if (!ok) fails++; };
let RELAYER = null; const anvil = await H.startAnvil(8567); const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "flybnb-post-"));
try {
  const dep = await H.deploy(anvil.rpc);
  const { synthesizePayloadV2 } = await H.porw("synth.js"); const { PorwNode } = await H.porw("node.js"); const { loadKernelFromBytes } = await H.porw("porw.js");
  const { RelayClient } = await H.porw("relay_client.js"); const { NodeService } = await H.porw("node_service.js"); const { keypair } = await H.porw("claim.js");
  const E = await H.porw("eip712.js"); const L = await H.porw("lif.js"); const porw = { batch: await H.porw("batch.js"), verify: await H.porw("verify.js") };
  const wasm = fs.readFileSync(path.join(H.porwDir, "sketch.wasm")); const WUNIT = Number(process.env.E2E_WUNIT ?? 7209), STEPS = Number(process.env.E2E_STEPS ?? 200), STRIDE = 50,   // long enough for activity to leave the stimulated set: before that a run's counts do not depend on the weight unit at all
        NEURONS = 3000, SYNAPSES = 30000, NAME = "lif-battery";
  const payload = synthesizePayloadV2(NAME, NEURONS, SYNAPSES); const lifOpts = { maxSteps: STEPS, exec: "lif", ...(WUNIT ? { wUnitQ16: WUNIT } : {}) };

  // ---- the brain, registered under the male kind ----
  const probe = new PorwNode(await loadKernelFromBytes(wasm), { privHex: H.KEYS[4] }); const pst = await probe.loadModel(NAME, payload, lifOpts); const mep = pst.mep, mepId = H.hex(mep.mepId), n = pst.hdr.neurons;
  { const c = H.clientsFor(dep, H.KEYS[0]); if (WUNIT) await c.pub.waitForTransactionReceipt({ hash: await c.meps.write.declareLifKind([WUNIT]) });
    await c.pub.waitForTransactionReceipt({ hash: await c.meps.write.registerMEP([{ modelId: H.hex(mep.modelId), schemeDigest: H.hex(mep.schemeDigest), execKind: H.hex(mep.execKind), neurons: n, synapses: pst.hdr.synapses, synapseRoot: H.hex(pst.csr.synapseRoot), weightsDA: "0x" + Buffer.from("gnfd://aigg-brains/lif-battery.bin").toString("hex") }]) });
    check(`the brain is registered under weight unit ${WUNIT}, not the default kind`, Number(await c.meps.read.lifWeightUnit([H.hex(mep.execKind)])) === WUNIT && H.hex(mep.execKind) !== H.hex(L.lifExecKind())); }

  // ---- a battery of this brain: the real file's shape, small enough for a test ----
  const ids = (from, step, count) => Array.from({ length: count }, (_, j) => from + j * step);
  const battery = { name: "flybnb-battery-test", version: 1, brain: NAME, exec_kind: "aigg:exec:int-lif:v1", steps: STEPS, commit_stride: STRIDE, seeds: [7, 8, 9], neurons: n, payload_model_id: H.hex(mep.modelId),
    population: { base: NAME, base_model_id: H.hex(mep.modelId), min_syn: 1, mean_ratio_q16: 60948, mut_rate_q32: 1 << 29, r_table_q8: null, w_unit_q16: WUNIT },
    readout: { name: "descending", rule: "every 10th neuron", neuron_index: ids(0, 10, 300), cell_type: ids(0, 10, 300).map((i) => "T" + (i % 40)), window: "second half" },
    stimuli: [["ears", ids(0, 9, 250)], ["legs", ids(3, 7, 300)], ["nose", ids(1500, 2, 120)]].map(([name, idx]) => ({ name, modality: "test", rule: "test", n: idx.length, neuron_index: idx })) };
  const b = batteryBatch(battery); const { runsRoot } = await probe.batchRunsRoot(mep.mepId, resolvedRuns(b));

  // ---- two bonded instances behind the relayer, eligible from epoch 2 (as in e2e_batch) ----
  const R = RELAYER = await H.startRelayer(dep, H.KEYS[3], [mepId]); const d0 = await R.api("/deployment"); const domains = d0.domains;
  check("the relayer serves the brain and reports its weight unit", (await R.api("/meps")).some((m) => m.mepId === mepId.toLowerCase() && m.wUnitQ16 === WUNIT));
  const mk = async (walletKey, sessionByte) => {
    const c = H.clientsFor(dep, walletKey); const wallet = E.localWallet(walletKey); const session = keypair("0x" + sessionByte.repeat(32));
    await c.pub.waitForTransactionReceipt({ hash: await c.instances.write.bond([[mepId]], { value: parseEther("0.5") }) });
    const del = await E.makeDelegation(wallet, domains.registry, H.hex(session.address), 100000); await R.api("/tx/delegate", { instance: del.instance, session: del.session, expiry: del.expiry, sig: del.sig });
    const nd = new PorwNode(await loadKernelFromBytes(wasm), { privHex: "0x" + sessionByte.repeat(32), domains, delegation: del }); await nd.loadModel(NAME, payload, lifOpts);
    const rc = new RelayClient([d0.relay], nd.key); await rc.connect(); const results = [];
    const svc = new NodeService(nd, rc, { onResult: async (res) => { results.push(res); res.relayer = await R.api("/tx/result", res); } }); svc.serve(mep.mepId);
    return { c, wallet, session, nd, rc, svc, results, addr: wallet.address.toLowerCase() };
  };
  const A = await mk(H.KEYS[1], "11"), Bn = await mk(H.KEYS[2], "22");
  const EPOCH = dep.epochBlocks; const toBlock = async (x) => { const cur = await anvil.block(); if (x > cur) await anvil.mine(x - cur); };
  const waitFor = async (p, ms = Number(process.env.E2E_WAIT_MS || 60000)) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await p()) return true; await H.sleep(250); } return false; };
  const enterEpoch = async (e) => { await toBlock(e * EPOCH - 5); await waitFor(async () => (await R.api("/status")).commits.includes(e)); await toBlock(e * EPOCH + 2); await waitFor(async () => (await R.api("/status")).reveals.includes(e)); await toBlock(e * EPOCH + 12); return waitFor(async () => (await R.api("/status")).epochsRolled.includes(e)); };
  check("epoch 1 rolled", await enterEpoch(1)); const ep = await R.api("/epoch?mep=" + mepId); for (const X of [A, Bn]) await X.svc.announce(mep.mepId, H.unhex(ep.challenge));
  check("epoch 2 rolled, the epoch-1 root posted", (await enterEpoch(2)) && await waitFor(async () => (await R.api("/status")).rootsPosted.some((r) => r.epoch === 1 && r.count === 2)));
  if (fails) { const st = await R.api("/status"); console.log("       relayer status:", JSON.stringify({ epoch: st.epoch, errors: st.errors, rootsPosted: st.rootsPosted, aggregators: st.aggregators, txs: st.txs.map((t) => t.label + (t.ok ? "" : " FAILED " + (t.error || ""))) })); }
  const mA = await R.api("/tx/materialize", { mep: mepId, epoch: 1, instance: A.addr }), mB = await R.api("/tx/materialize", { mep: mepId, epoch: 1, instance: Bn.addr }); check("both eligible", mA.ok && mB.ok);

  // ---- the requester: a funded key, the relayer's /deployment, the payload. Nothing else ----
  const { clients } = await import("../relayer/chain.mjs"); const chain = clients(d0, H.KEYS[4]); const relay = new RelayClient([d0.relay], keypair(H.KEYS[4])); await relay.connect();
  check("a mesh that names no task clients is open to this requester; one that names others is not", clientAllowed(d0, chain.account.address) && !clientAllowed({ taskClients: [A.addr] }, chain.account.address) && clientAllowed({ taskClients: [chain.account.address.toUpperCase().replace("0X", "0x")] }, chain.account.address));
  const km = await kindMatches(chain, battery, mepId); check("the battery's population and the registered kind name the same weight unit", km.ok === true && km.have === WUNIT);
  check("a battery of the default population is refused for this brain before anything is paid", (await kindMatches(chain, { ...battery, population: undefined }, mepId)).ok === false);
  const sess = await sessionsOf(chain, [A.addr, Bn.addr]); check("executors' session keys are found on chain, from SessionKeySet", sess[A.addr] === H.hex(A.session.address).toLowerCase() && sess[Bn.addr] === H.hex(Bn.session.address).toLowerCase());
  const bal0 = await chain.pub.getBalance({ address: chain.account.address }); const i0 = A.results.length;
  const att = await postBattery({ battery, mepId, runsRoot, chain, relay, porw, fee: parseEther("0.01"), redundancy: 2, deadlineBlocks: 400, timeoutMs: 300000, log: (m) => console.log("       " + m) });
  check(`posted as one task: ${att.rows.length} runs, ${att.gasUsed} gas`, att.rows.length === 9 && att.executors.length === 2 && att.executors.includes(A.addr) && att.executors.includes(Bn.addr));
  check("both executors replied, each reply's rows hash to the root it signed, and they signed the same batch", att.agreed && att.replies.every((r) => r.consistent && !r.error) && att.rows.every((r) => r.agree));
  check("rows are labelled in the battery's order: run k is stimulus floor(k/3) under seed 7 + k mod 3", att.rows.every((r, k) => r.stimulus === battery.stimuli[Math.floor(k / 3)].name && r.seed === 7 + (k % 3)));
  check("the requester paid the fee and gas, and nothing else", bal0 - (await chain.pub.getBalance({ address: chain.account.address })) < parseEther("0.012"));
  check("both results reached the chain through the relayer", await waitFor(async () => A.results[i0]?.relayer?.ok && Bn.results[i0]?.relayer?.ok));
  const s = await R.api("/tx/settle", { taskId: att.taskId, instance: A.addr }); const on = await settledAs(chain, att); check("settled, and what the chain paid for is the root in the attestation", s.ok && on.matches);

  // ---- the join with the offline runner ----
  const py = process.env.FLYBNB_PYTHON || "python3"; const has = spawnSync(py, ["-c", "import numpy"], { encoding: "utf8" }).status === 0;
  if (!has) console.log(`  SKIPPED the offline join: ${py} has no numpy (set FLYBNB_PYTHON)`);
  else {
    const pf = path.join(tmp, NAME + ".bin"), bf = path.join(tmp, "battery.json"), df = path.join(tmp, "design.json"), of = path.join(tmp, "rows.jsonl");
    fs.writeFileSync(pf, payload); fs.writeFileSync(bf, JSON.stringify(battery)); fs.writeFileSync(df, JSON.stringify({ individuals: [{ id: "BASE", kind: "base" }] }));
    const r = spawnSync(py, [path.join(H.root, "flybnb/analysis/run_battery.py"), "--base", pf, "--battery", bf, "--individuals", df, "--out", of, "--workers", "1"], { encoding: "utf8" });
    check("the offline runner accepts the same payload and battery", r.status === 0 && fs.existsSync(of)); if (r.status !== 0) console.log(r.stdout + r.stderr);
    const row = JSON.parse(fs.readFileSync(of, "utf8").split("\n")[0]); const j = checkAgainstOffline(att, row, battery);
    check(`numpy at a desk and the wasm nodes on the network give the same ${j.expected} digests under unit ${WUNIT}`, j.ok && j.matched === 9);
    const spoiled = { ...row, rows: row.rows.map((w, k) => (k === 4 ? { ...w, digest: "0x" + "00".repeat(32) } : w)) }; const j2 = checkAgainstOffline(att, spoiled, battery);
    check("and a row that differs is named, not averaged away", !j2.ok && j2.mismatches.length === 1 && j2.mismatches[0].run === 4);
    // the default unit is another brain as far as the dynamics go: the same payload offline under 18022 must NOT join
    const bf2 = path.join(tmp, "battery-default.json"), of2 = path.join(tmp, "rows-default.jsonl"); fs.writeFileSync(bf2, JSON.stringify({ ...battery, population: { ...battery.population, w_unit_q16: 18022 } }));
    const r2 = spawnSync(py, [path.join(H.root, "flybnb/analysis/run_battery.py"), "--base", pf, "--battery", bf2, "--individuals", df, "--out", of2, "--workers", "1"], { encoding: "utf8" });
    const j3 = r2.status === 0 ? checkAgainstOffline(att, JSON.parse(fs.readFileSync(of2, "utf8").split("\n")[0]), battery) : null;
    check("the weight unit is not decoration: offline rows under 18022 do not join rows executed under 7209", j3 && !j3.ok && j3.matched < 9);
  }
  for (const X of [A, Bn]) X.rc.close(); relay.close();
} catch (e) { console.error(String(e.shortMessage || e.message || e).split("\n").slice(0, 3).join(" | ")); fails++; } finally { try { RELAYER?.stop(); } catch {} anvil.stop(); fs.rmSync(tmp, { recursive: true, force: true }); }
console.log(fails ? `${fails} FAILURES` : "e2e post battery: all checks passed"); process.exit(fails ? 1 : 0);
