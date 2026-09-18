// The BNB relayer: one process = (1) the stage-1 WebSocket relay hub, (2) the epoch aggregator for the MEPs it
// serves (collects claims over the relay, posts one root per epoch), (3) a commit-reveal beacon participant and
// epoch roller, (4) a gas-sponsoring transaction submitter for bonded instances (delegateBySig, materializeClaim,
// submitResult, settle) — browser tabs hold session keys with no BNB, so someone must pay the gas; the relayer
// only sponsors calls that succeed in simulation and belong to a bonded instance.
//   source .env.<network> && node relayer/relayer.mjs        (addresses + PORW_RELAYER_KEY + PORW_MEP_IDS from env)
//   node relayer/relayer.mjs --env .env.bsc-testnet             (same, loading the env file itself)
//   node relayer/relayer.mjs --config relayer/config.json       (optional file for ports/names; env wins for addresses/keys)
// HTTP API (JSON): GET /deployment  GET /epoch?mep=0x..  GET /proof?mep&epoch&instance  GET /status
//                  POST /tx/delegate {instance,session,expiry,sig}  POST /tx/materialize {mep,epoch,instance}
//                  POST /tx/result {taskId,execDigest,execRoot,signature}  POST /tx/settle {taskId}
import fs from "node:fs"; import http from "node:http"; import path from "node:path"; import { fileURLToPath } from "node:url";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { clients, eip712Domains } from "./chain.mjs";
import { loadEnv, deploymentFromEnv, relayerFromEnv } from "./env.mjs";
const here = path.dirname(fileURLToPath(import.meta.url)); const porw = (f) => import(path.join(here, "../contracts/lib/aigg-porw/web/porw-browser/", f));
const { startRelay } = await porw("relay.js"); const { RelayClient } = await porw("relay_client.js"); const { Aggregator } = await porw("aggregator.js"); const { keypair } = await porw("claim.js"); const V = await porw("verify.js"); const { makeMep, EXEC_INT_SPMV_Q16 } = await porw("mep.js"); const { lifExecKind } = await porw("lif.js");

const args = Object.fromEntries(process.argv.slice(2).reduce((a, v, i, arr) => { if (v.startsWith("--")) a.push([v.slice(2), arr[i + 1]]); return a; }, []));
loadEnv(args.env || process.env.PORW_ENV_FILE);
const fileCfg = args.config || fs.existsSync(path.join(here, "config.json")) ? JSON.parse(fs.readFileSync(args.config || path.join(here, "config.json"), "utf8")) : {};
const envCfg = relayerFromEnv(); const cfg = { ...fileCfg, ...Object.fromEntries(Object.entries(envCfg).filter(([, v]) => v !== null)) };
// deployment: environment first (never in git), else the file named in the config (local anvil runs)
const dep = deploymentFromEnv() || (cfg.deployment ? JSON.parse(fs.readFileSync(path.resolve(here, "..", cfg.deployment), "utf8")) : null);
if (!dep) throw new Error("no deployment: source the .env.<network> from deploy.sh (PORW_* variables) or set config.deployment");
dep.rpc = process.env.PORW_RPC || cfg.rpc || dep.rpc; if (!dep.rpc) throw new Error("PORW_RPC (or config.rpc) required");
if (!cfg.privateKey) throw new Error("PORW_RELAYER_KEY (or config.privateKey) required"); if (!cfg.meps || !cfg.meps.length) throw new Error("PORW_MEP_IDS (or config.meps) required");
const ch = clients(dep, cfg.privateKey); const domains = eip712Domains(dep);
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const hex = (b) => "0x" + Array.from(b, (x) => x.toString(16).padStart(2, "0")).join(""); const unhex = (s) => Uint8Array.from(s.slice(2).match(/../g).map((h) => parseInt(h, 16)));

