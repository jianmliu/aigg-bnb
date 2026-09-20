// The gateway (docs/GATEWAY.md), milestones 0-1: a brain behind an OpenAI-compatible inference API.
//
// A request names a model (a MEP), a seed, a number of steps and an experiment; the gateway is the on-chain client
// that turns it into a task: capacity check -> postTask (its own BNB) -> announce to the sortitioned tabs over the
// relay -> wait for their sponsored results -> settle -> answer with a READOUT and a RECEIPT. The readout is not taken
// on trust: an int-lif executor hands back every neuron's spike count when asked, the settled execDigest IS
// keccak(n ‖ those counts), and only a vector that hashes to it is ever served (§1.2).
//
//   POST /v1/responses          { model, input, seed?, max_output_tokens?, redundancy?, stream?, background? }   (also /responses)
//                               input: { stimulate?, silence?, readout?, seed?, steps?, redundancy? } -- see plan()
//   GET  /v1/responses/{id}     the call, with its finality re-read from the chain
//   GET  /v1/models             served MEPs with providers / votes / available / price
//   GET  /v1/tasks/{id}/counts  the verified spike counts of a settled call: little-endian u32, one per neuron
//   POST /v1/chat/completions   a thin, non-streaming alias
//
// It is NOT part of the relayer: it holds money (GATEWAY_KEY pays every fee), and the relayer's key never should.
// The key is a float, topped up from a treasury that is not online.
//
//   GATEWAY_KEY            the fee wallet (secret). Its address must be in the relayer's PORW_TASK_CLIENTS, or the
//                          executors' results are not sponsored and a tab's session key has no gas of its own
//   GATEWAY_BEARER         what callers present (secret). Unset refuses to start, unless GATEWAY_OPEN=1
//   GATEWAY_RELAYER        the relayer's HTTP API: /meps, the relay's URL, and (without PORW_* here) the deployment
//   PORW_*                 the deployment, as for the relayer. When set, the relayer's /deployment must agree on the
//                          market: the gateway does not send money to an address an HTTP endpoint told it
//   GATEWAY_MODELS         "alias=0xmepId,alias=0xmepId": the names callers use. `mep:0x…` always works
//   GATEWAY_SETS           a JSON file of named id sets, { "joLR": [ids…] }, for `stimulate` / `silence`
//   GATEWAY_MIN_REDUNDANCY (2) GATEWAY_WEI_PER_STEP (100000000000) GATEWAY_DEFAULT_STEPS (100) GATEWAY_MAX_STEPS (20000)
//   GATEWAY_STATE          the calls, on disk: a fee is spent at postTask, so a call has to survive a restart
//   GATEWAY_KEEP           (5000) how many finished calls stay readable; unfinished ones are never dropped. Their counts
//                          (~0.5 MB a call at FlyWire's size) live beside the state file and go with them
//   GATEWAY_COUNTS_WAIT_MS (15000) a provider replies AFTER it has submitted on-chain, so a task can settle before its
//                          counts arrive: how long to wait for a vector that matches the settled digest
//   GATEWAY_PORT / PORT, GATEWAY_HOST, GATEWAY_KEEPALIVE_MS (20000), GATEWAY_RESULT_TIMEOUT_MS (600000), GATEWAY_POLL_MS (1000)
import http from "node:http"; import fs from "node:fs"; import path from "node:path"; import crypto from "node:crypto"; import { EventEmitter } from "node:events"; import { fileURLToPath } from "node:url";
import { parseAbi, parseAbiItem, decodeEventLog, keccak256, encodeAbiParameters } from "viem";
import { loadEnv, deploymentFromEnv } from "../relayer/env.mjs"; import { clients } from "../relayer/chain.mjs";
import { state0Root } from "./state0.mjs";
const here = path.dirname(fileURLToPath(import.meta.url)); const porw = (f) => import(path.join(here, "../contracts/lib/aigg-porw/web/porw-browser", f));
const { keypair } = await porw("claim.js"); const { RelayClient } = await porw("relay_client.js"); const V = await porw("verify.js"); const L = await porw("lif.js");

{ const i = process.argv.indexOf("--env"); loadEnv(i >= 0 ? process.argv[i + 1] : process.env.PORW_ENV_FILE); }
const e = process.env; const num = (k, d) => (e[k] ? Number(e[k]) : d);
const cfg = { key: e.GATEWAY_KEY, bearer: e.GATEWAY_BEARER || null, open: e.GATEWAY_OPEN === "1", relayer: (e.GATEWAY_RELAYER || "").replace(/\/$/, ""),
  minRedundancy: num("GATEWAY_MIN_REDUNDANCY", 2), weiPerStep: BigInt(e.GATEWAY_WEI_PER_STEP || "100000000000"), defaultSteps: num("GATEWAY_DEFAULT_STEPS", 100), maxSteps: num("GATEWAY_MAX_STEPS", 20000),
  state: e.GATEWAY_STATE || path.join(process.cwd(), "gateway-state.json"), port: num("GATEWAY_PORT", num("PORT", 8790)), host: e.GATEWAY_HOST || "127.0.0.1",
  keep: num("GATEWAY_KEEP", 5000), countsWaitMs: num("GATEWAY_COUNTS_WAIT_MS", 15000), keepAliveMs: num("GATEWAY_KEEPALIVE_MS", 20000), resultTimeoutMs: num("GATEWAY_RESULT_TIMEOUT_MS", 600000), pollMs: num("GATEWAY_POLL_MS", 1000),
  aliases: Object.fromEntries((e.GATEWAY_MODELS || "").split(",").map((kv) => kv.split("=").map((s) => s.trim())).filter((kv) => kv.length === 2 && kv[0]).map(([k, v]) => [k, v.toLowerCase()])),
  sets: e.GATEWAY_SETS ? JSON.parse(fs.readFileSync(e.GATEWAY_SETS, "utf8")) : {} };
