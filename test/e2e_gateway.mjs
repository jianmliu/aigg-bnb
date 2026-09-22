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
import fs from "node:fs"; import os from "node:os"; import path from "node:path"; import http from "node:http";
import { parseEther } from "viem";
import * as H from "./harness.mjs";
let fails = 0; const check = (n, ok, note = "") => { console.log((ok ? "  ok   " : "  FAIL ") + n + (!ok && note ? " — " + note : "")); if (!ok) fails++; };
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

  const R = await H.startRelayer(dep, H.KEYS[3], [warm.mepId, cold.mepId], { env: { PORW_TASK_CLIENTS: GW, PORW_BEACON_LAZY: "1" } }); stop.push(() => R.stop()); const d0 = await R.api("/deployment"); const domains = d0.domains;
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
  { const { wakeMessage } = await import("../relayer/wake.mjs"); const epoch = (await R.api("/epoch")).epoch;
    await R.api("/wake", { client: GW, epoch, signature: await G.account.signMessage({ message: wakeMessage(dep, d0.relayer, epoch) }) }); }
  check("epoch 1 rolled", await enterEpoch(1)); const ep = await R.api("/epoch?mep=" + warm.mepId); for (const X of [A, B]) await X.svc.announce(warm.mep.mepId, H.unhex(ep.challenge));
  check("epoch 2 rolled, the epoch-1 root posted", (await enterEpoch(2)) && await waitFor(async () => (await R.api("/status")).rootsPosted.some((r) => r.epoch === 1 && r.count === 2)));
  const mA = await R.api("/tx/materialize", { mep: warm.mepId, epoch: 1, instance: A.addr }), mB = await R.api("/tx/materialize", { mep: warm.mepId, epoch: 1, instance: B.addr }); check("two providers of the warm brain are eligible", mA.ok && mB.ok);

  // ---- the gateway ----
  const sets = { ears: Array.from({ length: 250 }, (_, j) => j * 9), quiet: [40, 41, 42, 900, 1500, 2200] }; fs.writeFileSync(path.join(tmp, "sets.json"), JSON.stringify(sets));
  // what a run costs a host is not one number: measured on the real brain the battery's stimuli span 9.4x and the
  // heavier export costs 1.54x. The gateway prices by both; here the warm brain is dear and `ears` dearer still.
  fs.writeFileSync(path.join(tmp, "pricing.json"), JSON.stringify({ models: { warm: 2, cold: 1 }, sets: { ears: 1.5, quiet: 1 }, default_set: 1 }));
  const WEI = 10n ** 15n; const TOKENS = BigInt(STEPS) * 2n * 3n, FEE = TOKENS * WEI; // steps x redundancy x model 2 x set 1.5, one wei_per_token each // large next to gas, so "refunded" and "paid" are told apart by balances
  const genv = { GATEWAY_BEARER: "test-bearer", GATEWAY_MODELS: `warm=${warm.mepId},cold=${cold.mepId}`, GATEWAY_SETS: path.join(tmp, "sets.json"), GATEWAY_STATE: path.join(tmp, "state.json"),
    GATEWAY_WEI_PER_STEP: String(WEI), GATEWAY_PRICING: path.join(tmp, "pricing.json"), GATEWAY_KEEPALIVE_MS: "50", GATEWAY_RESULT_TIMEOUT_MS: "4000", GATEWAY_POLL_MS: "150" };
  { let refused = ""; try { await H.startGateway(R, H.KEYS[4], { ...genv, GATEWAY_BEARER: "" }); } catch (e) { refused = String(e.message); } check("without a bearer it refuses to start: anybody could spend the wallet", /GATEWAY_BEARER is not set/.test(refused)); }
  { const a = dep.addresses; let refused = ""; try { await H.startGateway(R, H.KEYS[4], { ...genv, PORW_CHAIN_ID: String(dep.chainId), PORW_RPC: dep.rpc, PORW_MEP_REGISTRY: a.meps, PORW_INSTANCES: a.instances, PORW_CLAIMS: a.claims, PORW_MARKET: a.relays }); } catch (e) { refused = String(e.message); }
    check("told one market by its environment and another by the relayer, it refuses to start: money is not sent where an HTTP endpoint says", /serves another deployment/.test(refused)); }
  let GWY = await H.startGateway(R, H.KEYS[4], genv); stop.push(() => GWY.stop());
  const call = (p, body, headers = { authorization: "Bearer test-bearer" }) => fetch(GWY.url + p, body ? { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) } : { headers });
  const bal = (addr) => D.pub.getBalance({ address: addr });

  check("no bearer, no service", (await call("/v1/models", null, {})).status === 401 && (await call("/v1/responses", { model: "warm" }, {})).status === 401);
  { const m = (await (await call("/v1/models")).json()).data; const w = m.find((x) => x.id === "warm"), c = m.find((x) => x.id === "cold");
    check(`/v1/models: the warm brain has 2 providers and is available; the cold one has none and is not`, w.providers === 2 && w.votes === 20 && w.available === true && c.providers === 0 && c.available === false && w.exec === "int-lif" && w.aliases.includes("mep:" + warm.mepId));
    check(`one unit for everything (${w.wei_per_token} wei a token), and the brains differ in the COUNT: warm ${w.tokens_per_step} tokens a step against the cold one's ${c.tokens_per_step}, times a set's factor`,
      BigInt(w.wei_per_token) === WEI && BigInt(c.wei_per_token) === WEI && w.tokens_per_step === 2 && c.tokens_per_step === 1 && w.set_factors.ears === 1.5); }

  { const m = await R.api("/meps"); const w = m.find((x) => x.mepId === warm.mepId), c = m.find((x) => x.mepId === cold.mepId);
    check("relayer /meps counts distinct eligible providers, not votes", w.providers === 2 && w.votes === 20 && w.beacon === true && c.providers === 0); }

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
  check(`the fee follows the work, not the step count: the dear brain (x2) under the dear set (x1.5) is ${TOKENS} tokens = ${FEE} wei`, BigInt(rc.fee_wei) === FEE && rc.price.model_factor === 2 && rc.price.set_factor === 1.5 && rc.price.set === "ears" && rc.price.output_tokens === Number(TOKENS));
  // the bill a platform computes is price_per_token x tokens, so every factor in the fee has to be in the token count
  check(`and the usage says so: ${j1.usage.output_tokens} output tokens, the fee divided by the one unit -- nothing the gateway eats`, BigInt(j1.usage.output_tokens) === TOKENS && BigInt(j1.usage.output_tokens) * WEI === BigInt(rc.fee_wei));
  check("the receipt's digest and root are the ones anybody recomputes", rc.exec_digest === H.hex(expected.result.execDigest) && rc.exec_root === H.hex(expected.result.execRoot) && (await D.market.read.settledDigest([j1.id])) === rc.exec_digest);
  check("the response id is the task id and ten segments are committed", j1.id === rc.task && rc.commit_stride === 2 && (await D.market.read.taskInfo([j1.id]))[2].toLowerCase() === GW);
  const b1 = { g: await bal(GW), a: await bal(A.addr), b: await bal(B.addr) };
  check(`the gateway paid the fee (${FEE} wei) and the providers split it`, b1.a - b0.a === FEE / 2n && b1.b - b0.b === FEE / 2n && b0.g - b1.g > FEE && b0.g - b1.g < FEE + parseEther("0.01") && BigInt(rc.fee_wei) === FEE);
  // ---- the call's gas, as spent, billed as its input tokens at the same price per token: read both receipts back, redo the sum ----
  { const r1 = await D.pub.getTransactionReceipt({ hash: rc.post_tx }), r2 = await D.pub.getTransactionReceipt({ hash: rc.settle_tx }); const wei = r1.gasUsed * r1.effectiveGasPrice + r2.gasUsed * r2.effectiveGasPrice;
    check(`the call's gas (${Number(r1.gasUsed) + Number(r2.gasUsed)} gas, ${wei} wei) is its input tokens, in the SAME unit as the output ones -- not the brain's rate, or the gas would be billed at the brain's factor`,
      rc.gas.wei === String(wei) && rc.gas.post_task === Number(r1.gasUsed) && rc.gas.settle === Number(r2.gasUsed)
      && j1.usage.input_tokens === Number((wei + WEI - 1n) / WEI) && j1.usage.input_tokens >= 1 && j1.usage.total_tokens === j1.usage.input_tokens + j1.usage.output_tokens); }
  { const stats = await R.api("/hosts?instance=" + A.addr);
    check("host dashboard counts settled requests and actual executor earnings", stats.requestsServed === 1 && stats.earnedWei === String(FEE / 2n) && stats.fromBlock === 0 && stats.toBlock > 0);
    check("host stats reject malformed addresses", !!(await R.api("/hosts?instance=bad")).error); }
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
    check("the chat-completions alias answers in its own shape, with the same receipt", r.status === 200 && j.object === "chat.completion" && j.usage.completion_tokens === STEPS * 2 * 2 && j.usage.prompt_tokens > 0 && j.usage.total_tokens === j.usage.prompt_tokens + j.usage.completion_tokens && j.receipt.executors.length === 2); }

  // ---- behind ai.gg (aigg-src, a sub2api fork): the wire as its OpenAI relay makes it, read from its source ----
  { // what a caller of ai.gg's /v1/chat/completions turns into: always stream:true, store:false, an `include`, injected instructions, the
    // messages as `input` items, every unknown top-level field (seed!) DROPPED, and max_tokens floored at 128 -- more than these providers'
    // slots hold (20). So the experiment carries its own seed and steps, and they win.
    const wire = { model: "warm", instructions: "You are a helpful coding assistant.", stream: true, store: false, include: ["reasoning.encrypted_content"], max_output_tokens: 128,
      input: [{ role: "system", content: "be brief" }, { role: "user", content: JSON.stringify({ seed: 31, steps: STEPS, stimulate: { set: "ears" }, readout: { top: 2 } }) }] };
    const r = await call("/v1/responses", wire); const text = await r.text(); const evs = text.split("\n\n").filter((b) => b.startsWith("event: ")).map((b) => ({ type: b.split("\n")[0].slice(7), line: b.split("\n")[1], data: JSON.parse(b.split("\n")[1].slice(6)) }));
    const types = evs.map((e) => e.type); const delta = evs.filter((e) => e.type === "response.output_text.delta"); const last = evs.at(-1);
    check("the output opens right after `created`: ai.gg holds preamble events and comments until then, and its caller's proxy would hang up", types[0] === "response.created" && types[1] === "response.output_item.added");
    const out = delta.length === 1 ? JSON.parse(delta[0].data.delta) : null;
    check("the answer is sent as a text delta: for a chat-completions caller ai.gg builds the text from deltas and nothing else", !!out && out.readout.length === 2 && /^verified/.test(out.readout_status) && types.indexOf("response.output_text.delta") < types.indexOf("response.completed"));
    check("the terminal event carries the usage where ai.gg reads it, on a line it does not skip (>= 72 bytes)", last.type === "response.completed" && last.data.response.usage.output_tokens === STEPS * 2 * 2 * 1.5 && /* 2 tokens a step for this brain, and the call names `ears` (x1.5) */ last.data.response.usage.input_tokens === last.data.response.receipt.gas.tokens && last.data.response.usage.input_tokens >= 1 && last.line.length >= 72);
    check("the seed and the steps came from the experiment, not from the fields ai.gg drops or floors", last.data.response.receipt.seed === 31 && last.data.response.receipt.steps === STEPS && last.data.response.receipt.executors.length === 2);
    const probe = await call("/responses", { model: "warm", input: [{ role: "user", content: [{ type: "input_text", text: "hi" }] }], stream: true, instructions: "x" }); // aigg-src's admin "test connection", verbatim
    check("ai.gg's admin \"test connection\" posts prose to /responses: a plain 400 -- never a 401, which would disable the account, and nothing spent", probe.status === 400 && (await probe.json()).error.type === "invalid_request_error"); }

  // ---- refusals that cost nothing ----
  { const g = await bal(GW); const r = await call("/v1/responses", { model: "cold", max_output_tokens: STEPS }); const j = await r.json();
    check("a cold model: 503 model_cold with Retry-After, and not a wei spent", r.status === 503 && j.error.type === "model_cold" && j.error.providers === 0 && r.headers.get("retry-after") === "60" && (await bal(GW)) === g);
    const bad = async (body) => { const x = await call("/v1/responses", body); return [x.status, (await x.json()).error?.type].join(" "); };
    check("and what is not a request is a 4xx, equally free", (await bad({ model: "nobody" })) === "404 model_not_found" && (await bad({ model: "warm", max_output_tokens: 0 })) === "400 invalid_request_error" && (await bad({ model: "warm", redundancy: 1 })) === "400 invalid_request_error"
      && (await bad({ model: "warm", input: { silence: { ids: [NEURONS] } } })) === "400 invalid_request_error" && (await bad({ model: "warm", input: { readout: { ids: [NEURONS] } } })) === "400 invalid_request_error" && (await bad({ model: "warm", input: { stimulate: { set: "nose" } } })) === "400 invalid_request_error" && (await bal(GW)) === g); }

  { const poor = await H.startGateway(R, "0x" + "5e".repeat(32), { ...genv, GATEWAY_STATE: path.join(tmp, "poor.json") }); const r = await fetch(poor.url + "/v1/responses", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer test-bearer" }, body: JSON.stringify({ model: "warm", max_output_tokens: STEPS }) }); const j = await r.json(); await poor.stop();
    check("a gateway whose float ran dry says so (503 gateway_unfunded, before a wei moves), and warns at start that the relayer does not sponsor its tasks", r.status === 503 && j.error.type === "gateway_unfunded" && /is not in the relayer's PORW_TASK_CLIENTS/.test(poor.log())); }

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
  // ---- a provider reconnects, and delegates a FRESH session key ----
  // Every page reload does this, and the old delegation stays live for as long as its expiry says -- days. A gateway
  // that remembers the session it last found therefore keeps announcing into a key nobody is listening on: the host
  // is drawn, silent and unpaid, and the caller is told nobody answered. Seen on the live testnet before it was fixed.
  { const session2 = keypair("0x" + "aa".repeat(32));
    const del2 = await E.makeDelegation(E.localWallet(H.KEYS[1]), domains.registry, H.hex(session2.address), 100000);
    const dr = await R.api("/tx/delegate", { instance: del2.instance, session: del2.session, expiry: del2.expiry, sig: del2.sig });
    check("the provider's new delegation is on-chain, and the old one has not expired", dr.ok === true);
    A.down(); // the key the gateway has been using stops listening, exactly as a closed tab does
    A.nd.key = session2; A.nd.delegation = del2;
    const rc2 = new RelayClient([d0.relay], session2); await rc2.connect(); stop.push(() => rc2.close());
    const svc2 = new NodeService(A.nd, rc2, { onResult: async (res) => { res.relayer = await R.api("/tx/result", res); } });
    svc2.serve(warm.mep.mepId); stop.push(() => svc2.stop());
    // A is this provider from here on: the sections after this one drive it, and the service they reach has to be
    // the one that is actually listening -- a test that leaves the world half-swapped fails the NEXT test, not this one.
    A.svc = svc2; A.up = () => svc2.serve(warm.mep.mepId); A.down = () => svc2.stop();
    // Leave time for both hosts to submit before the 30-block task timeout. Eight blocks
    // per tick settled after ~1 s and raced the second host on an otherwise healthy RPC.
    const mining = setInterval(() => anvil.mine(1).catch(() => {}), 300);
    const r = await call("/v1/responses", { model: "warm", seed: 31, max_output_tokens: STEPS }); const j = await r.json();
    clearInterval(mining);
    check("a provider that re-delegated is announced to on its NEW session key, not the one last seen",
      r.status === 200 && j.status === "completed" && j.receipt?.executors?.length === 2); }

  // ---- an RPC that will not answer an unbounded eth_getLogs, which is every public one ----
  // The gateway has to find each executor's SESSION key to announce to it, and the registry maps session -> instance,
  // so the reverse is a log scan. It used to ask from block 0. Anvil answers that instantly; BSC testnet's public RPC
  // refuses it, and the mesh's first live call died there -- both executors unreachable, nothing announced, the fee
  // refunded at the timeout, and no test anywhere the wiser. So: the same call, through an RPC that refuses a span it
  // considers too wide, with the gateway's window set under that limit.
  { const LIMIT = 50; const seen = { widest: 0, refused: 0 };
    const proxy = http.createServer((rq, rs) => { let b = ""; rq.on("data", (d) => (b += d)); rq.on("end", async () => {
      const j = JSON.parse(b); const send = (o) => { rs.writeHead(200, { "content-type": "application/json" }); rs.end(JSON.stringify(o)); };
      if (j.method === "eth_getLogs") { const p = j.params[0] || {};
        const head = Number(await anvil.call("eth_blockNumber"));
        const to = p.toBlock && p.toBlock !== "latest" ? Number(p.toBlock) : head, from = p.fromBlock && p.fromBlock !== "earliest" ? Number(p.fromBlock) : 0;
        seen.widest = Math.max(seen.widest, to - from);
        if (to - from > LIMIT) { seen.refused++; return send({ jsonrpc: "2.0", id: j.id, error: { code: -32062, message: `eth_getLogs is limited to ${LIMIT} blocks` } }); } }
      const r = await fetch(anvil.rpc, { method: "POST", headers: { "content-type": "application/json" }, body: b }); send(await r.json()); }); });
    await new Promise((r) => proxy.listen(0, "127.0.0.1", r)); stop.push(() => new Promise((r) => proxy.close(r)));
    const a = dep.addresses, strictRpc = `http://127.0.0.1:${proxy.address().port}`;
    const strict = await H.startGateway(R, H.KEYS[4], { ...genv, GATEWAY_STATE: path.join(tmp, "strict.json"), GATEWAY_LOG_WINDOW: String(LIMIT - 10),
      PORW_CHAIN_ID: String(dep.chainId), PORW_RPC: strictRpc, PORW_MEP_REGISTRY: a.meps, PORW_INSTANCES: a.instances, PORW_CLAIMS: a.claims, PORW_MARKET: a.market, PORW_BEACON: a.beacon, PORW_DISPUTES: a.disputes, PORW_RELAYS: a.relays, PORW_VERIFIER: a.verifier });
    stop.push(() => strict.stop());
    // keep blocks coming, so a gateway that cannot reach the providers reaches the market's timeout and answers 504
    // instead of hanging: the point is to see the difference stated, not to wait for a socket to give up
    // Leave time for both hosts to submit before the 30-block task timeout. Eight blocks
    // per tick settled after ~1 s and raced the second host on an otherwise healthy RPC.
    const mining = setInterval(() => anvil.mine(1).catch(() => {}), 300);
    let r = { status: 0 }, j = {};
    try { r = await fetch(strict.url + "/v1/responses", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer test-bearer" }, body: JSON.stringify({ model: "warm", seed: 21, max_output_tokens: STEPS }), signal: AbortSignal.timeout(120000) }); j = await r.json(); }
    catch (err) { j = { error: { type: "no answer", message: String(err?.message || err) } }; }
    clearInterval(mining);
    check("a call still completes against an RPC that refuses a wide eth_getLogs: the session scan is bounded", r.status === 200 && j.status === "completed" && j.receipt?.executors?.length === 2, `${r.status} ${j.error?.type || ""} ${j.error?.message || ""}`.slice(0, 200));
    check("and it never asked for a span that RPC would refuse", seen.refused === 0 && seen.widest <= LIMIT, `widest ${seen.widest}, refused ${seen.refused}`); }
  // After inactivity both the beacon and host eligibility are cold. A live request drives the two-epoch recovery.
  await toBlock(8 * EPOCH + 12);
  check("the idle mesh has a cold epoch", !(await R.api("/epoch")).rolled);
  { const stream = await call("/v1/responses", { model: "warm", seed: 14, max_output_tokens: STEPS, stream: true });
    const text = stream.text();
    check("a cold request wakes through the task client's signature", await waitFor(async () => (await R.api("/status")).beacon.wakeUntil >= 10));
    check("the first waking epoch rolled", await enterEpoch(9));
    const e = await R.api("/epoch?mep=" + warm.mepId);
    for (const x of [A, B]) await x.svc.announce(warm.mep.mepId, H.unhex(e.challenge));
    check("both new residency claims arrived", await waitFor(async () => (await R.api("/status")).aggregators.find((x) => x.mep === warm.mepId).epochs.some((x) => x.epoch === 9 && x.claims === 2)));
    check("the second waking epoch rolled", await enterEpoch(10));
    check("the waking claims root was posted", await waitFor(async () => (await R.api("/status")).rootsPosted.some((x) => x.epoch === 9)));
    for (const x of [A, B]) await R.api("/tx/materialize", { mep: warm.mepId, epoch: 9, instance: x.addr });
    const frames = await text;
    check("cold stream stays alive, then posts and settles once hosts are eligible", /: waiting on the chain/.test(frames) && /event: response.created/.test(frames) && /event: response.completed/.test(frames) && !/event: response.failed/.test(frames));
  }
  // ---- health is whether it can do its job, and this is LAST because it takes the relayer away ----
  // A gateway with no relay connection cannot announce to anybody: it takes the call, spends the fee posting it on
  // chain, and refunds three minutes later. /healthz answered `ok: true` through exactly that, twice on the live
  // testnet, because `ok` was a constant.
  { const h = await (await fetch(GWY.url + "/healthz")).json();
    check("healthz reports the relay it cannot work without", h.ok === true && h.relay?.connected >= 1, JSON.stringify(h));
    await R.stop(); await H.sleep(2000); // the relayer goes away, as a redeploy does
    const live = await fetch(GWY.url + "/healthz"); const lb = await live.json();
    const ready = await fetch(GWY.url + "/readyz"); const rb = await ready.json();
    check("with no relay, readyz refuses: it cannot do the job", ready.status === 503 && rb.ok === false, `${ready.status} ${JSON.stringify(rb)}`);
    check("and it names the consequence, which is what an operator needs", /refunded/.test(rb.relay?.note || ""), JSON.stringify(rb.relay));
    // the platform restarts the process by this path, and restarting does not bring a relayer back
    check("but healthz still answers 200: a waiting gateway must not be killed for its relayer's outage",
      live.status === 200, `${live.status} ${JSON.stringify(lb)}`);
    check("while telling the same truth about the relay", lb.ok === false && lb.relay?.connected === 0 && /refunded/.test(lb.relay?.note || ""), JSON.stringify(lb.relay)); }

} catch (e) { console.error(e); fails++; }
finally { for (const f of stop.reverse()) try { await f(); } catch {} anvil.stop(); fs.rmSync(tmp, { recursive: true, force: true }); }
console.log(fails ? `${fails} FAILURES` : "gateway: all checks passed"); process.exit(fails ? 1 : 0);