// ---- (1) relay hub + our own relay client (the aggregator listens through it) ----
// PORW_RELAY_PATH puts the hub on the API's own port under that path, because a single-port host routes one
// port per service; without it the hub takes a port of its own as before. Either way the client we run for the
// aggregator dials the local address, while browsers are told PORW_PUBLIC_RELAY_URL -- what we bound is an
// implementation detail and is wrong for anyone off this machine.
const HOST = cfg.host || "127.0.0.1";
const relayPath = cfg.relayPath || null;
const api = http.createServer();
const relay = await startRelay(relayPath ? { server: api, path: relayPath, name: cfg.name || "bnb-relayer" } : { port: cfg.relayPort || 0, host: HOST, name: cfg.name || "bnb-relayer" });
const relayKey = keypair(cfg.privateKey); let rc = null; let relayUrl = relay.url, publicRelayUrl = relay.url; // set once the port is known
// ---- MEPs served: read from chain, rebuild the MEP object the aggregator verifies claims against ----
const meps = new Map(); // mepId -> { mep, info, aggregators: Map(epoch -> Aggregator), posted: Set(epoch) }
for (const id of cfg.meps) {
  const m = await ch.meps.read.getMEP([id]);
  const isLif = m.execKind.toLowerCase() === hex(lifExecKind()).toLowerCase();
  const info = { mepId: id.toLowerCase(), modelId: m.modelId, execKind: m.execKind, exec: isLif ? "int-lif" : "int-spmv-q16", steps: Number(m.steps), clampQ16: Number(m.clampQ16), commitStride: isLif ? Number(m.clampQ16) : 1, neurons: Number(m.neurons), synapses: Number(m.synapses), synapseRoot: m.synapseRoot,
    weightsDA: (() => { try { return new TextDecoder().decode(unhex(m.weightsDA)); } catch { return m.weightsDA; } })(), name: (cfg.mepNames || {})[id] || (cfg.mepNames || {})[id.toLowerCase()] || null };
  const execKind = m.execKind.toLowerCase() === hex(lifExecKind()).toLowerCase() ? lifExecKind() : EXEC_INT_SPMV_Q16;
  const mep = makeMep({ name: id.slice(0, 10), modelId: unhex(m.modelId), steps: Number(m.steps), clampQ16: Number(m.clampQ16), execKind, commitStride: Number(m.clampQ16) });
  if (hex(mep.mepId).toLowerCase() !== id.toLowerCase()) throw new Error(`MEP ${id}: cannot reproduce mep_id (scheme/exec kind mismatch)`);
  meps.set(id.toLowerCase(), { mep, info, aggregators: new Map(), posted: new Set() });
}
const EPOCH_BLOCKS = Number(await ch.claims.read.EPOCH_BLOCKS());
const beaconOn = ch.beacon && (await ch.claims.read.beaconProvider()).toLowerCase() === dep.addresses.beacon.toLowerCase();
const bcfg = beaconOn ? { commit: Number(await ch.beacon.read.COMMIT_BLOCKS()), reveal: Number(await ch.beacon.read.REVEAL_BLOCKS()), deposit: await ch.beacon.read.DEPOSIT() } : null;
const secrets = new Map(); // epoch -> secret (bytes32)
const ZERO32 = "0x" + "0".repeat(64);
// Lazy beacon (PORW_BEACON_LAZY=1). Producing a beacon costs ~366k gas per epoch (commit + reveal + rollEpoch +
// one root) whether or not anybody is using the mesh, and an epoch's beacon is only ever consumed by that epoch's
// claims, sortition and audits -- so in lazy mode we commit for the next epoch only when there is demand: a
// verified claim collected in this epoch or the previous one, or a bonded instance that asked to be woken
// (POST /wake). A cold epoch simply never rolls and costs nothing. Spamming /wake cannot amplify the bill: the
// beacon fires at most once per epoch either way. The trade: a node arriving into a cold mesh waits one epoch for
// a beacon and a second to become eligible. Default off, so an existing deployment and the tests are unchanged.
const LAZY = cfg.beaconLazy === true;
const WAKE_EPOCHS = Number(cfg.wakeEpochs || 2);
let wakeUntil = -1;   // an epoch through which a /wake keeps us warm
let coldLogged = -1;  // last epoch whose skip was logged (tick runs every couple of seconds)
const status = { txs: [], errors: [], epochsRolled: [], rootsPosted: [], commits: [], reveals: [], beacon: { lazy: LAZY, warm: !LAZY, reason: LAZY ? "cold: nothing has asked for a beacon yet" : "eager", wakeUntil } };
/** is the epoch after e worth a beacon? */
function warmth(e) {
  if (!LAZY) return { warm: true, reason: "eager" };
  if (e + 1 <= wakeUntil) return { warm: true, reason: `woken through epoch ${wakeUntil}` };
  for (const M of meps.values()) for (const ep of [e, e - 1]) { const A = M.aggregators.get(ep); if (A && A.claims.size) return { warm: true, reason: `claims collected in epoch ${ep}` }; }
  return { warm: false, reason: "cold: no claims collected and no wake" };
}