if (!cfg.key) throw new Error("GATEWAY_KEY: the wallet that pays the fees");
if (!cfg.relayer) throw new Error("GATEWAY_RELAYER: the relayer's HTTP API");
if (!cfg.bearer && !cfg.open) throw new Error("GATEWAY_BEARER is not set: anybody could spend the fee wallet. (GATEWAY_OPEN=1 says that is intended.)");
if (cfg.minRedundancy < 1) throw new Error("GATEWAY_MIN_REDUNDANCY >= 1");

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a); const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const relayerApi = async (p) => { const r = await fetch(cfg.relayer + p); if (!r.ok) throw new Error(`relayer ${p}: HTTP ${r.status}`); return r.json(); };
const published = await relayerApi("/deployment"); const dep = deploymentFromEnv() || published;
if (dep.addresses.market.toLowerCase() !== published.addresses.market.toLowerCase() || Number(dep.chainId) !== Number(published.chainId)) throw new Error(`the relayer at ${cfg.relayer} serves another deployment (market ${published.addresses.market} on chain ${published.chainId}) than PORW_* names`);
const ch = clients(dep, cfg.key); const ME = ch.account.address.toLowerCase();
// what the gateway reads that the relayer does not: the stored task (for finality), the timeout, and a dispute opening at settle
const MarketExtra = parseAbi(["function TASK_TIMEOUT() view returns (uint64)", "event DisputeOpened(bytes32 indexed taskId, address a, address b)",
  "event TaskSettled(bytes32 indexed taskId, bytes32 execDigest, address[] executors)",
  "struct Task { bytes32 mepId; uint32 stimulusSeed; uint32 steps; uint32 commitStride; bytes32 initStateRoot; uint256 fee; uint64 deadline; uint8 redundancy; }",
  "function tasks(bytes32) view returns (Task t, address client, uint64 epoch, uint64 postedAt, uint64 settledAt, bool exists, bool settled, bool disputed, bool repudiated)"]);
const market = dep.addresses.market; const readMarket = (functionName, args = []) => ch.pub.readContract({ address: market, abi: MarketExtra, functionName, args });
const blockNumber = () => ch.pub.getBlockNumber({ cacheTime: 0 }); // viem remembers the head for seconds; a timeout and a challenge window are counted in blocks
const TASK_TIMEOUT = Number(await readMarket("TASK_TIMEOUT")); const CHALLENGE_WINDOW = Number(await ch.market.read.challengeWindow());
if (published.taskClients && !published.taskClients.includes(ME)) log(`WARNING: ${ME} is not in the relayer's PORW_TASK_CLIENTS (${published.taskClients.join(", ")}): executors' results will not be sponsored, and a tab's session key holds no gas`);
const relay = new RelayClient([published.relay], keypair(cfg.key)); await relay.connect();

// ---- the calls, on disk ----
const calls = new Map(); const bus = new Map(); // id -> call; id -> EventEmitter (only while somebody is listening or it is running)
const save = () => { const tmp = cfg.state + ".tmp"; fs.writeFileSync(tmp, JSON.stringify([...calls.values()], null, 1), { mode: 0o600 }); fs.renameSync(tmp, cfg.state); };
if (fs.existsSync(cfg.state)) for (const c of JSON.parse(fs.readFileSync(cfg.state, "utf8"))) calls.set(c.id, c);
const emit = (c, type, data = {}) => { c.events.push({ type, at: Date.now(), ...data }); save(); bus.get(c.id)?.emit("event", { type, ...data }); };
const TERMINAL = new Set(["completed", "failed"]);
// spike counts, beside the state file: bytes as the executor sent them (LE u32 per neuron), one file per call, written
// only once they have hashed to the digest the task settled on
const countsDir = cfg.state + ".counts"; const countsFile = (id) => path.join(countsDir, id + ".bin");
const DT_MS = 0.1; // one int-lif step (aigg-porw LifRowCheck: DT_TAU_M_Q16 = 0.1 ms / 20 ms)

// ---- models ----
let served = { at: 0, list: [] };
async function models() { if (Date.now() - served.at > 5000) served = { at: Date.now(), list: await relayerApi("/meps") }; return served.list; }
const namesOf = (m) => [...Object.entries(cfg.aliases).filter(([, id]) => id === m.mepId).map(([k]) => k), ...(m.token != null ? [`fly-${m.token}`] : []), `mep:${m.mepId}`];
async function resolveModel(name) { const want = String(name || "").toLowerCase(); const id = cfg.aliases[name] || (want.startsWith("mep:") ? want.slice(4) : null);
  return (await models()).find((m) => (id ? m.mepId === id : namesOf(m).some((n) => n.toLowerCase() === want))) || null; }
