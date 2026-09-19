// The gateway, end to end on anvil (docs/GATEWAY.md, milestone 0): an inference-shaped request in, a receipt out.
// Two bonded, eligible hosts of a synthetic int-lif brain stand behind a relayer that sponsors only the gateway's
// tasks. Then, one by one, the rows of the design's tables:
//   - a call: posted with the gateway's BNB, run by both providers on the experiment it named (stimulate + silence ->
//     the state_0 root the gateway computed WITHOUT the brain, which the providers would refuse if it were wrong),
//     settled, paid; the receipt's digest is the one anybody recomputes; usage = steps
//   - the READOUT: spike counts returned by the providers, served only because they hash to the settled digest; a
//     provider that sends other counts is ignored, and the full vector is downloadable
//   - the same as a stream (events, keep-alive comments), in the background (poll; settled -> final), and through
//     the chat-completions alias; input as an object, as JSON text, and as a message list
//   - a cold model: 503 before a wei is spent
//   - a restart between postTask and settle: the fee is already spent, the call is driven on
//   - nobody answers: refunded by the market, 504, nothing billed
//   - the providers disagree: a dispute opens, 502, nothing billed
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
import { parseEther } from "viem";
import * as H from "./harness.mjs";
let fails = 0; const check = (n, ok) => { console.log((ok ? "  ok   " : "  FAIL ") + n); if (!ok) fails++; };
const waitFor = async (p, ms = 30000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await p()) return true; await H.sleep(200); } return false; };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gw-")); const anvil = await H.startAnvil(8569); const stop = [];
try {
  // long epochs: everything below happens inside epoch 2, where the hosts' epoch-1 claims make them eligible
  const dep = await H.deploy(anvil.rpc, { EPOCH_BLOCKS: "200", CLAIM_VALIDITY_EPOCHS: "3" });
  const { synthesizePayloadV2 } = await H.porw("synth.js"); const { PorwNode } = await H.porw("node.js"); const { loadKernelFromBytes } = await H.porw("porw.js");
  const { RelayClient } = await H.porw("relay_client.js"); const { NodeService } = await H.porw("node_service.js"); const { keypair } = await H.porw("claim.js"); const E = await H.porw("eip712.js");
  const wasm = fs.readFileSync(path.join(H.porwDir, "sketch.wasm")); const STEPS = 20, NEURONS = 3000;
  const D = H.clientsFor(dep, H.KEYS[0]); const G = H.clientsFor(dep, H.KEYS[4]); const GW = G.account.address.toLowerCase();
  const register = async (name) => { const payload = synthesizePayloadV2(name, NEURONS, 30000); const probe = new PorwNode(await loadKernelFromBytes(wasm), { privHex: "0x" + "44".repeat(32) });
    const st = await probe.loadModel(name, payload, { maxSteps: STEPS, exec: "lif" }); const mep = st.mep;
    await D.pub.waitForTransactionReceipt({ hash: await D.meps.write.registerMEP([{ modelId: H.hex(mep.modelId), schemeDigest: H.hex(mep.schemeDigest), execKind: H.hex(mep.execKind), neurons: NEURONS, synapses: st.hdr.synapses, synapseRoot: H.hex(st.csr.synapseRoot), weightsDA: "0x" + Buffer.from("gnfd://aigg-brains/" + name).toString("hex") }]) });
    return { name, payload, probe, mep, mepId: H.hex(mep.mepId) }; };
  const warm = await register("gw-warm"), cold = await register("gw-cold");

  const R = await H.startRelayer(dep, H.KEYS[3], [warm.mepId, cold.mepId], { env: { PORW_TASK_CLIENTS: GW } }); stop.push(() => R.stop()); const d0 = await R.api("/deployment"); const domains = d0.domains;
  const mk = async (walletKey, sessionByte) => {
    const c = H.clientsFor(dep, walletKey); const wallet = E.localWallet(walletKey); const session = keypair("0x" + sessionByte.repeat(32));
    await c.pub.waitForTransactionReceipt({ hash: await c.instances.write.bond([[warm.mepId]], { value: parseEther("0.5") }) });
    const del = await E.makeDelegation(wallet, domains.registry, H.hex(session.address), 100000); await R.api("/tx/delegate", { instance: del.instance, session: del.session, expiry: del.expiry, sig: del.sig });
    const nd = new PorwNode(await loadKernelFromBytes(wasm), { privHex: "0x" + sessionByte.repeat(32), domains, delegation: del }); await nd.loadModel(warm.name, warm.payload, { maxSteps: STEPS, exec: "lif" });
    const rc = new RelayClient([d0.relay], nd.key); await rc.connect(); stop.push(() => rc.close());
    const svc = new NodeService(nd, rc, { onResult: async (res) => { res.relayer = await R.api("/tx/result", res); } }); svc.serve(warm.mep.mepId);
    return { c, nd, svc, addr: wallet.address.toLowerCase(), up: () => svc.serve(warm.mep.mepId), down: () => svc.stop() };
  };
  const A = await mk(H.KEYS[1], "11"), B = await mk(H.KEYS[2], "22");
  const EPOCH = dep.epochBlocks; const toBlock = async (b) => { const cur = await anvil.block(); if (b > cur) await anvil.mine(b - cur); };
  const enterEpoch = async (e) => { await toBlock(e * EPOCH - 5); await waitFor(async () => (await R.api("/status")).commits.includes(e)); await toBlock(e * EPOCH + 2); await waitFor(async () => (await R.api("/status")).reveals.includes(e)); await toBlock(e * EPOCH + 12); return waitFor(async () => (await R.api("/status")).epochsRolled.includes(e)); };
  check("epoch 1 rolled", await enterEpoch(1)); const ep = await R.api("/epoch?mep=" + warm.mepId); for (const X of [A, B]) await X.svc.announce(warm.mep.mepId, H.unhex(ep.challenge));
  check("epoch 2 rolled, the epoch-1 root posted", (await enterEpoch(2)) && await waitFor(async () => (await R.api("/status")).rootsPosted.some((r) => r.epoch === 1 && r.count === 2)));
  const mA = await R.api("/tx/materialize", { mep: warm.mepId, epoch: 1, instance: A.addr }), mB = await R.api("/tx/materialize", { mep: warm.mepId, epoch: 1, instance: B.addr }); check("two providers of the warm brain are eligible", mA.ok && mB.ok);

  // ---- the gateway ----
  const sets = { ears: Array.from({ length: 250 }, (_, j) => j * 9), quiet: [40, 41, 42, 900, 1500, 2200] }; fs.writeFileSync(path.join(tmp, "sets.json"), JSON.stringify(sets));
  const WEI = 10n ** 15n; const FEE = BigInt(STEPS) * 2n * WEI; // large next to gas, so "refunded" and "paid" are told apart by balances
  const genv = { GATEWAY_BEARER: "test-bearer", GATEWAY_MODELS: `warm=${warm.mepId},cold=${cold.mepId}`, GATEWAY_SETS: path.join(tmp, "sets.json"), GATEWAY_STATE: path.join(tmp, "state.json"),
    GATEWAY_WEI_PER_STEP: String(WEI), GATEWAY_KEEPALIVE_MS: "50", GATEWAY_RESULT_TIMEOUT_MS: "4000", GATEWAY_POLL_MS: "150" };
  { let refused = ""; try { await H.startGateway(R, H.KEYS[4], { ...genv, GATEWAY_BEARER: "" }); } catch (e) { refused = String(e.message); } check("without a bearer it refuses to start: anybody could spend the wallet", /GATEWAY_BEARER is not set/.test(refused)); }
  { const a = dep.addresses; let refused = ""; try { await H.startGateway(R, H.KEYS[4], { ...genv, PORW_CHAIN_ID: String(dep.chainId), PORW_RPC: dep.rpc, PORW_MEP_REGISTRY: a.meps, PORW_INSTANCES: a.instances, PORW_CLAIMS: a.claims, PORW_MARKET: a.relays }); } catch (e) { refused = String(e.message); }
    check("told one market by its environment and another by the relayer, it refuses to start: money is not sent where an HTTP endpoint says", /serves another deployment/.test(refused)); }
  let GWY = await H.startGateway(R, H.KEYS[4], genv); stop.push(() => GWY.stop());
  const call = (p, body, headers = { authorization: "Bearer test-bearer" }) => fetch(GWY.url + p, body ? { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) } : { headers });
  const bal = (addr) => D.pub.getBalance({ address: addr });

  check("no bearer, no service", (await call("/v1/models", null, {})).status === 401 && (await call("/v1/responses", { model: "warm" }, {})).status === 401);
  { const m = (await (await call("/v1/models")).json()).data; const w = m.find((x) => x.id === "warm"), c = m.find((x) => x.id === "cold");
    check(`/v1/models: the warm brain has 2 providers and is available; the cold one has none and is not`, w.providers === 2 && w.votes === 20 && w.available === true && c.providers === 0 && c.available === false && w.exec === "int-lif" && w.aliases.includes("mep:" + warm.mepId)); }

  // ---- a call ----
  const expected = await warm.probe.execute(warm.mep.mepId, { steps: STEPS, commitStride: 2, stimulusSeed: 7, stimulusIds: Uint32Array.from(sets.ears), silenceIds: Uint32Array.from(sets.quiet) });
  // read out the neuron that fires most, one that fires, and a silenced one (which cannot)
  const byCount = Array.from(expected.result.counts.keys()).sort((x, y) => expected.result.counts[y] - expected.result.counts[x]); const ASKED = [byCount[0], byCount[5], 40].sort((x, y) => x - y);
  const experiment = { stimulate: { set: "ears" }, silence: { ids: [...sets.quiet, 40] }, readout: { ids: ASKED } };
  const b0 = { g: await bal(GW), a: await bal(A.addr), b: await bal(B.addr) };
  const r1 = await call("/v1/responses", { model: "warm", seed: 7, max_output_tokens: STEPS, input: experiment }); const j1 = await r1.json(); const rc = j1.receipt || {};
  if (r1.status !== 200) console.log("   ", r1.status, JSON.stringify(j1).slice(0, 600), "\n", GWY.log().split("\n").slice(-8).join("\n"));
  check("a call: 200, completed, settled on-chain by both providers", r1.status === 200 && j1.status === "completed" && rc.executors?.length === 2 && rc.executors.includes(A.addr) && rc.executors.includes(B.addr) && rc.finality === "settled");
  check("they ran the experiment it named: the state_0 root the gateway computed without the brain is the one they built", rc.init_state_root === H.hex(expected.result.initStateRoot) && rc.stimulated === 250 && rc.silence_ids.length === 6);
  check("the receipt's digest and root are the ones anybody recomputes", rc.exec_digest === H.hex(expected.result.execDigest) && rc.exec_root === H.hex(expected.result.execRoot) && (await D.market.read.settledDigest([j1.id])) === rc.exec_digest);
  check("the response id is the task id, one step is one token, and ten segments are committed", j1.id === rc.task && j1.usage.output_tokens === STEPS && rc.commit_stride === 2 && (await D.market.read.taskInfo([j1.id]))[2].toLowerCase() === GW);
  const b1 = { g: await bal(GW), a: await bal(A.addr), b: await bal(B.addr) };
  check(`the gateway paid the fee (${FEE} wei) and the providers split it`, b1.a - b0.a === FEE / 2n && b1.b - b0.b === FEE / 2n && b0.g - b1.g > FEE && b0.g - b1.g < FEE + parseEther("0.01") && BigInt(rc.fee_wei) === FEE);
  // ---- the readout: counts from the providers, served because they hash to the digest the task settled on ----
  { const want = expected.result.counts; const out = JSON.parse(j1.output[0].content[0].text); const sum = want.reduce((a, b) => a + b, 0);
    check(`the readout is the neurons it asked for, with the counts anybody recomputes (${out.readout.map((r) => r.id + ":" + r.spikes).join(", ")}; ${sum} spikes in all)`, out.readout.length === 3 && out.readout.find((r) => r.id === 40).spikes === 0 && out.readout.some((r) => r.spikes > 1) && out.readout.every((r) => r.spikes === want[r.id] && r.hz === Math.round(want[r.id] / (STEPS * 0.0001) * 100) / 100) && out.summary.total_spikes === sum && sum > 0 && out.summary.dt_ms === 0.1 && /^verified/.test(out.readout_status));
    check("the receipt says whose counts they are and that they were verified", rc.counts.status === "verified" && rc.executors.includes(rc.counts.from) && rc.counts.neurons === NEURONS && /match the digest/.test(rc.results[A.addr].counts));
    const dl = await call(rc.counts_url); const bytes = new Uint8Array(await dl.arrayBuffer()); const got = new Uint32Array(bytes.buffer, 0, bytes.length / 4);
    check("and the whole vector is there to download: little-endian u32, one per neuron, equal to the recomputed one", dl.status === 200 && dl.headers.get("x-exec-digest") === rc.exec_digest && got.length === NEURONS && got.every((v, i) => v === want[i]));
    check("which needs the bearer like everything else", (await call(rc.counts_url, null, {})).status === 401); }
  // a provider that hands over OTHER counts than the ones it signed for: ignored, the honest provider's are served
  { const run = A.nd.execute.bind(A.nd); A.nd.execute = async (...a) => { const r = await run(...a); r.result.counts = Uint32Array.from(r.result.counts, (v, i) => (i === 3 ? v + 1 : v)); return r; };
    const j = await (await call("/v1/responses", { model: "warm", seed: 21, max_output_tokens: STEPS, input: { stimulate: { set: "ears" }, readout: { top: 3 } } })).json(); A.nd.execute = run; const out = JSON.parse(j.output[0].content[0].text);
    check("forged counts are not served: they do not hash to the digest their sender signed, and the other provider's do", j.status === "completed" && /DO NOT match/.test(j.receipt.results[A.addr].counts) && j.receipt.counts.status === "verified" && j.receipt.counts.from === B.addr);
    check(`asked for the top 3, it gives the three that fired most (${out.readout.map((r) => r.id + ":" + r.spikes).join(", ")})`, out.readout.length === 3 && out.readout[0].spikes >= out.readout[1].spikes && out.readout[1].spikes >= out.readout[2].spikes && out.readout[2].spikes > 0); }

  // ---- a stream; input as JSON text ----
  { const r = await call("/v1/responses", { model: "mep:" + warm.mepId, seed: 8, max_output_tokens: STEPS, stream: true, input: JSON.stringify({ silence: { set: "quiet" } }) }); const text = await r.text();
    const types = [...text.matchAll(/^event: (.+)$/gm)].map((m) => m[1]); const last = JSON.parse(text.trim().split("\n").filter((l) => l.startsWith("data: ")).at(-1).slice(6));
    check(`a stream: created, one in_progress per provider, completed (${types.join(" → ")})`, r.headers.get("content-type").startsWith("text/event-stream") && types[0] === "response.created" && types.filter((t) => t === "response.in_progress").length === 2 && types.at(-1) === "response.completed");
    check("with comment lines in between, so that nothing in front calls a quiet connection dead", /^: waiting on the chain$/m.test(text) && last.response.status === "completed" && last.response.receipt.executors.length === 2); }

  // ---- in the background; input as a message list; finality ----
  { const q = await (await call("/v1/responses", { model: "warm", seed: 9, max_output_tokens: STEPS, background: true, input: [{ role: "user", content: [{ type: "input_text", text: "{\"stimulate\":{\"ids\":[5,6,7]}}" }] }] })).json();
    check("in the background: an id at once, not completed yet", /^0x[0-9a-f]{64}$/.test(q.id) && q.status !== "completed");
    let v; check("polled to completion", await waitFor(async () => (v = await (await call("/v1/responses/" + q.id)).json()).status === "completed") && v.receipt.stimulated === 3);
    check(`settled, and challengeable for ${dep.challengeWindow} blocks`, v.receipt.finality === "settled" && v.receipt.final_after_block === v.receipt.settled_at + dep.challengeWindow);
    await anvil.mine(dep.challengeWindow + 1); check("after the window: final", (await (await call("/v1/responses/" + q.id)).json()).receipt.finality === "final"); }
  { const r = await call("/v1/chat/completions", { model: "warm", seed: 10, max_tokens: STEPS, messages: [{ role: "user", content: "{}" }] }); const j = await r.json();
    check("the chat-completions alias answers in its own shape, with the same receipt", r.status === 200 && j.object === "chat.completion" && j.usage.completion_tokens === STEPS && j.receipt.executors.length === 2); }

  // ---- refusals that cost nothing ----
  { const g = await bal(GW); const r = await call("/v1/responses", { model: "cold", max_output_tokens: STEPS }); const j = await r.json();
    check("a cold model: 503 model_cold with Retry-After, and not a wei spent", r.status === 503 && j.error.type === "model_cold" && j.error.providers === 0 && r.headers.get("retry-after") === "60" && (await bal(GW)) === g);
    const bad = async (body) => { const x = await call("/v1/responses", body); return [x.status, (await x.json()).error?.type].join(" "); };
    check("and what is not a request is a 4xx, equally free", (await bad({ model: "nobody" })) === "404 model_not_found" && (await bad({ model: "warm", max_output_tokens: 0 })) === "400 invalid_request_error" && (await bad({ model: "warm", redundancy: 1 })) === "400 invalid_request_error"
      && (await bad({ model: "warm", input: { silence: { ids: [NEURONS] } } })) === "400 invalid_request_error" && (await bad({ model: "warm", input: { readout: { ids: [NEURONS] } } })) === "400 invalid_request_error" && (await bad({ model: "warm", input: { stimulate: { set: "nose" } } })) === "400 invalid_request_error" && (await bal(GW)) === g); }

  { const poor = await H.startGateway(R, "0x" + "5e".repeat(32), { ...genv, GATEWAY_STATE: path.join(tmp, "poor.json") }); const r = await fetch(poor.url + "/v1/responses", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer test-bearer" }, body: JSON.stringify({ model: "warm", max_output_tokens: STEPS }) }); const j = await r.json(); await poor.stop();
    check("a gateway whose float ran dry says so (503 gateway_unfunded), and warns at start that the relayer does not sponsor its tasks", r.status === 503 && j.error.type === "gateway_unfunded" && /is not in the relayer's PORW_TASK_CLIENTS/.test(poor.log())); }

  // ---- a restart between postTask and settle ----
  { A.down(); B.down(); const q = await (await call("/v1/responses", { model: "warm", seed: 11, max_output_tokens: STEPS, background: true })).json();
    check("posted, and no provider is answering", await waitFor(async () => { try { return (await D.market.read.executors([q.id])).length === 2; } catch { return false; } })); // `executors` reverts until the task exists
    await GWY.stop(); A.up(); B.up(); GWY = await H.startGateway(R, H.KEYS[4], genv);
    let v; check("the gateway restarts, finds the call on disk, and drives it to settlement: the fee was already spent", /resuming/.test(GWY.log()) && await waitFor(async () => (v = await (await call("/v1/responses/" + q.id)).json()).status === "completed") && v.receipt.executors.length === 2); }

  // ---- nobody answers: the market refunds ----
  { A.down(); B.down(); const g = await bal(GW); const mining = setInterval(() => anvil.mine(8).catch(() => {}), 300);
    const r = await call("/v1/responses", { model: "warm", seed: 12, max_output_tokens: STEPS }); clearInterval(mining); const j = await r.json();
    check("nobody answers: 504 no_result, the receipt says refunded", r.status === 504 && j.error.type === "no_result" && j.receipt.refunded === true && j.receipt.executors.length === 0);
    check("and the fee came back: the gateway is out of pocket for gas only", g - (await bal(GW)) < FEE / 4n); A.up(); B.up(); }

  // ---- the providers disagree ----
  { A.nd.execLie = { step: 3, neuron: 1, kind: "state", delta: 40 }; const a = await bal(A.addr);
    const r = await call("/v1/responses", { model: "warm", seed: 13, max_output_tokens: STEPS }); const j = await r.json(); A.nd.execLie = null;
    check("a provider lies: a dispute opens at settlement, 502 disputed, nobody is paid", r.status === 502 && j.error.type === "disputed" && j.receipt.disputed.length === 2 && (await bal(A.addr)) === a);
    const v = await (await call("/v1/responses/" + j.id)).json(); check("and the call stays readable, with both roots in its receipt", v.status === "failed" && v.receipt.results[A.addr].execRoot !== v.receipt.results[B.addr].execRoot); }
} catch (e) { console.error(e); fails++; }
finally { for (const f of stop.reverse()) try { await f(); } catch {} anvil.stop(); fs.rmSync(tmp, { recursive: true, force: true }); }
console.log(fails ? `${fails} FAILURES` : "gateway: all checks passed"); process.exit(fails ? 1 : 0);
