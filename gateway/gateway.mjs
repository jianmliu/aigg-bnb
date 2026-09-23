import {recoverPost,admissionExpense,persistVrfPost,broadcastVrfPost} from './vrf-post.mjs';
import {AdmissionBudget} from './admission-budget.mjs';
import {CreditSweeper} from './credit-sweep.mjs';
import {VRF_MODE,ROUND_VRF_MODE,VrfAdmissionAbi,isVrfMode,advanceAdmission,readAdmission} from '../relayer/vrf-admission.mjs';
// The gateway (docs/GATEWAY.md), milestones 0-1 and 3: a brain behind an OpenAI-compatible inference API.
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
//   GATEWAY_LOG_WINDOW     (5000) the eth_getLogs span asked for at once, and GATEWAY_SESSION_LOOKBACK (400000) how
//                          far back a live session delegation is looked for: a public RPC refuses an unbounded scan
//   GATEWAY_MIN_REDUNDANCY (2) GATEWAY_WEI_PER_STEP (100000000000) GATEWAY_DEFAULT_STEPS (100) GATEWAY_MAX_STEPS (20000)
//   GATEWAY_PRICING        (gateway/pricing.json) what a run costs a host, measured: multipliers on the wei per step,
//                          per brain and per named stimulus set. A step is not a step: on one core the thirteen battery
//                          stimuli span 9.4x (0.23 s to 2.16 s, as the sparse ones barely wake the brain and two ignite
//                          it), and the >= 2-synapse export costs 1.54x the >= 5-synapse one. A single price per step
//                          would pay a host the same for nine times the work.
//   GATEWAY_STATE          the calls, on disk: a fee is spent at postTask, so a call has to survive a restart
//   GATEWAY_WAKE_TIMEOUT_MS (300000) maximum cold-capacity wait before a task is posted; SSE stays alive meanwhile
//   GATEWAY_KEEP           (5000) how many finished calls stay readable; unfinished ones are never dropped. Their counts
//                          (~0.5 MB a call at FlyWire's size) live beside the state file and go with them
//   GATEWAY_ROUND_CREDIT_SWEEP_MIN_WEI (1e15) withdraw accumulated market credits to the fee wallet in one transaction
//   GATEWAY_COUNTS_WAIT_MS (15000) a provider replies AFTER it has submitted on-chain, so a task can settle before its
//                          counts arrive: how long to wait for a vector that matches the settled digest
//   GATEWAY_PORT / PORT, GATEWAY_HOST, GATEWAY_KEEPALIVE_MS (20000), GATEWAY_RESULT_TIMEOUT_MS (600000), GATEWAY_POLL_MS (1000)
import http from "node:http"; import fs from "node:fs"; import path from "node:path"; import crypto from "node:crypto"; import { EventEmitter } from "node:events"; import { fileURLToPath } from "node:url";
import { parseAbi, parseAbiItem, decodeEventLog, keccak256, encodeAbiParameters } from "viem";
import {synchronousInbox,readFinalized,assignmentReady,verifyDeployment,verificationMode,normalizeSession,sessionExpired,waitForSession,acceptedSession} from "../relayer/synchronous.mjs";
import { loadEnv, deploymentFromEnv } from "../relayer/env.mjs"; import { clients } from "../relayer/chain.mjs";
import { wakeMessage } from "../relayer/wake.mjs";
import { readyCapacity, CapacityError, abortable } from "./capacity.mjs";
import { state0Root } from "./state0.mjs";
const here = path.dirname(fileURLToPath(import.meta.url)); const porw = (f) => import(path.join(here, "../contracts/lib/aigg-porw/web/porw-browser", f));
const { keypair } = await porw("claim.js"); const { RelayClient } = await porw("relay_client.js"); const V = await porw("verify.js"); const L = await porw("lif.js");

{ const i = process.argv.indexOf("--env"); loadEnv(i >= 0 ? process.argv[i + 1] : process.env.PORW_ENV_FILE); }
const e = process.env; const num = (k, d) => (e[k] ? Number(e[k]) : d);
const cfg = { key: e.GATEWAY_KEY, bearer: e.GATEWAY_BEARER || null, open: e.GATEWAY_OPEN === "1", relayer: (e.GATEWAY_RELAYER || "").replace(/\/$/, ""),
  minRedundancy: num("GATEWAY_MIN_REDUNDANCY", 2), weiPerStep: BigInt(e.GATEWAY_WEI_PER_STEP || "100000000000"), defaultSteps: num("GATEWAY_DEFAULT_STEPS", 100), maxSteps: num("GATEWAY_MAX_STEPS", 20000),
  state: e.GATEWAY_STATE || path.join(process.cwd(), "gateway-state.json"), port: num("GATEWAY_PORT", num("PORT", 8790)), host: e.GATEWAY_HOST || "127.0.0.1",
  wakeTimeoutMs: num("GATEWAY_WAKE_TIMEOUT_MS", 300000), keep: num("GATEWAY_KEEP", 5000), countsWaitMs: num("GATEWAY_COUNTS_WAIT_MS", 15000), keepAliveMs: num("GATEWAY_KEEPALIVE_MS", 20000), resultTimeoutMs: num("GATEWAY_RESULT_TIMEOUT_MS", 600000), pollMs: num("GATEWAY_POLL_MS", 1000),
  aliases: Object.fromEntries((e.GATEWAY_MODELS || "").split(",").map((kv) => kv.split("=").map((s) => s.trim())).filter((kv) => kv.length === 2 && kv[0]).map(([k, v]) => [k, v.toLowerCase()])),
  sets: e.GATEWAY_SETS ? JSON.parse(fs.readFileSync(e.GATEWAY_SETS, "utf8")) : {},
  // an eth_getLogs window a public RPC will actually answer, and how far back a live delegation is looked for
  logWindow: BigInt(num("GATEWAY_LOG_WINDOW", 5000)), sessionLookback: BigInt(num("GATEWAY_SESSION_LOOKBACK", 400000)),
  pricing: JSON.parse(fs.readFileSync(e.GATEWAY_PRICING || path.join(here, "pricing.json"), "utf8")) };