async function capacity(mepId) { const epoch = await ch.claims.read.currentEpoch(); const votes = (await ch.instances.read.eligibleVotes([mepId, epoch])).map((a) => a.toLowerCase());
  return { epoch: Number(epoch), votes: votes.length, providers: new Set(votes).size, beacon: BigInt(await ch.claims.read.beacon([epoch])) !== 0n }; }

// ---- a request -> a task ----
class Refusal extends Error { constructor(status, type, message, extra = {}) { super(message); this.status = status; this.type = type; this.extra = extra; } }
/** `input`: the experiment as an object, as JSON text, or as the Responses API's message list whose last user text is that JSON */
function experimentOf(input) {
  if (input == null || input === "") return {};
  if (Array.isArray(input)) { const u = [...input].reverse().find((m) => m && (m.role === "user" || m.role == null)); const c = u?.content;
    input = typeof c === "string" ? c : Array.isArray(c) ? c.map((p) => p?.text ?? "").join("") : ""; }
  if (typeof input === "string") { if (!input.trim()) return {}; try { input = JSON.parse(input); } catch { throw new Refusal(400, "invalid_request_error", "input is an experiment, as JSON: { stimulate?, silence?, readout? } (docs/GATEWAY.md §1.1)"); } }
  if (typeof input !== "object") throw new Refusal(400, "invalid_request_error", "input is an experiment, as JSON"); return input;
}
function idsOf(spec, what) {
  if (spec == null) return null; let ids = spec.ids;
  if (spec.set != null) { ids = cfg.sets[spec.set]?.payloadIndices || cfg.sets[spec.set]; if (!Array.isArray(ids)) throw new Refusal(400, "invalid_request_error", `${what}.set "${spec.set}" is not a set this gateway knows (${Object.keys(cfg.sets).join(", ") || "it knows none"})`); }
  if (spec.cell_type != null) throw new Refusal(400, "invalid_request_error", `${what}.cell_type needs the atlas's cell-type table, which this gateway does not carry yet; pass ids`);
  if (!Array.isArray(ids) || !ids.every((i) => Number.isInteger(i) && i >= 0)) throw new Refusal(400, "invalid_request_error", `${what} takes { ids: [neuron indices] } or { set: name }`);
  return [...new Set(ids)].sort((a, b) => a - b); // what is announced is what was hashed: sorted, once each
}
async function plan(body) {
  const m = await resolveModel(body.model); if (!m) throw new Refusal(404, "model_not_found", `no served brain is called "${body.model}" (GET /v1/models)`);
  const lif = m.exec === "int-lif"; const x = experimentOf(body.input); const stimulate = idsOf(x.stimulate, "stimulate"), silence = idsOf(x.silence, "silence");
  if (!lif && (stimulate || silence)) throw new Refusal(400, "invalid_request_error", `${m.exec} takes a seed only: stimulate / silence are int-lif's`);
  if ((body.n ?? 1) !== 1) throw new Refusal(400, "invalid_request_error", "n > 1 is a batch, which is not in this milestone");
  // seed, steps and redundancy may also ride INSIDE the experiment, and there they win. Through ai.gg a caller of
  // /v1/chat/completions has every top-level field it does not know dropped (`seed`), `max_tokens` floored at 128, and on
  // the non-passthrough path `max_output_tokens` deleted outright; the message text is the one thing that arrives intact.
  const steps = x.steps ?? body.max_output_tokens ?? body.max_tokens ?? body.max_completion_tokens ?? cfg.defaultSteps; const cap = lif ? cfg.maxSteps : Math.min(512, cfg.maxSteps);
  if (!Number.isInteger(steps) || steps < 1 || steps > cap) throw new Refusal(400, "invalid_request_error", `max_output_tokens is the number of steps: an integer in 1 … ${cap} for ${m.exec}`);
  const seed = x.seed ?? body.seed ?? 0; if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) throw new Refusal(400, "invalid_request_error", "seed is a uint32");
  const redundancy = x.redundancy ?? body.redundancy ?? cfg.minRedundancy; if (!Number.isInteger(redundancy) || redundancy < cfg.minRedundancy || redundancy > 16) throw new Refusal(400, "invalid_request_error", `redundancy is ${cfg.minRedundancy} … 16: fewer than ${cfg.minRedundancy} providers is not a result anybody agreed on`);
  // nothing is spent before this: a brain with too few eligible hosts is COLD, and the caller is told so
  const cap0 = await capacity(m.mepId);
  if (cap0.providers < redundancy) throw new Refusal(503, "model_cold", `${cap0.providers} eligible provider(s) for this brain, ${redundancy} needed: nobody is hosting it right now`, { providers: cap0.providers, retry_after: 60 });
  if (!cap0.beacon) throw new Refusal(503, "epoch_cold", `epoch ${cap0.epoch} has no beacon yet: the network is waking up`, { retry_after: 30 });
  // int-lif commits a state root per segment: ten segments a run (what the gate task uses), inside the market's bounds (<= 512 of each)
  const commitStride = lif ? Math.min(512, Math.max(1, Math.ceil(steps / 10), Math.ceil(steps / 512))) : 1;
  let init = null; if (lif) try { init = state0Root(m.neurons, seed, stimulate, silence); } catch (err) { if (err instanceof RangeError) throw new Refusal(400, "invalid_request_error", err.message); throw err; }
  const fee = BigInt(steps) * BigInt(redundancy) * cfg.weiPerStep; const block = await blockNumber();
  // the float ran dry: say so before the chain does, and in a way the operator's alerting can tell from a cold model
  const funds = await ch.pub.getBalance({ address: ME }); if (funds < fee + await gasHeadroom(redundancy)) throw new Refusal(503, "gateway_unfunded", "the gateway's fee wallet cannot cover this call: it needs topping up", { retry_after: 300 });
  const task = { mepId: m.mepId, stimulusSeed: seed, steps, commitStride, initStateRoot: init ? V.hex(init.root) : "0x" + "00".repeat(32), fee, deadline: block + BigInt(TASK_TIMEOUT), redundancy };
  // what to read out: named neurons, or (asked for nothing) the ten that fired most. Checked now, while refusing is free
  let readout = null; if (x.readout != null) { if (!lif) throw new Refusal(400, "invalid_request_error", `${m.exec} has no spike counts to read out`);
    if (x.readout.top != null) { if (!Number.isInteger(x.readout.top) || x.readout.top < 1 || x.readout.top > 1000) throw new Refusal(400, "invalid_request_error", "readout.top is 1 … 1000"); readout = { top: x.readout.top }; }
    else { const ids = idsOf(x.readout, "readout"); const bad = ids.find((i) => i >= m.neurons); if (bad !== undefined) throw new Refusal(400, "invalid_request_error", `readout id ${bad} is not a neuron of this brain (0 … ${m.neurons - 1})`); readout = { ids }; } }
  return { m, task, stimulate, silence, stimulated: init?.stimulated ?? null, readout };
}