// ---- transaction path: serialized, with a locally tracked PENDING nonce ----
// Public RPC pools can return a stale nonce right after a mined tx (seen on BSC testnet), so every send carries
// an explicit nonce from a local counter seeded from getTransactionCount(pending), sends are serialized, and a
// nonce error (stale / too low / already known) resyncs the counter from the chain and retries once.
const nonceState = { next: null, resyncs: 0, chain: null };
let txChain = Promise.resolve();
async function syncNonce() { nonceState.next = Number(await ch.pub.getTransactionCount({ address: ch.account.address, blockTag: "pending" })); nonceState.resyncs++; return nonceState.next; }
const isNonceError = (e) => /nonce/i.test(String(e.shortMessage || e.message || e)) || /already known|replacement transaction underpriced/i.test(String(e.details || ""));
function tx(label, fn) { // fn(opts) -> hash; opts carries the nonce
  const run = async () => {
    if (nonceState.next === null) await syncNonce();
    for (let attempt = 0; attempt < 2; attempt++) {
      const nonce = nonceState.next;
      try {
        const hash = await fn({ nonce }); nonceState.next = nonce + 1;
        const r = await ch.pub.waitForTransactionReceipt({ hash });
        status.txs.push({ label, hash, ok: r.status === "success", gas: Number(r.gasUsed), nonce }); log(label, hash.slice(0, 12), r.status, Number(r.gasUsed), "gas", "nonce", nonce); return { hash, ok: r.status === "success", gasUsed: Number(r.gasUsed) };
      } catch (e) {
        const msg = String(e.shortMessage || e.message).slice(0, 200);
        if (isNonceError(e) && attempt === 0) { const n = await syncNonce(); log(label, "nonce error, resynced to", n, "- retrying"); continue; }
        if (!isNonceError(e)) await syncNonce().catch(() => {}); // a revert may or may not have consumed the nonce: resync
        status.errors.push({ label, msg }); log(label, "FAILED", msg); return { ok: false, error: msg };
      }
    }
  };
  const p = txChain.then(run, run); txChain = p.catch(() => {}); return p; // serialize all sends
}
function aggregatorFor(id, epoch, challenge) {
  const M = meps.get(id); if (!M.aggregators.has(epoch)) { const A = new Aggregator(rc, M.mep, unhex(challenge), { epoch, domain: domains.claimManager, blockNumber: Number(lastBlock) }); A.stop = A.watch(); M.aggregators.set(epoch, A); }
  return M.aggregators.get(epoch);
}
let lastBlock = 0n, lastEpoch = -1;
async function tick() {
  const bn = await ch.pub.getBlockNumber(); lastBlock = bn; const e = Number(bn / BigInt(EPOCH_BLOCKS)); const start = BigInt(e) * BigInt(EPOCH_BLOCKS);
  // (3) beacon participation: commit for e+1 in the last COMMIT blocks of e; reveal for e in its first REVEAL blocks
  if (beaconOn) {
    const nextStart = start + BigInt(EPOCH_BLOCKS);
    const w = warmth(e); status.beacon = { lazy: LAZY, warm: w.warm, reason: w.reason, wakeUntil }; // every tick, so /status and /epoch always say why
    if (bn + BigInt(bcfg.commit) >= nextStart && bn < nextStart && !secrets.has(e + 1)) {
      if (!w.warm) { if (coldLogged !== e) { log(`epoch ${e + 1}: no beacon commit (${w.reason})`); coldLogged = e; } }
      else {
        const secret = hex(crypto.getRandomValues(new Uint8Array(32))); const h = keccak_256(new Uint8Array([...unhex(secret), ...unhex(ch.account.address)]));
        const r = await tx(`beacon.commit(${e + 1})`, (o) => ch.beacon.write.commit([hex(h)], { value: bcfg.deposit, ...o })); if (r.ok) { secrets.set(e + 1, secret); status.commits.push(e + 1); }
      }
    }
    if (secrets.has(e) && bn >= start && bn < start + BigInt(bcfg.reveal)) {
      const c = await ch.beacon.read.commits([BigInt(e), ch.account.address]);
      if (!c[1]) { const r = await tx(`beacon.reveal(${e})`, (o) => ch.beacon.write.reveal([BigInt(e), secrets.get(e)], o)); if (r.ok) status.reveals.push(e); }
    }
  }
  // roll the epoch on the claim manager once its beacon exists
  let rolled = (await ch.claims.read.beacon([BigInt(e)])) !== ZERO32;
  if (!rolled) {
    const ready = beaconOn ? (await ch.beacon.read.beaconFor([BigInt(e)])) !== ZERO32 : true;
    if (ready) { const r = await tx(`claims.rollEpoch(${e})`, (o) => ch.claims.write.rollEpoch(o)); if (r.ok) { status.epochsRolled.push(e); rolled = true; } }
  }
  // (2) aggregation: collect this epoch's claims once it is rolled -- but post the previous epoch's root either
  // way. An epoch with no beacon (nobody revealed, or a cold epoch under PORW_BEACON_LAZY) must not strand the
  // claims collected in the epoch before it: without that root nobody can materialize them.
  for (const [id, M] of meps) {
    if (rolled) { const chal = await ch.claims.read.epochChallenge([BigInt(e), id]); aggregatorFor(id, e, chal); }
    const prev = e - 1;
    if (prev >= 0 && M.aggregators.has(prev) && !M.posted.has(prev)) {
      const A = M.aggregators.get(prev); if (A.claims.size === 0) { M.posted.add(prev); continue; }
      const call = A.postRootCall(); const already = await ch.claims.read.epochRoots([id, BigInt(prev), ch.account.address]);
      if (already[0] === "0x" + "0".repeat(64)) { const r = await tx(`claims.postEpochRoot(${id.slice(0, 10)}, ${prev}, ${call.count} claims)`, (o) => ch.claims.write.postEpochRoot([id, BigInt(prev), call.root, BigInt(call.count)], o)); if (r.ok) { M.posted.add(prev); status.rootsPosted.push({ mep: id, epoch: prev, root: call.root, count: call.count }); } }
      else M.posted.add(prev);
      A.stop && A.stop(); // stop collecting for a closed epoch
    }
  }
  if (e !== lastEpoch) { log(`epoch ${e} (block ${bn})`); lastEpoch = e; }
}
// ---- (4) HTTP API ----
const json = (res, code, body) => { res.writeHead(code, { "content-type": "application/json", "access-control-allow-origin": "*", "access-control-allow-headers": "content-type" }); res.end(JSON.stringify(body, (k, v) => (typeof v === "bigint" ? v.toString() : v))); };
const body = (req) => new Promise((r) => { let s = ""; req.on("data", (c) => (s += c)); req.on("end", () => r(s ? JSON.parse(s) : {})); });
const isBonded = async (addr) => (await ch.instances.read.bonded([addr])) > 0n;
// ---- sponsorship guard ----
// Every /tx/* call spends the relayer's own BNB on somebody else's behalf, so each one must name a bonded
// instance to charge, must simulate successfully from the relayer's account (a reverted transaction still costs
// gas -- this is the guard the README always claimed and the code never had), and must fit inside a budget.
// Budgets are in gas: SPONSOR_EPOCH_GAS per instance per epoch stops one bonded instance from looping a call
// that simulates fine, and SPONSOR_DAY_GAS caps the whole relayer. Both are deliberately finite by default:
// an operator should raise them knowingly rather than inherit an unbounded wallet.
const SPONSOR_EPOCH_GAS = Number(cfg.sponsorEpochGas || 1_500_000);
const SPONSOR_DAY_GAS = Number(cfg.sponsorDayGas || 50_000_000);
const DAY_MS = 24 * 3600 * 1000;
const spend = new Map(); // instance -> { epoch, gas }
const day = { since: Date.now(), gas: 0 };
status.sponsor = { epochGasLimit: SPONSOR_EPOCH_GAS, dayGasLimit: SPONSOR_DAY_GAS, dayGas: 0, refused: [] };
function budget(instance) {
  const e = lastBlock === 0n ? 0 : Number(lastBlock / BigInt(EPOCH_BLOCKS));
  if (Date.now() - day.since >= DAY_MS) { day.since = Date.now(); day.gas = 0; }
  const s = spend.get(instance) || { epoch: e, gas: 0 };
  if (s.epoch !== e) { s.epoch = e; s.gas = 0; }
  spend.set(instance, s);
  if (day.gas >= SPONSOR_DAY_GAS) return { ok: false, why: `relayer daily sponsorship budget spent (${day.gas}/${SPONSOR_DAY_GAS} gas)` };
  if (s.gas >= SPONSOR_EPOCH_GAS) return { ok: false, why: `sponsorship budget for epoch ${e} spent by this instance (${s.gas}/${SPONSOR_EPOCH_GAS} gas)` };
  return { ok: true, charge: (g) => { s.gas += g; day.gas += g; status.sponsor.dayGas = day.gas; } };
}
const refuse = (res, code, label, why) => { status.sponsor.refused.push({ label, why, at: new Date().toISOString() }); if (status.sponsor.refused.length > 50) status.sponsor.refused.shift(); log(`${label} refused: ${why}`); return json(res, code, { error: why }); };
/** bonded instance -> budget -> simulation -> only then sign and send. Nothing is broadcast before all three pass. */
async function sponsored(res, instance, label, simulate, send) {
  if (!instance || !/^0x[0-9a-fA-F]{40}$/.test(instance)) return refuse(res, 400, label, "no instance to charge this call to");
  if (!(await isBonded(instance))) return refuse(res, 403, label, "instance not bonded");
  const inst = instance.toLowerCase();
  const bud = budget(inst); if (!bud.ok) return refuse(res, 429, label, bud.why);
  try { await simulate(); } catch (e) { return refuse(res, 400, label, "would revert: " + String(e.shortMessage || e.message).split("\n")[0].slice(0, 200)); }
  const r = await tx(label, send);
  if (r.gasUsed) bud.charge(r.gasUsed); // a revert that still got mined is charged too: it cost the relayer gas
  return json(res, 200, r);
}
api.on("request", async (req, res) => {
  try {
    const u = new URL(req.url, "http://x"); if (req.method === "OPTIONS") return json(res, 204, {});
    if (u.pathname === "/deployment") return json(res, 200, { ...dep, relay: publicRelayUrl, relayer: ch.account.address, domains, epochBlocks: EPOCH_BLOCKS, meps: [...meps.keys()] });
    if (u.pathname === "/meps") return json(res, 200, [...meps.values()].map((M) => M.info));
    if (u.pathname === "/status") return json(res, 200, { block: lastBlock, epoch: lastEpoch, relay: relay.stats, nonce: nonceState, ...status, aggregators: [...meps].map(([id, M]) => ({ mep: id, epochs: [...M.aggregators].map(([ep, A]) => ({ epoch: ep, claims: A.claims.size, rejected: A.rejected.length, posted: M.posted.has(ep) })) })) });
    if (u.pathname === "/epoch") { const id = (u.searchParams.get("mep") || "").toLowerCase(); const e = Number(await ch.claims.read.currentEpoch()); const b = await ch.claims.read.beacon([BigInt(e)]);
      return json(res, 200, { epoch: e, block: await ch.pub.getBlockNumber(), beacon: b, rolled: b !== ZERO32, lazy: LAZY, warm: status.beacon.warm, challenge: id ? await ch.claims.read.epochChallenge([BigInt(e), id]) : null }); }
    if (u.pathname === "/proof") { const id = (u.searchParams.get("mep") || "").toLowerCase(), e = Number(u.searchParams.get("epoch")), inst = u.searchParams.get("instance"); const M = meps.get(id); const A = M && M.aggregators.get(e); const p = A && A.proofFor(inst);
      return p ? json(res, 200, { ...p.payload, aggregator: ch.account.address, posted: M.posted.has(e) }) : json(res, 404, { error: "no proof (not included, unknown epoch, or root not built)" }); }
    if (req.method !== "POST") return json(res, 404, { error: "not found" });
    const b = await body(req);
    // a bonded instance saying it is here, so the lazy beacon keeps producing (see warmth()). The bonded check is
    // skipped while we are already warm through that epoch, so a tab polling once an epoch costs no RPC at all.
    if (u.pathname === "/wake") {
      if (lastBlock === 0n) return json(res, 503, { error: "no block seen yet" }); // the first tick has not run
      const e = Number(lastBlock / BigInt(EPOCH_BLOCKS)); // the last block a tick saw: up to one poll stale, which at
      // worst attributes a wake near an epoch boundary to the previous epoch. Harmless: WAKE_EPOCHS covers it and the
      // page wakes again next epoch. Deliberate -- a fresh read here would be an RPC call per polling tab.
      if (e + WAKE_EPOCHS > wakeUntil) { if (!(await isBonded(b.instance))) return json(res, 403, { error: "instance not bonded" }); wakeUntil = e + WAKE_EPOCHS; status.beacon.wakeUntil = wakeUntil; }
      return json(res, 200, { ok: true, lazy: LAZY, epoch: e, wakeUntil }); }
    if (u.pathname === "/tx/delegate") { const args = [b.instance, b.session, BigInt(b.expiry), b.sig];
      return sponsored(res, b.instance, `instances.delegateBySig(${String(b.instance).slice(0, 10)})`,
        () => ch.instances.simulate.delegateBySig(args, { account: ch.account }), (o) => ch.instances.write.delegateBySig(args, o)); }
    if (u.pathname === "/tx/materialize") { const id = String(b.mep).toLowerCase(); const M = meps.get(id); const A = M && M.aggregators.get(Number(b.epoch)); const p = A && A.proofFor(b.instance);
      if (!p) return json(res, 404, { error: "no proof" }); if (!M.posted.has(Number(b.epoch))) return json(res, 409, { error: "root not posted yet" });
      const l = p.payload.leaf; const args = [id, BigInt(b.epoch), ch.account.address, BigInt(p.payload.index), { instance: l.instance, partialsRoot: l.partialsRoot, coverageBytes: BigInt(l.coverageBytes), deviceId: l.deviceId, execDigest: l.execDigest, stimulusSeed: l.stimulusSeed, signature: l.signature }, p.payload.proof];
      return sponsored(res, b.instance, `claims.materializeClaim(${String(b.instance).slice(0, 10)}, ${b.epoch})`,
        () => ch.claims.simulate.materializeClaim(args, { account: ch.account }), (o) => ch.claims.write.materializeClaim(args, o)); }
    if (u.pathname === "/tx/result") { const signer = await ch.instances.read.resolve([b.signer]); if (signer === "0x0000000000000000000000000000000000000000") return json(res, 403, { error: "signer not bonded/delegated" });
      const args = [b.taskId, { execDigest: b.execDigest, execRoot: b.execRoot }, b.signature]; // charged to the instance the session key resolves to
      return sponsored(res, signer, `market.submitResult(${String(b.taskId).slice(0, 10)})`,
        () => ch.market.simulate.submitResult(args, { account: ch.account }), (o) => ch.market.write.submitResult(args, o)); }
    // settle is permissionless on-chain, so anyone may settle their own task by paying for it; the relayer only
    // sponsors it for a bonded instance, which is who benefits from the fee split anyway.
    if (u.pathname === "/tx/settle") { const args = [b.taskId];
      return sponsored(res, b.instance, `market.settle(${String(b.taskId).slice(0, 10)})`,
        () => ch.market.simulate.settle(args, { account: ch.account }), (o) => ch.market.write.settle(args, o)); }
    json(res, 404, { error: "not found" });
  } catch (e) { json(res, 500, { error: String(e.shortMessage || e.message) }); }
});
await new Promise((r) => api.listen(cfg.apiPort || 0, HOST, r));
const apiUrl = `http://${HOST}:${api.address().port}`;
if (relayPath) relayUrl = `ws://${HOST}:${api.address().port}${relayPath}`;
publicRelayUrl = cfg.publicRelayUrl || relayUrl;
rc = new RelayClient([relayUrl], relayKey, { onLog: (m) => log(m) }); await rc.connect();
log(`relayer ${ch.account.address}: relay ${relayUrl}${publicRelayUrl !== relayUrl ? ` (announced as ${publicRelayUrl})` : ""}, api ${apiUrl}, chain ${dep.chainId}, epoch ${EPOCH_BLOCKS} blocks, beacon ${beaconOn ? (LAZY ? "commit-reveal, lazy" : "commit-reveal") : "prevrandao"}, meps ${[...meps.keys()].map((m) => m.slice(0, 10)).join(",")}`);
if (process.send) process.send({ relay: publicRelayUrl, api: apiUrl });
const loop = async () => { try { await tick(); } catch (e) { status.errors.push({ label: "tick", msg: String(e.shortMessage || e.message).slice(0, 200) }); log("tick error", String(e.shortMessage || e.message).slice(0, 160)); } };
await loop(); setInterval(loop, cfg.pollMs || 2000);