if (!cfg.key) throw new Error("GATEWAY_KEY: the wallet that pays the fees");
if (!cfg.relayer) throw new Error("GATEWAY_RELAYER: the relayer's HTTP API");
if (!cfg.bearer && !cfg.open) throw new Error("GATEWAY_BEARER is not set: anybody could spend the fee wallet. (GATEWAY_OPEN=1 says that is intended.)");
if (!Number.isSafeInteger(cfg.wakeTimeoutMs) || cfg.wakeTimeoutMs < 1 || cfg.wakeTimeoutMs > 3600000) throw new Error("GATEWAY_WAKE_TIMEOUT_MS must be 1 … 3600000");
if (cfg.minRedundancy < 1) throw new Error("GATEWAY_MIN_REDUNDANCY >= 1");
const sweepMin=BigInt(e.GATEWAY_ROUND_CREDIT_SWEEP_MIN_WEI||'1000000000000000');
if(sweepMin<=0n)throw Error('GATEWAY_ROUND_CREDIT_SWEEP_MIN_WEI must be positive');

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a); const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const relayerApi = async (p, signal = AbortSignal.timeout(10000)) => { const r = await fetch(cfg.relayer + p, { signal }); if (!r.ok) throw new Error(`relayer ${p}: HTTP ${r.status}`); return r.json(); };
const published = await relayerApi("/deployment"); const dep = deploymentFromEnv() || published;
if (dep.addresses.market.toLowerCase() !== published.addresses.market.toLowerCase() || Number(dep.chainId) !== Number(published.chainId)) throw new Error(`the relayer at ${cfg.relayer} serves another deployment (market ${published.addresses.market} on chain ${published.chainId}) than PORW_* names`);
if(verificationMode(dep)!==verificationMode(published))throw Error("relayer verification capability mismatch");
const ch = clients(dep, cfg.key);
const SYNCHRONOUS=await verifyDeployment(dep,()=>ch.market.read.protocolVersion(),()=>ch.market.read.admissionVersion()); const VRF=isVrfMode(verificationMode(dep)),ROUNDS=verificationMode(dep)===ROUND_VRF_MODE; const ME = ch.account.address.toLowerCase();
// what the gateway reads that the relayer does not: the stored task (for finality), the timeout, and a dispute opening at settle
const MarketExtra = parseAbi(["function TASK_TIMEOUT() view returns (uint64)", "event DisputeOpened(bytes32 indexed taskId, address a, address b)",
  "event TaskSettled(bytes32 indexed taskId, bytes32 execDigest, address[] executors)",
  "function credits(address token,address account) view returns (uint256)",
  "function withdrawCredit(address token,address payable recipient) returns (uint256)",
  "struct Task { bytes32 mepId; uint32 stimulusSeed; uint32 steps; uint32 commitStride; bytes32 initStateRoot; uint256 fee; uint64 deadline; uint8 redundancy; }",
  "function tasks(bytes32) view returns (Task t, address client, uint64 epoch, uint64 postedAt, uint64 settledAt, bool exists, bool settled, bool disputed, bool repudiated)"]);
const market = dep.addresses.market; const readMarket = (functionName, args = []) => ch.pub.readContract({ address: market, abi: MarketExtra, functionName, args });
const blockNumber = () => ch.pub.getBlockNumber({ cacheTime: 0 }); // viem remembers the head for seconds; a timeout and a challenge window are counted in blocks
const TASK_TIMEOUT = (SYNCHRONOUS?0:Number(await readMarket("TASK_TIMEOUT"))); const CHALLENGE_WINDOW = Number(await ch.market.read.challengeWindow());
if (published.taskClients && !published.taskClients.includes(ME)) log(`WARNING: ${ME} is not in the relayer's PORW_TASK_CLIENTS (${published.taskClients.join(", ")}): executors' results will not be sponsored, and a tab's session key holds no gas`);
const relay = new RelayClient([published.relay], keypair(cfg.key)); await relay.connect();

// ---- the calls, on disk ----
const admissionBudget=VRF?new AdmissionBudget(cfg.state+".admission.json",e.GATEWAY_VRF_ADMISSION_BUDGET_WEI||0):null;
const calls = new Map(); const bus = new Map(); // id -> call; id -> EventEmitter (only while somebody is listening or it is running)
const save = () => { const tmp = cfg.state + ".tmp"; fs.writeFileSync(tmp, JSON.stringify([...calls.values()], null, 1), { mode: 0o600 }); fs.renameSync(tmp, cfg.state); };
if (fs.existsSync(cfg.state)) for (const c of JSON.parse(fs.readFileSync(cfg.state, "utf8"))) calls.set(c.id, c);
let admissionRecovery=null;
function restoreRoundCharge(c,gross,charge){
  if(!c)return;
  let changed=false;
  if(!c.post_confirmed){c.post_confirmed=true;changed=true;}
  if(c.admission_fee_net_wei!==String(charge)){c.admission_fee_net_wei=String(charge);changed=true;}
  if(c.receipt){
    const fields={admission_fee_wei:String(charge),admission_deposit_wei:String(gross),admission_refund_wei:String(gross-charge),admission_fee_refundable:charge<gross};
    for(const [key,value] of Object.entries(fields))if(c.receipt[key]!==value){c.receipt[key]=value;changed=true;}
  }
  if(changed)save();
}
function recoverRoundAdmission() {
  if(!ROUNDS||admissionRecovery)return admissionRecovery;
  const run=(async()=>{
    // Only retained calls need a local-state repair; the durable ledger itself
    // is independent of pruning. Avoid walking the full lifetime ledger each minute.
    for(const c of calls.values()){
      const row=admissionBudget.entries[c.id];
      if(row&&typeof row==='object')restoreRoundCharge(c,BigInt(row.gross),BigInt(row.net));
    }
    for(const id of admissionBudget.pending){
      const row=admissionBudget.entries[id],c=calls.get(id);
      // reserve() happens before the signed post exists. A crash in that gap
      // cannot have posted this task, so repeated RPC scans cannot repair it.
      if(!c?.post_tx&&!c?.post_raw&&!c?.post_confirmed)continue;
      if(c.post_reverted)continue;
      try{
        const charge=await readFinalized(ch.pub,async options=>{
          const stored=await ch.pub.readContract({address:market,abi:MarketExtra,functionName:'tasks',args:[id],...options});
          if(!stored[5]||!stored[6])return null;
          const controller=await ch.market.read.admission([],options);
          return ch.pub.readContract({address:controller,abi:VrfAdmissionAbi,functionName:'admissionCharge',args:[id,'0x'+'00'.repeat(20)],...options});
        });
        if(charge===null)continue;
        const gross=BigInt(row);
        if(charge>gross)throw Error('round admission exceeds deposit');
        admissionBudget.reconcile(id,charge);
        restoreRoundCharge(c,gross,charge);
        sweepRoundCredits();
        log(`recovered round admission ${id.slice(0,12)}…: ${charge}/${gross} wei`);
      }catch(err){log(`round admission recovery deferred ${id.slice(0,12)}…: ${err?.shortMessage||err?.message||err}`);}
    }
  })();
  admissionRecovery=run;
  void run.finally(()=>{if(admissionRecovery===run)admissionRecovery=null;}).catch(()=>{});
  return run;
}
const emit = (c, type, data = {}) => { c.events.push({ type, at: Date.now(), ...data }); save(); bus.get(c.id)?.emit("event", { type, ...data }); };
const TERMINAL = new Set(["completed", "failed"]);
// spike counts, beside the state file: bytes as the executor sent them (LE u32 per neuron), one file per call, written
// only once they have hashed to the digest the task settled on
const countsDir = cfg.state + ".counts"; const countsFile = (id) => path.join(countsDir, id + ".bin");
const DT_MS = 0.1; // one int-lif step (aigg-porw LifRowCheck: DT_TAU_M_Q16 = 0.1 ms / 20 ms)