// ---- the life of a call (docs/GATEWAY.md §2) ----
// What has to be left after the fee: this call's two transactions at today's gas price, twice over. Measured on BSC testnet
// and anvil: postTask ~197k gas at redundancy 1, settle ~126k at 1 and ~152k at 2 -- both grow with the executors drawn.
// (It was a constant, 2M gas at 5 gwei = 0.01 BNB: some three hundred times what a call costs at 0.1 gwei.)
const callGas = (redundancy) => 200_000n + 40_000n * BigInt(redundancy) + 100_000n + 30_000n * BigInt(redundancy);
const gasHeadroom = async (redundancy) => 2n * callGas(redundancy) * await ch.pub.getGasPrice();
let sending = Promise.resolve(); // one wallet, one nonce sequence: sends are serialised
const send = (fn) => { const p = sending.then(fn); sending = p.catch(() => {}); return p; };
const TASK_TUPLE = [{ type: "tuple", components: [{ name: "mepId", type: "bytes32" }, { name: "stimulusSeed", type: "uint32" }, { name: "steps", type: "uint32" }, { name: "commitStride", type: "uint32" }, { name: "initStateRoot", type: "bytes32" }, { name: "fee", type: "uint256" }, { name: "deadline", type: "uint64" }, { name: "redundancy", type: "uint8" }] }, { type: "bytes32" }];
const taskIdOf = (t, nonce) => keccak256(encodeAbiParameters(TASK_TUPLE, [t, nonce]));
const SESSION = parseAbiItem("event SessionKeySet(address indexed instance, address indexed session, uint64 expiry)");
async function sessionOf(wallet) { const logs = await ch.pub.getLogs({ address: dep.addresses.instances, event: SESSION, args: { instance: wallet }, fromBlock: 0n }); const block = await blockNumber();
  const live = logs.filter((l) => BigInt(l.args.expiry) > block); if (!live.length) throw new Error("no live session key"); return live.at(-1).args.session.toLowerCase(); }
/** the executors the chain drew, or none: `executors` reverts for a task that does not exist, and that is an answer here */
const executorsOf = async (id) => { try { return (await ch.market.read.executors([id])).map((x) => x.toLowerCase()); } catch { return []; } };
const wire = (t) => ({ ...t, fee: String(t.fee), deadline: String(t.deadline) }); const unwire = (t) => ({ ...t, fee: BigInt(t.fee), deadline: BigInt(t.deadline) });

function create(p, body) {
  const nonce = "0x" + crypto.randomBytes(32).toString("hex"); const id = taskIdOf(p.task, nonce);
  const c = { id, created_at: Math.floor(Date.now() / 1000), status: "queued", model: body.model, mepId: p.m.mepId, exec: p.m.exec, task: wire(p.task), nonce,
    stimulate: p.stimulate, silence: p.silence, stimulated: p.stimulated, readout: p.readout, executors: [], results: {}, events: [], error: null, receipt: null };
  calls.set(id, c); const finished = [...calls.values()].filter((x) => TERMINAL.has(x.status)); for (const old of finished.slice(0, Math.max(0, finished.length - cfg.keep))) { calls.delete(old.id); fs.rmSync(countsFile(old.id), { force: true }); } // oldest first: a Map keeps insertion order
  save(); return c; // the INTENT is on disk before a wei moves: the id is the task's, so a restart can tell whether it was posted
}
async function drive(c) {
  try {
    const task = unwire(c.task); let ex = await executorsOf(c.id);
    if (!ex.length) { // not on the chain yet: post it -- or, after a restart, wait for the transaction that was already sent
      if (!c.post_tx) { c.post_tx = await send(() => ch.market.write.postTask([task, c.nonce], { value: task.fee })); save(); }
      const rc = await ch.pub.waitForTransactionReceipt({ hash: c.post_tx }); if (rc.status !== "success") throw new Error("postTask reverted");
      ex = await executorsOf(c.id);
    }
    c.executors = ex; c.status = "in_progress"; const stored = await readMarket("tasks", [c.id]); c.posted_at = Number(stored[3]);
    emit(c, "response.created", { executors: ex }); log(`task ${c.id.slice(0, 12)}… ${c.model}: ${task.steps} steps, fee ${task.fee} wei, executors ${ex.map((a) => a.slice(0, 8)).join(", ")}`);
    // announce to each executor's session inbox; it runs, signs, and hands the result to the relayer, which pays for submitResult
    const announce = { taskId: c.id, stimulusSeed: task.stimulusSeed, steps: task.steps, commitStride: task.commitStride, ...(c.exec === "int-lif" ? { initStateRoot: task.initStateRoot, counts: true } : {}), ...(c.stimulate ? { stimulusIds: c.stimulate } : {}), ...(c.silence ? { silenceIds: c.silence } : {}) };
    // The replies are progress, not the condition: what settles a task is what is ON THE CHAIN, so nothing below waits for them.
    const offered = new Map(); // executor -> the bytes it says are the spike counts, kept only if they hash to the digest IT signed
    const replies = ex.filter((x) => !c.results[x]?.execRoot || c.exec === "int-lif").map(async (a) => { let r;
      try { const got = await relay.request(await sessionOf(a), "task-announce", c.mepId, announce, { timeoutMs: cfg.resultTimeoutMs, responseType: "result" }); r = { execDigest: got.payload.execDigest, execRoot: got.payload.execRoot };
        if (typeof got.payload.counts === "string" && got.payload.countsEncoding === "u32le-base64") { const bytes = new Uint8Array(Buffer.from(got.payload.counts, "base64"));
          r.counts = bytes.length % 4 === 0 && V.hex(L.countsDigest(new Uint32Array(bytes.buffer, bytes.byteOffset, bytes.length / 4))) === r.execDigest.toLowerCase() ? "match the digest it signed" : "DO NOT match the digest it signed";
          if (r.counts.startsWith("match")) offered.set(a, bytes); } }
      catch (err) { r = { error: String(err?.message || err).slice(0, 200) }; }
      if (!TERMINAL.has(c.status)) { c.results[a] = r; emit(c, "response.in_progress", { executor: a, ...r }); } });
    // settle when every executor's result is on-chain, or when the market's timeout lets anybody settle without them
    for (;;) { const s = await Promise.all(ex.map((a) => ch.market.read.submitted([c.id, a]))); if (s.every(Boolean)) break;
      if (Number(await blockNumber()) > c.posted_at + TASK_TIMEOUT) break; await sleep(cfg.pollMs); }
    const hash = await send(() => ch.market.write.settle([c.id])); c.settle_tx = hash; save(); const rc = await ch.pub.waitForTransactionReceipt({ hash }); if (rc.status !== "success") throw new Error("settle reverted");
    const evs = rc.logs.filter((l) => l.address.toLowerCase() === market.toLowerCase()).map((l) => { try { return decodeEventLog({ abi: MarketExtra, data: l.data, topics: l.topics }); } catch { return null; } }).filter(Boolean);
    const settled = evs.find((x) => x.eventName === "TaskSettled"), dispute = evs.find((x) => x.eventName === "DisputeOpened");
    for (const a of ex) if (!c.results[a]?.execRoot && await ch.market.read.submitted([c.id, a])) { const [execDigest, execRoot] = await ch.market.read.resultOf([c.id, a]); c.results[a] = { execDigest, execRoot }; } // a reply that did not reach us; the chain has it
    // The gas of the call's two transactions, as spent -- from their receipts, not an estimate. It is billed as the call's
    // INPUT tokens: gas wei / wei per step, rounded up, so a token of either kind is worth the same. A call that fails
    // (refunded, disputed) is not billed at all; its gas is the gateway's.
    const post = await ch.pub.getTransactionReceipt({ hash: c.post_tx }); const gasWei = post.gasUsed * post.effectiveGasPrice + rc.gasUsed * rc.effectiveGasPrice;
    const gas = { post_task: Number(post.gasUsed), settle: Number(rc.gasUsed), wei: String(gasWei), tokens: Number((gasWei + cfg.weiPerStep - 1n) / cfg.weiPerStep) };
    const base = { chain: Number(dep.chainId), market, task: c.id, post_tx: c.post_tx, settle_tx: hash, fee_wei: c.task.fee, gas, redundancy: task.redundancy, steps: task.steps, commit_stride: task.commitStride, seed: task.stimulusSeed, init_state_root: task.initStateRoot,
      stimulate_ids: c.stimulate, silence_ids: c.silence, stimulated: c.stimulated, results: c.results };
    if (dispute) { c.receipt = { ...base, executors: ex, disputed: [dispute.args.a, dispute.args.b].map((a) => a.toLowerCase()) }; return fail(c, 502, "disputed", "the executors disagreed and the task is in dispute: nothing is billed, and the fee is held until the dispute resolves"); }
    if (!settled || settled.args.executors.length === 0) { c.receipt = { ...base, executors: [], refunded: true }; return fail(c, 504, "no_result", "no executor answered before the market's timeout: the fee was refunded, nothing is billed"); }
    const at = Number((await readMarket("tasks", [c.id]))[4]);
    // The output. A provider replies after it has submitted, so the task may have settled first: wait a little for a vector
    // that hashes to the SETTLED digest. One is enough, whoever sent it -- the digest is what the providers agreed on.
    const digest = settled.args.execDigest.toLowerCase(); const verified = () => [...offered].find(([a]) => c.results[a]?.execDigest?.toLowerCase() === digest);
    if (c.exec === "int-lif" && BigInt(digest) !== 0n) { let allIn = false; Promise.allSettled(replies).then(() => { allIn = true; }); const t0 = Date.now(); while (!verified() && !allIn && Date.now() - t0 < cfg.countsWaitMs) await sleep(100); }
    const got = c.exec === "int-lif" ? verified() : null; if (got) { fs.mkdirSync(countsDir, { recursive: true, mode: 0o700 }); fs.writeFileSync(countsFile(c.id), got[1]); }
    c.counts = c.exec !== "int-lif" ? { status: "none: " + c.exec + " has no spike counts" } : got ? { status: "verified", from: got[0], neurons: got[1].length / 4 }
      : { status: BigInt(digest) === 0n ? "unavailable: the providers agreed on the root and split on the digest, so there is no digest to check counts against" : "unavailable: no provider returned counts that hash to the settled digest" };
    c.receipt = { ...base, executors: settled.args.executors.map((a) => a.toLowerCase()), exec_digest: settled.args.execDigest, exec_root: c.results[settled.args.executors[0].toLowerCase()]?.execRoot ?? (await ch.market.read.resultOf([c.id, settled.args.executors[0]]))[1],
      settled_at: at, finality: CHALLENGE_WINDOW ? "settled" : "final", final_after_block: at + CHALLENGE_WINDOW,
      counts: c.counts, ...(got ? { counts_url: `/v1/tasks/${c.id}/counts` } : {}) };
    c.status = "completed"; emit(c, "response.completed"); log(`task ${c.id.slice(0, 12)}… settled: ${c.receipt.executors.length} paid, digest ${c.receipt.exec_digest.slice(0, 12)}…`);
  } catch (err) { fail(c, 500, "gateway_error", String(err?.shortMessage || err?.message || err).slice(0, 300)); }
  finally { setTimeout(() => bus.delete(c.id), 1000); }
}
function fail(c, status, type, message) { c.status = "failed"; c.error = { status, type, message }; emit(c, "response.failed", { error: c.error }); log(`task ${c.id.slice(0, 12)}… failed: ${type}`); }
function start(c) { bus.set(c.id, new EventEmitter()); drive(c); }