// ---- models ----
let served = { at: 0, list: [] };
async function models(signal) { if (Date.now() - served.at > 5000) served = { at: Date.now(), list: await relayerApi("/meps", signal) }; return served.list; }
const namesOf = (m) => [...Object.entries(cfg.aliases).filter(([, id]) => id === m.mepId).map(([k]) => k), ...(m.token != null ? [`fly-${m.token}`] : []), `mep:${m.mepId}`];
async function resolveModel(name, signal) { const want = String(name || "").toLowerCase(); const id = cfg.aliases[name] || (want.startsWith("mep:") ? want.slice(4) : null);
  return (await models(signal)).find((m) => (id ? m.mepId === id : namesOf(m).some((n) => n.toLowerCase() === want))) || null; }
/** How many TOKENS a call is: one token is GATEWAY_WEI_PER_STEP of work, and a step of a brain under a stimulus set
 *  costs `model_factor x set_factor` of them (pricing.json, measured). Everything is counted in this one unit -- the
 *  fee below is `tokens x wei_per_token`, and the gas is divided by the same number -- because a caller's bill is
 *  `price_per_token x tokens` and any factor that does not reach the token count is a factor somebody eats. */
function priceOf(m, setName) {
  const P = cfg.pricing; // by any name the model answers to (`mep:0x…` counts as the bare id), then the id itself
  const keys = [...namesOf(m).map((n) => n.replace(/^mep:/, "")), m.name, m.mepId].filter(Boolean);
  const byModel = keys.map((k) => P.models?.[k]).find((v) => v !== undefined) ?? 1, bySet = (setName != null ? P.sets?.[setName] : null) ?? P.default_set ?? 1;
  return { model_factor: byModel, set_factor: bySet, set: setName ?? null, wei_per_token: String(cfg.weiPerStep) };
}
const tokensFor = (steps, redundancy, price) => Math.max(1, Math.round(steps * redundancy * price.model_factor * price.set_factor));
async function capacity(mepId) { const epoch = await ch.claims.read.currentEpoch(); const votes = (await ch.instances.read.eligibleVotes([mepId, epoch])).map((a) => a.toLowerCase());
  let providers=new Set(votes);if(SYNCHRONOUS){const ready=await Promise.all([...providers].map(async a=>await ch.market.read.ready([a])?a:null));providers=new Set(ready.filter(Boolean));}
  return { epoch: Number(epoch), votes: votes.length, providers: providers.size, beacon: VRF || BigInt(await ch.claims.read.beacon([epoch])) !== 0n }; }

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
// Coalesce demand per epoch; signatures expire and a failed delivery can be retried.
let wakeEpoch = -1, wakePending = null;
async function wake(epoch) {
  if (!published.taskClients?.includes(ME)) return; // unrestricted sponsorship is not permission to wake as a task client
  if (wakeEpoch === epoch && wakePending) return wakePending;
  wakeEpoch = epoch;
  const pending = (async () => {
    const signature = await ch.account.signMessage({ message: wakeMessage(dep, published.relayer, epoch) });
    const r = await fetch(cfg.relayer + "/wake", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ client: ME, epoch, signature }), signal: AbortSignal.timeout(Math.min(cfg.wakeTimeoutMs, 10000)) });
    if (!r.ok) throw new Refusal(503, "wake_unavailable", "the relayer refused the task client's wake", { retry_after: 30 });
  })();
  wakePending = pending;
  try { await pending; } catch (e) { if (wakePending === pending) wakePending = null; throw e; }
}
async function prepare(body, options = {}) {
  const deadline = AbortSignal.timeout(cfg.wakeTimeoutMs);
  const signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline;
  let last = null;
  try { return await abortable(() => plan(body, { ...options, signal, onCapacity: (k) => { last = k; } }), signal); }
  catch (error) {
    if (options.signal?.aborted) throw options.signal.reason;
    if (deadline.aborted && !(error instanceof CapacityError)) throw new CapacityError(last?.beacon ? "model_cold" : "epoch_cold", last);
    throw error;
  }
}
async function plan(body, { signal, onCold, onCapacity } = {}) {
  const m = await resolveModel(body.model, signal); if (!m) throw new Refusal(404, "model_not_found", `no served brain is called "${body.model}" (GET /v1/models)`);
  if(SYNCHRONOUS&&!m.verificationSupport?.supported)throw new Refusal(503,"verification_unsupported","This exact model is not certified for synchronous verification; model residency remains available.");
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
  // int-lif commits a state root per segment: ten segments a run (what the gate task uses), inside the market's bounds (<= 512 of each)
  const commitStride = lif ? Math.min(512, Math.max(1, Math.ceil(steps / 10), Math.ceil(steps / 512))) : 1;
  let init = null; if (lif) try { init = state0Root(m.neurons, seed, stimulate, silence); } catch (err) { if (err instanceof RangeError) throw new Refusal(400, "invalid_request_error", err.message); throw err; }
  const price = priceOf(m, x.stimulate?.set ?? null); price.output_tokens = tokensFor(steps, redundancy, price);
  const fee = BigInt(price.output_tokens) * cfg.weiPerStep;
  const admissionFee=ROUNDS?await ch.pub.readContract({address:await ch.market.read.admission(),abi:VrfAdmissionAbi,functionName:'admissionFee',args:["0x"+"00".repeat(20)]}):VRF?await ch.market.read.admissionFee(["0x"+"00".repeat(20)]):0n;
  // the float ran dry: say so before the chain does, and in a way the operator's alerting can tell from a cold model
  const funds = await ch.pub.getBalance({ address: ME }); if (funds < fee + admissionFee + await gasHeadroom(redundancy)) throw new Refusal(503, "gateway_unfunded", "the gateway's fee wallet cannot cover this call: it needs topping up", { retry_after: 300 });
  // what to read out: named neurons, or (asked for nothing) the ten that fired most. Checked now, while refusing is free
  let readout = null; if (x.readout != null) { if (!lif) throw new Refusal(400, "invalid_request_error", `${m.exec} has no spike counts to read out`);
    if (x.readout.top != null) { if (!Number.isInteger(x.readout.top) || x.readout.top < 1 || x.readout.top > 1000) throw new Refusal(400, "invalid_request_error", "readout.top is 1 … 1000"); readout = { top: x.readout.top }; }
    else { const ids = idsOf(x.readout, "readout"); const bad = ids.find((i) => i >= m.neurons); if (bad !== undefined) throw new Refusal(400, "invalid_request_error", `readout id ${bad} is not a neuron of this brain (0 … ${m.neurons - 1})`); readout = { ids }; } }
  // Nothing is spent before this. A brain with too few eligible hosts is COLD and the caller is told so at once;
  // an epoch with no beacon is a network that is asleep, and this WAKES it and waits, because the caller asking is
  // the reason to wake. It gives up at GATEWAY_WAKE_TIMEOUT_MS with the same 503 it would have refused with.
  if(SYNCHRONOUS&&redundancy!==2)throw new Refusal(400,"invalid_request_error","synchronous verification requires exactly two executors");
  await readyCapacity({ read: () => capacity(m.mepId), wake, redundancy, timeoutMs: cfg.wakeTimeoutMs, pollMs: cfg.pollMs, signal, onCold, onCapacity });
  signal?.throwIfAborted();
  const block = await blockNumber();
  const task = { mepId: m.mepId, stimulusSeed: seed, steps, commitStride, initStateRoot: init ? V.hex(init.root) : "0x" + "00".repeat(32), fee, deadline: SYNCHRONOUS?0n:block + BigInt(TASK_TIMEOUT), redundancy };
  return { m, task, admissionFee:String(admissionFee), stimulate, silence, stimulated: init?.stimulated ?? null, readout, price };
}