/** a settled result can still be challenged for a window of blocks, and the window restarts after a failed challenge: re-read it */
async function finality(c) {
  if (c.status !== "completed" || c.receipt.finality === "final" || c.receipt.finality === "repudiated") return;
  const t = await readMarket("tasks", [c.id]); const settledAt = Number(t[4]), disputed = t[7], repudiated = t[8]; const block = Number(await blockNumber());
  c.receipt.final_after_block = settledAt + CHALLENGE_WINDOW;
  c.receipt.finality = repudiated ? "repudiated" : disputed ? "challenged" : block > settledAt + CHALLENGE_WINDOW ? "final" : "settled"; save();
}
/** the verified counts of a call, or null: what is on disk was checked against the settled digest before it was written */
const countsOf = (c) => { try { const b = fs.readFileSync(countsFile(c.id)); return new Uint32Array(b.buffer, b.byteOffset, b.length / 4); } catch { return null; } };
function readoutOf(c) {
  const counts = c.counts?.status === "verified" ? countsOf(c) : null; if (!counts) return { readout: null, readout_status: c.counts?.status || "unavailable" };
  const seconds = c.task.steps * DT_MS / 1000; const row = (id) => ({ id, spikes: counts[id], hz: Math.round(counts[id] / seconds * 100) / 100 });
  let total = 0, active = 0; for (const n of counts) { total += n; if (n) active++; }
  const ids = c.readout?.ids || Array.from(counts.keys()).filter((i) => counts[i] > 0).sort((a, b) => counts[b] - counts[a] || a - b).slice(0, c.readout?.top || 10);
  return { readout: ids.map(row), readout_status: "verified: these counts hash to the digest the providers settled on", summary: { neurons: counts.length, active_neurons: active, total_spikes: total, steps: c.task.steps, dt_ms: DT_MS, simulated_ms: c.task.steps * DT_MS } };
}
/** the Responses API's object: the readout as the message, the receipt beside it */
function view(c) {
  const done = c.status === "completed"; const text = done ? JSON.stringify({ exec_digest: c.receipt.exec_digest, ...readoutOf(c) }) : null;
  return { id: c.id, object: "response", created_at: c.created_at, status: c.status, model: c.model, system_fingerprint: `${c.exec}:${c.mepId.slice(0, 18)}`,
    output: done ? [{ type: "message", id: "msg_" + c.id.slice(2, 26), status: "completed", role: "assistant", content: [{ type: "output_text", text, annotations: [] }] }] : [],
    // Two kinds of token, worth the same (wei_per_step each), so one price per token covers both:
    //   output: one step run by one provider -- the work, what the fee is proportional to (steps x redundancy)
    //   input:  the call's gas, spent posting and settling it -- a fixed cost per call, whatever its length
    // Nothing is billed for a call that did not complete (ai.gg drops all-zero usage).
    usage: { input_tokens: done ? gasTokensOf(c) : 0, output_tokens: done ? tokensOf(c) : 0, total_tokens: done ? gasTokensOf(c) + tokensOf(c) : 0, input_tokens_details: { cached_tokens: 0 } }, error: c.error, receipt: c.receipt, executors: c.executors };
}
const tokensOf = (c) => c.task.steps * c.task.redundancy; const gasTokensOf = (c) => c.receipt?.gas?.tokens ?? 0;
const done = (c) => new Promise((res) => { if (TERMINAL.has(c.status)) return res(); const b = bus.get(c.id); if (!b) return res(); const on = (ev) => { if (ev.type === "response.completed" || ev.type === "response.failed") { b.off("event", on); res(); } }; b.on("event", on); });

// ---- HTTP ----
const json = (res, status, body, headers = {}) => { res.writeHead(status, { "content-type": "application/json", ...headers }); res.end(JSON.stringify(body)); };
const refuse = (res, r) => json(res, r.status, { error: { type: r.type, message: r.message, ...r.extra } }, r.extra?.retry_after ? { "retry-after": String(r.extra.retry_after) } : {});
const readBody = (req) => new Promise((res, rej) => { let s = ""; req.on("data", (d) => { s += d; if (s.length > 4 << 20) { rej(new Refusal(413, "invalid_request_error", "body over 4 MiB")); req.destroy(); } }); req.on("end", () => { try { res(s ? JSON.parse(s) : {}); } catch { rej(new Refusal(400, "invalid_request_error", "the body is not JSON")); } }); req.on("error", rej); });
const authed = (req) => { if (!cfg.bearer) return true; const got = Buffer.from(String(req.headers.authorization || "")), want = Buffer.from("Bearer " + cfg.bearer); return got.length === want.length && crypto.timingSafeEqual(got, want); };

async function respond(req, res, body) {
  const c = create(await plan(body), body); start(c);
  if (body.background) return json(res, 200, view(c));
  if (!body.stream) { await done(c); return c.status === "completed" ? json(res, 200, view(c)) : json(res, c.error.status, { error: c.error, receipt: c.receipt, id: c.id }); }
  // a stream: the Responses API's events, and a comment line often enough that nothing in front of us calls the connection dead
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive", "x-accel-buffering": "no" });
  let seq = 0; const write = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: seq++, ...data })}\n\n`);
  // What ai.gg's relay does with a Responses stream decides three things here (aigg-src openai_gateway_service.go):
  //  - it HOLDS `response.created`, `response.in_progress` and comment lines until the first event that is not a preamble, so
  //    that it can still fail over silently. A caller behind it would see nothing for minutes and its proxy would hang up.
  //    `response.output_item.added` right after `created` opens the output, and every keep-alive after it goes straight through.
  //  - for a caller of /v1/chat/completions it builds the text from `response.output_text.delta` events ONLY -- it never
  //    reads the final response's output when streaming. So the answer is sent as one delta before `completed`.
  //  - usage is read from the terminal event's `response.usage`, and a stream with no terminal event is retried.
  const item = "msg_" + c.id.slice(2, 26); const opened = () => write("response.output_item.added", { output_index: 0, item: { type: "message", id: item, status: "in_progress", role: "assistant", content: [] } });
  const answer = () => { const v = view(c); const text = v.output[0].content[0].text; const part = { type: "output_text", text, annotations: [] };
    write("response.content_part.added", { item_id: item, output_index: 0, content_index: 0, part: { type: "output_text", text: "", annotations: [] } });
    write("response.output_text.delta", { item_id: item, output_index: 0, content_index: 0, delta: text }); write("response.output_text.done", { item_id: item, output_index: 0, content_index: 0, text });
    write("response.content_part.done", { item_id: item, output_index: 0, content_index: 0, part }); write("response.output_item.done", { output_index: 0, item: v.output[0] }); };
  const b = bus.get(c.id); const alive = setInterval(() => res.write(": waiting on the chain\n\n"), cfg.keepAliveMs);
  const on = (ev) => { if (ev.type === "response.in_progress") write(ev.type, { response: view(c), executor: ev.executor, result: c.results[ev.executor] });
    else { if (ev.type === "response.completed") answer(); write(ev.type, { response: view(c) }); if (ev.type === "response.created") opened(); }
    if (ev.type === "response.completed" || ev.type === "response.failed") { clearInterval(alive); b.off("event", on); res.end(); } };
  for (const ev of c.events) on(ev); if (!res.writableEnded) b.on("event", on); // nothing is missed between start() and here: events are on the call
  req.on("close", () => { clearInterval(alive); b.off("event", on); }); // the caller left; the task is paid for and runs on -- GET /v1/responses/{id}
}
const server = http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, "http://x"); const p = u.pathname.replace(/\/$/, "");
    if (req.method === "GET" && p === "/healthz") return json(res, 200, { ok: true, wallet: ME, chain: Number(dep.chainId), market, calls: calls.size });
    if (!authed(req)) return json(res, 401, { error: { type: "authentication_error", message: "Authorization: Bearer <the gateway's key>" } });
    if (req.method === "GET" && p === "/v1/models") {
      const data = await Promise.all((await models()).map(async (m) => { const k = await capacity(m.mepId); const [id, ...aka] = namesOf(m);
        return { id, object: "model", owned_by: m.collection || "mesh", aliases: aka, mep_id: m.mepId, name: m.name, exec: m.exec, neurons: m.neurons, synapses: m.synapses, royalty_bps: m.royaltyBps, collection: m.collection, token: m.token,
          providers: k.providers, votes: k.votes, available: k.providers >= cfg.minRedundancy && k.beacon, min_redundancy: cfg.minRedundancy, wei_per_step: String(cfg.weiPerStep) }; }));
      return json(res, 200, { object: "list", data });
    }
    if (req.method === "POST" && (p === "/v1/responses" || p === "/responses")) return await respond(req, res, await readBody(req)); // ai.gg relays to /v1/responses; its admin "test connection" posts to /responses
    const one = /^\/v1\/responses\/(0x[0-9a-fA-F]{64})$/.exec(p);
    if (req.method === "GET" && one) { const c = calls.get(one[1].toLowerCase()); if (!c) return json(res, 404, { error: { type: "not_found", message: "no such call" } }); await finality(c); return json(res, 200, view(c)); }
    const cnt = /^\/v1\/tasks\/(0x[0-9a-fA-F]{64})\/counts$/.exec(p);
    if (req.method === "GET" && cnt) { const c = calls.get(cnt[1].toLowerCase()); const ok = c && c.counts?.status === "verified" && fs.existsSync(countsFile(c.id));
      if (!ok) return json(res, 404, { error: { type: "not_found", message: c ? `no verified counts for this call (${c.counts?.status || c.status})` : "no such call" } });
      res.writeHead(200, { "content-type": "application/octet-stream", "x-exec-digest": c.receipt.exec_digest, "x-counts-encoding": "u32le", "x-neurons": String(c.counts.neurons) }); return res.end(fs.readFileSync(countsFile(c.id))); }
    if (req.method === "POST" && p === "/v1/chat/completions") { // a caller that reaches the adapter directly; ai.gg's gateway sends /v1/responses
      const b = await readBody(req); if (b.stream) throw new Refusal(400, "invalid_request_error", "stream /v1/responses instead: this alias is not streamed");
      const c = create(await plan({ ...b, input: b.messages, background: false }), b); start(c); await done(c); if (c.status !== "completed") return json(res, c.error.status, { error: c.error, receipt: c.receipt, id: c.id });
      const v = view(c); return json(res, 200, { id: c.id, object: "chat.completion", created: c.created_at, model: c.model, system_fingerprint: v.system_fingerprint, choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: v.output[0].content[0].text } }],
        usage: { prompt_tokens: 0, completion_tokens: v.usage.output_tokens, total_tokens: v.usage.output_tokens }, receipt: c.receipt });
    }
    json(res, 404, { error: { type: "not_found", message: "not found" } });
  } catch (err) { if (res.headersSent) return res.end(); if (err instanceof Refusal) return refuse(res, err); log("error:", err); json(res, 500, { error: { type: "gateway_error", message: String(err?.message || err).slice(0, 300) } }); }
});
server.listen(cfg.port, cfg.host, () => {
  const url = `http://${cfg.host}:${server.address().port}`; log(`gateway on ${url} · wallet ${ME} · chain ${dep.chainId} market ${market} · min redundancy ${cfg.minRedundancy} · ${cfg.weiPerStep} wei/step`);
  // a call that was cut off by a restart: a posted one is driven on (its fee is spent), an unposted one cost nothing and is dropped
  (async () => { for (const c of calls.values()) if (!TERMINAL.has(c.status)) {
    const posted = c.post_tx || (await executorsOf(c.id)).length > 0; // the id is the task's: the chain knows, whatever the file had time to record
    if (!posted) fail(c, 500, "gateway_restarted", "the gateway restarted before the task was posted: nothing was spent"); else { log(`resuming ${c.id.slice(0, 12)}…`); start(c); } } })();
  if (process.send) process.send({ url, wallet: ME });
});
for (const s of ["SIGINT", "SIGTERM"]) process.on(s, () => { try { relay.close(); } catch {} server.close(); process.exit(0); });