// ---- the life of a call (docs/GATEWAY.md §2) ----
// What has to be left after the fee: this call's two transactions at today's gas price, twice over. Measured on BSC testnet
// and anvil: postTask ~197k gas at redundancy 1, settle ~126k at 1 and ~152k at 2 -- both grow with the executors drawn.
// (It was a constant, 2M gas at 5 gwei = 0.01 BNB: some three hundred times what a call costs at 0.1 gwei.)
const callGas = (redundancy) => 200_000n + 40_000n * BigInt(redundancy) + 100_000n + 30_000n * BigInt(redundancy);
const gasHeadroom = async (redundancy) => 2n * (VRF?16777216n:callGas(redundancy)) * await ch.pub.getGasPrice();
let sending = Promise.resolve(); // one wallet, one nonce sequence: sends are serialised
const send = (fn) => { const p = sending.then(fn); sending = p.catch(() => {}); return p; };
const roundCreditSweep=ROUNDS?new CreditSweeper({threshold:sweepMin,
  read:()=>ch.pub.readContract({address:market,abi:MarketExtra,functionName:'credits',args:['0x'+'00'.repeat(20),ch.account.address]}),
  withdraw:()=>send(()=>ch.wallet.writeContract({address:market,abi:MarketExtra,functionName:'withdrawCredit',args:['0x'+'00'.repeat(20),ch.account.address]})),
  wait:hash=>ch.pub.waitForTransactionReceipt({hash})}):null;
const sweepRoundCredits=()=>{if(roundCreditSweep)void roundCreditSweep.maybeSweep().then(hash=>{if(hash)log(`market credits swept: ${hash}`);}).catch(err=>log(`market credit sweep deferred: ${err?.shortMessage||err?.message||err}`));};
const TASK_TUPLE = [{ type: "tuple", components: [{ name: "mepId", type: "bytes32" }, { name: "stimulusSeed", type: "uint32" }, { name: "steps", type: "uint32" }, { name: "commitStride", type: "uint32" }, { name: "initStateRoot", type: "bytes32" }, { name: "fee", type: "uint256" }, { name: "deadline", type: "uint64" }, { name: "redundancy", type: "uint8" }] }, { type: "bytes32" }];
const taskIdOf = (t, nonce) => keccak256(encodeAbiParameters(TASK_TUPLE, [t, nonce]));
const SESSION = parseAbiItem("event SessionKeySet(address indexed instance, address indexed session, uint64 expiry)");
/** The executor's session key, which is the address its announcement has to be sent to.
 *
 *  The registry maps session -> instance, so the reverse is a log scan -- and on a live chain a public RPC simply
 *  refuses an unbounded one. That is how the mesh's first real call died: `fromBlock: 0` came back as an RPC error
 *  for both executors, nothing was announced, and the market refunded the fee at the timeout. An anvil node answers
 *  it happily, which is why every test passed. So the scan is bounded and runs NEWEST FIRST, which is also the
 *  right order: the newest live delegation is the one we want, so the first hit ends the search. */
// instance -> { session, expiry, scannedTo }: the newest live delegation seen, and the block we had read up to when we
// saw it. A host DELEGATES A FRESH KEY whenever it reconnects -- every page reload, every restart -- and the old one
// stays live for as long as its expiry says, days of it. So a cache that answers from an unexpired entry keeps
// announcing into a key nobody is listening on, and the host is drawn, silent, and unpaid until the old delegation
// finally lapses. The entry is therefore never trusted on its own: every call re-reads the few blocks since it was
// taken, which is one small query, and a newer delegation wins.
const sessions = new Map();
async function sessionOf(wallet,taskId) {
  if(SYNCHRONOUS)return synchronousInbox(ch,wallet,taskId);
  const inst = wallet.toLowerCase(); const block = await blockNumber();
  const newest = async (from, to) => (await ch.pub.getLogs({ address: dep.addresses.instances, event: SESSION, args: { instance: wallet }, fromBlock: from, toBlock: to }))
    .filter((l) => BigInt(l.args.expiry) > block).at(-1);
  const keep = (l, scannedTo) => { const s = { session: l.args.session.toLowerCase(), expiry: BigInt(l.args.expiry), scannedTo }; sessions.set(inst, s); return s.session; };

  const had = sessions.get(inst);
  if (had && had.expiry > block) { // still good -- unless a newer one has been delegated since we looked
    for (let from = had.scannedTo + 1n; from <= block; from += cfg.logWindow) {
      const to = from + cfg.logWindow - 1n > block ? block : from + cfg.logWindow - 1n;
      const l = await newest(from, to); if (l) return keep(l, to);
    }
    had.scannedTo = block; return had.session;
  }
  const floor = block > cfg.sessionLookback ? block - cfg.sessionLookback : 0n;
  for (let to = block; ; to -= cfg.logWindow) {
    const from = to - cfg.logWindow + 1n > floor ? to - cfg.logWindow + 1n : floor;
    const l = await newest(from, to); if (l) return keep(l, block);
    if (from <= floor) break;
  }
  throw new Error(`no live session key in the last ${cfg.sessionLookback} blocks`);
}
/** the executors the chain drew, or none: `executors` reverts for a task that does not exist, and that is an answer here */
const executorsOf = async (id) => { try { return (await ch.market.read.executors([id])).map((x) => x.toLowerCase()); } catch { return []; } };
const wire = (t) => ({ ...t, fee: String(t.fee), deadline: String(t.deadline) }); const unwire = (t) => ({ ...t, fee: BigInt(t.fee), deadline: BigInt(t.deadline) });

async function create(p, body) {
  const nonce = "0x" + crypto.randomBytes(32).toString("hex"); const id = SYNCHRONOUS?await ch.market.read.taskId([p.task,"0x"+"00".repeat(20),nonce,0,ch.account.address]):taskIdOf(p.task, nonce);
  const c = { id, created_at: Math.floor(Date.now() / 1000), status: "queued", model: body.model, mepId: p.m.mepId, exec: p.m.exec, task: wire(p.task), nonce,
    stimulate: p.stimulate, silence: p.silence, stimulated: p.stimulated, readout: p.readout, price: p.price || null, admission_fee_wei:p.admissionFee||"0", admission_txs:[], executors: [], results: {}, events: [], error: null, receipt: null };
  calls.set(id, c); const finished = [...calls.values()].filter((x) => TERMINAL.has(x.status)&&!(ROUNDS&&admissionBudget.pending.has(x.id))); for (const old of finished.slice(0, Math.max(0, finished.length - cfg.keep))) { calls.delete(old.id); fs.rmSync(countsFile(old.id), { force: true }); } // oldest first: a Map keeps insertion order; unreconciled round calls retain their recovery evidence
  save(); return c; // the INTENT is on disk before a wei moves: the id is the task's, so a restart can tell whether it was posted
}
async function drive(c, signal) {
  try {
    const task = unwire(c.task); let ex = await executorsOf(c.id);
    if(VRF&&!c.post_tx){const original=await recoverPost(ch,c.id,task,c.nonce);if(original){c.post_tx=original;c.post_confirmed=true;save();}else if(Object.hasOwn(admissionBudget.entries,c.id))throw Error('Uncertain admission reservation without persisted transaction; refusing a new broadcast');}
    if(VRF&&c.post_tx){
      if(c.post_raw)await send(()=>broadcastVrfPost(ch,c));
      const receipt=await ch.pub.waitForTransactionReceipt({hash:c.post_tx});if(receipt.status!=='success'){c.post_reverted=true;save();throw Error('postTask reverted');}c.post_confirmed=true;save();
    }
    if (!ex.length) { // not on the chain yet: post it -- or, after a restart, wait for the transaction that was already sent
      if (!c.post_tx) { c.post_tx = await send(async () => {
        signal?.throwIfAborted();
        if(SYNCHRONOUS&&Number(await ch.market.read.profileMaxInDegree([task.mepId]))===0)throw new Refusal(503,"verification_unsupported","This exact model is not certified for synchronous verification.");
        const k = await capacity(task.mepId);
        signal?.throwIfAborted();
        if (!k.beacon || k.providers < task.redundancy) throw new CapacityError(k.beacon ? "model_cold" : "epoch_cold", k);
        if(VRF){
          admissionBudget.reserve(c.id,BigInt(c.admission_fee_wei));
          await persistVrfPost(ch,c,task,save);return broadcastVrfPost(ch,c);
        }
        return ch.market.write.postTask([task, c.nonce], { value: task.fee+BigInt(c.admission_fee_wei||0) });
      }); save(); }
      const rc = await ch.pub.waitForTransactionReceipt({ hash: c.post_tx }); if (rc.status !== "success") {c.post_reverted=true;save();throw new Error("postTask reverted");}c.post_confirmed=true;save();
      ex = await executorsOf(c.id);
    }
    if(VRF){
      // A posted phase-6 task has no executors yet. Keep its original id/nonce across
      // restarts; never post a replacement to obtain another random draw.
      for(;;){
        const phase=await readFinalized(ch.pub,async options=>Number((await ch.market.read.sessionState([c.id],options))[0]));
        if(phase!==6&&phase!==0)break;
        c.verification={phase:6,admission:await readAdmission(ch,c.id)};save();
        const hash=await advanceAdmission(ch,c.id,send);
        if(hash){(c.admission_txs||=[]).push(hash);save();await ch.pub.waitForTransactionReceipt({hash});}
        await sleep(cfg.pollMs);
      }
      ex=await executorsOf(c.id);
    }
    c.executors = ex; c.status = "in_progress"; const stored = await readMarket("tasks", [c.id]); c.posted_at = Number(stored[3]);
    emit(c, "response.created", { executors: ex }); log(`task ${c.id.slice(0, 12)}… ${c.model}: ${task.steps} steps, fee ${task.fee} wei, executors ${ex.map((a) => a.slice(0, 8)).join(", ")}`);
    // announce to each executor's session inbox; it runs, signs, and hands the result to the relayer, which pays for submitResult
    const announce = { taskId: c.id, stimulusSeed: task.stimulusSeed, steps: task.steps, commitStride: task.commitStride, ...(c.exec === "int-lif" ? { initStateRoot: task.initStateRoot, counts: true } : {}), ...(c.stimulate ? { stimulusIds: c.stimulate } : {}), ...(c.silence ? { silenceIds: c.silence } : {}) };
    // The replies are progress, not the condition: what settles a task is what is ON THE CHAIN, so nothing below waits for them.
    const offered = new Map(); // executor -> the bytes it says are the spike counts, kept only if they hash to the digest IT signed
    const replies = ex.filter((x) => !c.results[x]?.execRoot || c.exec === "int-lif").map(async (a) => { let r;
      try { if(SYNCHRONOUS){for(;;){
        const [state,head,finalized]=await Promise.all([ch.market.read.sessionState([c.id]),blockNumber(),ch.pub.getBlock({blockTag:"finalized"})]);
        const decision=assignmentReady(normalizeSession(state),head,finalized.number,stored[3]);
        if(decision==='closed')return;if(decision==='ready')break;await sleep(cfg.pollMs);
      }} const got = await relay.request(await sessionOf(a,c.id), "task-announce", c.mepId, announce, { timeoutMs: cfg.resultTimeoutMs, responseType: "result" }); if(SYNCHRONOUS&&Number((await ch.market.read.sessionState([c.id]))[0])<2)throw Error("result arrived before both commitments"); r = { execDigest: got.payload.execDigest, execRoot: got.payload.execRoot };
        if (typeof got.payload.counts === "string" && got.payload.countsEncoding === "u32le-base64") { const bytes = new Uint8Array(Buffer.from(got.payload.counts, "base64"));
          r.counts = bytes.length % 4 === 0 && V.hex(L.countsDigest(new Uint32Array(bytes.buffer, bytes.byteOffset, bytes.length / 4))) === r.execDigest.toLowerCase() ? "match the digest it signed" : "DO NOT match the digest it signed";
          if (r.counts.startsWith("match")) offered.set(a, bytes); } }
      catch (err) { r = { error: String(err?.message || err).slice(0, 200) }; }
      if (!TERMINAL.has(c.status)) { c.results[a] = r; emit(c, "response.in_progress", { executor: a, ...r }); } });
    let hash=null,rc={gasUsed:0n,effectiveGasPrice:0n,logs:[]},settled=null,dispute=null;
    if(SYNCHRONOUS){
      const terminal=await waitForSession({
        read:()=>readFinalized(ch.pub,async options=>normalizeSession(await ch.market.read.sessionState([c.id],options))),block:blockNumber,sleep:()=>sleep(cfg.pollMs),
        onState:state=>{c.verification={phase:state.phase,commitDeadline:state.commitDeadline,revealDeadline:state.revealDeadline,totalDeadline:state.totalDeadline};save();},
        finalize:async()=>{
          // Another executor may close the session between observation and expiry.
          const latest=normalizeSession(await ch.market.read.sessionState([c.id]));
          if(!sessionExpired(latest,await blockNumber()))return null;
          hash=await send(()=>ch.market.write.expire([c.id]));c.settle_tx=hash;save();
          const receipt=await ch.pub.waitForTransactionReceipt({hash});if(receipt.status!=="success")throw Error("session expiry reverted");return receipt;
        },
      });
      rc=terminal.receipt||rc;
      if(terminal.outcome.accepted){const accepted=await readFinalized(ch.pub,options=>acceptedSession(ch.market,c.id,options));settled={args:accepted};}
    }else{
      // Legacy deployments retain their original result/settle behavior.
      for (;;) { const s = await Promise.all(ex.map((a) => ch.market.read.submitted([c.id, a]))); if (s.every(Boolean)) break;
        if (Number(await blockNumber()) > c.posted_at + TASK_TIMEOUT) break; await sleep(cfg.pollMs); }
      hash = await send(() => ch.market.write.settle([c.id])); c.settle_tx = hash; save(); rc = await ch.pub.waitForTransactionReceipt({ hash }); if (rc.status !== "success") throw new Error("settle reverted");
      const evs = rc.logs.filter((l) => l.address.toLowerCase() === market.toLowerCase()).map((l) => { try { return decodeEventLog({ abi: MarketExtra, data: l.data, topics: l.topics }); } catch { return null; } }).filter(Boolean);
      settled = evs.find((x) => x.eventName === "TaskSettled");dispute = evs.find((x) => x.eventName === "DisputeOpened");
    }
    for (const a of ex) if (!c.results[a]?.execRoot && await ch.market.read.submitted([c.id, a])) { const [execDigest, execRoot] = await ch.market.read.resultOf([c.id, a]); c.results[a] = { execDigest, execRoot }; } // a reply that did not reach us; the chain has it
    // The gas of the call's two transactions, as spent -- from their receipts, not an estimate. It is billed as the call's
    // INPUT tokens: gas wei / wei per step, rounded up, so a token of either kind is worth the same. A call that fails
    // (refunded, disputed) is not billed at all; its gas is the gateway's.
    const post = await ch.pub.getTransactionReceipt({ hash: c.post_tx }); let gasWei = post.gasUsed * post.effectiveGasPrice + rc.gasUsed * rc.effectiveGasPrice;
    let admissionGas=0n;for(const hash of c.admission_txs||[]){const r=await ch.pub.getTransactionReceipt({hash});admissionGas+=r.gasUsed;gasWei+=r.gasUsed*r.effectiveGasPrice;}
    const gas = { post_task: Number(post.gasUsed), settle: Number(rc.gasUsed), admission:Number(admissionGas), wei: String(gasWei), tokens: Number((gasWei + cfg.weiPerStep - 1n) / cfg.weiPerStep) };
    const admissionDeposit=BigInt(c.admission_fee_wei||0);
    const admissionCharged=ROUNDS?await readFinalized(ch.pub,async options=>ch.pub.readContract({address:await ch.market.read.admission([],options),abi:VrfAdmissionAbi,functionName:'admissionCharge',args:[c.id,"0x"+"00".repeat(20)],...options})):admissionDeposit;
    if(admissionCharged>admissionDeposit)throw Error('round admission exceeds deposit');
    if(ROUNDS){admissionBudget.reconcile(c.id,admissionCharged);restoreRoundCharge(c,admissionDeposit,admissionCharged);}
    const admissionRefund=admissionDeposit-admissionCharged;
    const base = { chain: Number(dep.chainId), market, task: c.id, post_tx: c.post_tx, settle_tx: hash, fee_wei: c.task.fee, admission_fee_wei:String(admissionCharged), admission_deposit_wei:String(admissionDeposit),admission_refund_wei:String(admissionRefund),admission_fee_refundable:admissionRefund>0n, total_escrow_wei:String(task.fee+admissionDeposit), gas, redundancy: task.redundancy, steps: task.steps, commit_stride: task.commitStride, seed: task.stimulusSeed, init_state_root: task.initStateRoot,
      stimulate_ids: c.stimulate, silence_ids: c.silence, stimulated: c.stimulated, price: c.price, results: c.results };
    if (dispute) { c.receipt = { ...base, executors: ex, disputed: [dispute.args.a, dispute.args.b].map((a) => a.toLowerCase()) }; return fail(c, 502, "disputed", "the executors disagreed and the task is in dispute: nothing is billed, and the fee is held until the dispute resolves"); }
    if (!settled || settled.args.executors.length === 0) { c.receipt = { ...base, executors: [], refunded: true }; return fail(c, 504, SYNCHRONOUS?"inconclusive":"no_result", SYNCHRONOUS?"verification ended inconclusively: execution fee and any round admission refund credited to the client":"no executor answered before the market's timeout: the fee was refunded, nothing is billed"); }
    const at = Number((await readMarket("tasks", [c.id]))[4]);
    // The output. A provider replies after it has submitted, so the task may have settled first: wait a little for a vector
    // that hashes to the SETTLED digest. One is enough, whoever sent it -- the digest is what the providers agreed on.
    const digest = settled.args.execDigest.toLowerCase(); const verified = () => [...offered].find(([a]) => c.results[a]?.execDigest?.toLowerCase() === digest);
    if (c.exec === "int-lif" && BigInt(digest) !== 0n) { let allIn = false; Promise.allSettled(replies).then(() => { allIn = true; }); const t0 = Date.now(); while (!verified() && !allIn && Date.now() - t0 < cfg.countsWaitMs) await sleep(100); }
    const got = c.exec === "int-lif" ? verified() : null;
    if(SYNCHRONOUS&&c.exec==="int-lif"&&!got)return fail(c,502,"output_unavailable","completed verification did not return output bytes matching the accepted digest; nothing is billed"); if (got) { fs.mkdirSync(countsDir, { recursive: true, mode: 0o700 }); fs.writeFileSync(countsFile(c.id), got[1]); }
    c.counts = c.exec !== "int-lif" ? { status: "none: " + c.exec + " has no spike counts" } : got ? { status: "verified", from: got[0], neurons: got[1].length / 4 }
      : { status: BigInt(digest) === 0n ? "unavailable: the providers agreed on the root and split on the digest, so there is no digest to check counts against" : "unavailable: no provider returned counts that hash to the settled digest" };
    c.receipt = { ...base, executors: settled.args.executors.map((a) => a.toLowerCase()), exec_digest: settled.args.execDigest, exec_root: SYNCHRONOUS ? settled.args.execRoot : (c.results[settled.args.executors[0].toLowerCase()]?.execRoot ?? (await ch.market.read.resultOf([c.id, settled.args.executors[0]]))[1]),
      settled_at: at, finality: CHALLENGE_WINDOW ? "settled" : "final", final_after_block: at + CHALLENGE_WINDOW,
      ...(SYNCHRONOUS?{verification:verificationMode(dep),assumption:"independently administered executors; local adjudication assumes an honest executor"}:{}),counts: c.counts, ...(got ? { counts_url: `/v1/tasks/${c.id}/counts` } : {}) };
    c.status = "completed"; emit(c, "response.completed"); log(`task ${c.id.slice(0, 12)}… settled: ${c.receipt.executors.length} paid, digest ${c.receipt.exec_digest.slice(0, 12)}…`);
  } catch (err) { fail(c, err.status || 500, err.type || "gateway_error", String(err?.shortMessage || err?.message || err).slice(0, 300)); }
  finally { sweepRoundCredits(); void recoverRoundAdmission(); setTimeout(() => bus.delete(c.id), 1000); }
}
function fail(c, status, type, message) { c.status = "failed"; c.error = { status, type, message }; emit(c, "response.failed", { error: c.error }); log(`task ${c.id.slice(0, 12)}… failed: ${type}`); }
function start(c, signal) { bus.set(c.id, new EventEmitter()); drive(c, signal); }

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
    //   output: the work -- steps x redundancy x the brain's factor x the stimulus set's (priceOf)
    //   input:  the call's gas, spent posting and settling it -- a fixed cost per call, whatever its length
    // Both are in the SAME unit (GATEWAY_WEI_PER_STEP a token), so one price per token bills a call at exactly what it
    // cost: fee = output_tokens x wei_per_token, gas = input_tokens x wei_per_token, and nothing is left behind.
    // Nothing is billed for a call that did not complete (ai.gg drops all-zero usage).
    usage: { input_tokens: done ? gasTokensOf(c) : 0, output_tokens: done ? tokensOf(c) : 0, total_tokens: done ? gasTokensOf(c) + tokensOf(c) : 0, input_tokens_details: { cached_tokens: 0 } }, protocol_expenses:{admission_fee_wei:admissionExpense(c),admission_refundable:!!c.receipt?.admission_fee_refundable,failed_call_payer:"gateway"}, error: c.error, receipt: c.receipt, executors: c.executors };
}
// the work, in tokens: steps x redundancy x the brain's factor x the stimulus set's. A call whose fee carries a factor
// its token count does not is a call the gateway pays for out of its own pocket.
const tokensOf = (c) => c.price?.output_tokens ?? c.task.steps * c.task.redundancy;
const admissionTokensOf=c=>Number((BigInt(admissionExpense(c))+cfg.weiPerStep-1n)/cfg.weiPerStep);
const gasTokensOf = (c) => (c.receipt?.gas?.tokens ?? 0)+admissionTokensOf(c);
const done = (c) => new Promise((res) => { if (TERMINAL.has(c.status)) return res(); const b = bus.get(c.id); if (!b) return res(); const on = (ev) => { if (ev.type === "response.completed" || ev.type === "response.failed") { b.off("event", on); res(); } }; b.on("event", on); });

// ---- HTTP ----
const json = (res, status, body, headers = {}) => { res.writeHead(status, { "content-type": "application/json", ...headers }); res.end(JSON.stringify(body)); };
const refuse = (res, r) => json(res, r.status, { error: { type: r.type, message: r.message, ...r.extra } }, r.extra?.retry_after ? { "retry-after": String(r.extra.retry_after) } : {});
const readBody = (req) => new Promise((res, rej) => { let s = ""; req.on("data", (d) => { s += d; if (s.length > 4 << 20) { rej(new Refusal(413, "invalid_request_error", "body over 4 MiB")); req.destroy(); } }); req.on("end", () => { try { res(s ? JSON.parse(s) : {}); } catch { rej(new Refusal(400, "invalid_request_error", "the body is not JSON")); } }); req.on("error", rej); });
const authed = (req) => { if (!cfg.bearer) return true; const got = Buffer.from(String(req.headers.authorization || "")), want = Buffer.from("Bearer " + cfg.bearer); return got.length === want.length && crypto.timingSafeEqual(got, want); };

async function respond(req, res, body) {
  // The caller's connection is the lifetime of the attempt BEFORE a fee is spent: it can leave while the gateway is
  // waking a cold epoch, and nothing should keep waiting for a caller that is gone. Once the task is posted the money
  // is spent and the call runs on regardless -- GET /v1/responses/{id} is how it is collected.
  const abort = new AbortController(); let alive = null, seq = 0, busRef = null, listener = null;
  const write = (type, data) => { if (!res.destroyed) res.write(`event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: seq++, ...data })}\n\n`); };
  // a stream: the Responses API's events, and a comment line often enough that nothing in front of us calls the connection dead
  const open = () => {
    if (res.headersSent || res.destroyed) return;
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive", "x-accel-buffering": "no" });
    res.flushHeaders?.();
    alive = setInterval(() => { if (!res.destroyed) res.write(": waiting on the chain\n\n"); }, cfg.keepAliveMs);
  };
  const cleanup = () => { clearInterval(alive); if (listener && busRef) busRef.off("event", listener); };
  res.on("close", () => { abort.abort(new Refusal(499, "request_cancelled", "caller disconnected before posting")); cleanup(); });
  try {
    // waking a cold epoch can take minutes, so a STREAMING caller is given its headers first: ai.gg holds preamble
    // events, but the keep-alive comments after the stream opens are what keep a proxy from hanging up on the wait.
    const p = await prepare(body, { signal: abort.signal, onCold: body.stream && !body.background ? open : undefined });
    abort.signal.throwIfAborted();
    const c = await create(p, body); start(c);
    if (body.background) return json(res, 200, view(c));
    if (!body.stream) { await done(c); if (res.destroyed) return; return c.status === "completed" ? json(res, 200, view(c)) : json(res, c.error.status, { error: c.error, receipt: c.receipt, id: c.id }); }
    open();
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
    busRef = bus.get(c.id);
    listener = (ev) => { if (ev.type === "response.in_progress") write(ev.type, { response: view(c), executor: ev.executor, result: c.results[ev.executor] });
      else { if (ev.type === "response.completed") answer(); write(ev.type, { response: view(c) }); if (ev.type === "response.created") opened(); }
      if (ev.type === "response.completed" || ev.type === "response.failed") { cleanup(); res.end(); } };
    for (const ev of c.events) listener(ev); if (!res.writableEnded && !res.destroyed) busRef.on("event", listener); // nothing is missed between start() and here: events are on the call
  } catch (error) {
    cleanup(); if (res.destroyed) return;
    if (!res.headersSent) throw error; // no stream was opened: the ordinary JSON refusal
    // the stream was already open (the wake was being waited on), so the refusal has to arrive as an event
    write("response.failed", { response: { id: null, object: "response", status: "failed", error: { status: error.status || 500, type: error.type || "gateway_error", message: error.message, ...error.extra }, usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 } } });
    res.end();
  }
}
const server = http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, "http://x"); const p = u.pathname.replace(/\/$/, "");
    // Two questions that are not the same question, and answering them on one endpoint was a mistake.
    //
    //   /healthz  is the ORCHESTRATOR's: is this process alive and worth keeping? Always 200 while it is running.
    //   /readyz   is everybody else's: can it actually do its job right now? 503 when it cannot.
    //
    // A gateway with no relay reaches no executor: it takes the call, spends a fee posting the task, and refunds at
    // the market's timeout. That is worth saying loudly -- but NOT on the path the platform restarts the process by.
    // Render health-checks /healthz, so a 503 there during a relayer outage would have it kill a gateway that is
    // working perfectly well and waiting, and killing it does not bring the relayer back. Both endpoints carry the
    // same relay facts; only the status code differs, and only /readyz is allowed to refuse.
    if (req.method === "GET" && (p === "/healthz" || p === "/readyz")) {
      const connected = relay.socks.filter((x) => x.open).length;
      const body = { ok: connected > 0, wallet: ME, chain: Number(dep.chainId), market, calls: calls.size,
        relay: { url: published.relay, connected, reconnects: relay.reconnects, ...(connected ? {} : { note: "no relay: a call would post its fee, reach no executor, and be refunded at the market's timeout" }) } };
      return json(res, p === "/readyz" && !connected ? 503 : 200, body);
    }
    if (!authed(req)) return json(res, 401, { error: { type: "authentication_error", message: "Authorization: Bearer <the gateway's key>" } });
    if (req.method === "GET" && p === "/v1/models") {
      const data = await Promise.all((await models()).map(async (m) => { const k = await capacity(m.mepId); const [id, ...aka] = namesOf(m);
        return { id, object: "model", owned_by: m.collection || "mesh", aliases: aka, mep_id: m.mepId, name: m.name, exec: m.exec, neurons: m.neurons, synapses: m.synapses, royalty_bps: m.royaltyBps, collection: m.collection, token: m.token,
          providers: k.providers, votes: k.votes, ...(SYNCHRONOUS?{verification_support:m.verificationSupport}:{}), available: (!SYNCHRONOUS||m.verificationSupport?.supported===true) && k.providers >= cfg.minRedundancy && k.beacon, min_redundancy: cfg.minRedundancy,
          // ONE unit, one price: a token is `wei_per_token` of work, and a step of this brain costs `tokens_per_step`
          // of them -- times a named stimulus set's factor, because a run that ignites the brain is nine times the work
          // of one that barely wakes it (gateway/pricing.json, measured). The differences are in the COUNT, so that a
          // single price per token bills each of them for what it actually cost.
          wei_per_token: String(cfg.weiPerStep), tokens_per_step: priceOf(m, null).model_factor, set_factors: cfg.pricing.sets || {} }; }));
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
      const abort = new AbortController(); res.on("close", () => abort.abort(new Refusal(499, "request_cancelled", "caller disconnected before posting")));
      const c = await create(await prepare({ ...b, input: b.messages, background: false }, { signal: abort.signal }), b); start(c, abort.signal); await done(c); if (c.status !== "completed") return json(res, c.error.status, { error: c.error, receipt: c.receipt, id: c.id });
      const v = view(c); return json(res, 200, { id: c.id, object: "chat.completion", created: c.created_at, model: c.model, system_fingerprint: v.system_fingerprint, choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: v.output[0].content[0].text } }],
        usage: { prompt_tokens: v.usage.input_tokens, completion_tokens: v.usage.output_tokens, total_tokens: v.usage.total_tokens }, receipt: c.receipt });
    }
    json(res, 404, { error: { type: "not_found", message: "not found" } });
  } catch (err) { if (res.headersSent) return res.end(); if (err instanceof Refusal || err instanceof CapacityError) return refuse(res, err); log("error:", err); json(res, 500, { error: { type: "gateway_error", message: String(err?.message || err).slice(0, 300) } }); }
});
server.listen(cfg.port, cfg.host, () => {
  const url = `http://${cfg.host}:${server.address().port}`; log(`gateway on ${url} · wallet ${ME} · chain ${dep.chainId} market ${market} · min redundancy ${cfg.minRedundancy} · ${cfg.weiPerStep} wei/step`);
  // a call that was cut off by a restart: a posted one is driven on (its fee is spent), an unposted one cost nothing and is dropped
  (async () => { for (const c of calls.values()) if (!TERMINAL.has(c.status)) {
    const posted = c.post_tx || (VRF ? (await readMarket("tasks",[c.id]))[5] : (await executorsOf(c.id)).length > 0); // the id is the task's: the chain knows, whatever the file had time to record
    if (!posted) fail(c, 500, "gateway_restarted", "the gateway restarted before the task was posted: nothing was spent"); else { log(`resuming ${c.id.slice(0, 12)}…`); start(c); } } })();
  sweepRoundCredits();
  void recoverRoundAdmission();
  if(ROUNDS)setInterval(()=>void recoverRoundAdmission(),60000).unref();
  if (process.send) process.send({ url, wallet: ME });
});
for (const s of ["SIGINT", "SIGTERM"]) process.on(s, () => { try { relay.close(); } catch {} server.close(); process.exit(0); });
