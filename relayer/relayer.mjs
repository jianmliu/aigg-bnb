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
const relay = await startRelay({ port: cfg.relayPort || 0, host: cfg.host || "127.0.0.1", name: cfg.name || "bnb-relayer" });
const relayKey = keypair(cfg.privateKey); const rc = new RelayClient([relay.url], relayKey); await rc.connect();
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
const status = { txs: [], errors: [], epochsRolled: [], rootsPosted: [], commits: [], reveals: [] };

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
    if (bn + BigInt(bcfg.commit) >= nextStart && bn < nextStart && !secrets.has(e + 1)) {
      const secret = hex(crypto.getRandomValues(new Uint8Array(32))); const h = keccak_256(new Uint8Array([...unhex(secret), ...unhex(ch.account.address)]));
      const r = await tx(`beacon.commit(${e + 1})`, (o) => ch.beacon.write.commit([hex(h)], { value: bcfg.deposit, ...o })); if (r.ok) { secrets.set(e + 1, secret); status.commits.push(e + 1); }
    }
    if (secrets.has(e) && bn >= start && bn < start + BigInt(bcfg.reveal)) {
      const c = await ch.beacon.read.commits([BigInt(e), ch.account.address]);
      if (!c[1]) { const r = await tx(`beacon.reveal(${e})`, (o) => ch.beacon.write.reveal([BigInt(e), secrets.get(e)], o)); if (r.ok) status.reveals.push(e); }
    }
  }
  // roll the epoch on the claim manager once its beacon exists
  const rolled = await ch.claims.read.beacon([BigInt(e)]);
  if (rolled === "0x" + "0".repeat(64)) {
    const ready = beaconOn ? (await ch.beacon.read.beaconFor([BigInt(e)])) !== "0x" + "0".repeat(64) : true;
    if (ready) { const r = await tx(`claims.rollEpoch(${e})`, (o) => ch.claims.write.rollEpoch(o)); if (r.ok) status.epochsRolled.push(e); }
    else return; // nobody revealed for this epoch yet
  }
  // (2) aggregation: collect this epoch's claims; post the previous epoch's root at the start of the next epoch
  for (const [id, M] of meps) {
    const chal = await ch.claims.read.epochChallenge([BigInt(e), id]); aggregatorFor(id, e, chal);
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
const api = http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, "http://x"); if (req.method === "OPTIONS") return json(res, 204, {});
    if (u.pathname === "/deployment") return json(res, 200, { ...dep, relay: relay.url, relayer: ch.account.address, domains, epochBlocks: EPOCH_BLOCKS, meps: [...meps.keys()] });
    if (u.pathname === "/meps") return json(res, 200, [...meps.values()].map((M) => M.info));
    if (u.pathname === "/status") return json(res, 200, { block: lastBlock, epoch: lastEpoch, relay: relay.stats, nonce: nonceState, ...status, aggregators: [...meps].map(([id, M]) => ({ mep: id, epochs: [...M.aggregators].map(([ep, A]) => ({ epoch: ep, claims: A.claims.size, rejected: A.rejected.length, posted: M.posted.has(ep) })) })) });
    if (u.pathname === "/epoch") { const id = (u.searchParams.get("mep") || "").toLowerCase(); const e = Number(await ch.claims.read.currentEpoch()); const b = await ch.claims.read.beacon([BigInt(e)]);
      return json(res, 200, { epoch: e, block: await ch.pub.getBlockNumber(), beacon: b, rolled: b !== "0x" + "0".repeat(64), challenge: id ? await ch.claims.read.epochChallenge([BigInt(e), id]) : null }); }
    if (u.pathname === "/proof") { const id = (u.searchParams.get("mep") || "").toLowerCase(), e = Number(u.searchParams.get("epoch")), inst = u.searchParams.get("instance"); const M = meps.get(id); const A = M && M.aggregators.get(e); const p = A && A.proofFor(inst);
      return p ? json(res, 200, { ...p.payload, aggregator: ch.account.address, posted: M.posted.has(e) }) : json(res, 404, { error: "no proof (not included, unknown epoch, or root not built)" }); }
    if (req.method !== "POST") return json(res, 404, { error: "not found" });
    const b = await body(req);
    if (u.pathname === "/tx/delegate") { if (!(await isBonded(b.instance))) return json(res, 403, { error: "instance not bonded" });
      return json(res, 200, await tx(`instances.delegateBySig(${b.instance.slice(0, 10)})`, (o) => ch.instances.write.delegateBySig([b.instance, b.session, BigInt(b.expiry), b.sig], o))); }
    if (u.pathname === "/tx/materialize") { const id = b.mep.toLowerCase(); const M = meps.get(id); const A = M && M.aggregators.get(Number(b.epoch)); const p = A && A.proofFor(b.instance);
      if (!p) return json(res, 404, { error: "no proof" }); if (!M.posted.has(Number(b.epoch))) return json(res, 409, { error: "root not posted yet" });
      const l = p.payload.leaf; return json(res, 200, await tx(`claims.materializeClaim(${b.instance.slice(0, 10)}, ${b.epoch})`, (o) => ch.claims.write.materializeClaim([id, BigInt(b.epoch), ch.account.address, BigInt(p.payload.index), { instance: l.instance, partialsRoot: l.partialsRoot, coverageBytes: BigInt(l.coverageBytes), deviceId: l.deviceId, execDigest: l.execDigest, stimulusSeed: l.stimulusSeed, signature: l.signature }, p.payload.proof], o))); }
    if (u.pathname === "/tx/result") { const signer = await ch.instances.read.resolve([b.signer]); if (signer === "0x0000000000000000000000000000000000000000") return json(res, 403, { error: "signer not bonded/delegated" });
      return json(res, 200, await tx(`market.submitResult(${b.taskId.slice(0, 10)})`, (o) => ch.market.write.submitResult([b.taskId, { execDigest: b.execDigest, execRoot: b.execRoot }, b.signature], o))); }
    if (u.pathname === "/tx/settle") return json(res, 200, await tx(`market.settle(${b.taskId.slice(0, 10)})`, (o) => ch.market.write.settle([b.taskId], o)));
    json(res, 404, { error: "not found" });
  } catch (e) { json(res, 500, { error: String(e.shortMessage || e.message) }); }
});
await new Promise((r) => api.listen(cfg.apiPort || 0, cfg.host || "127.0.0.1", r));
log(`relayer ${ch.account.address}: relay ${relay.url}, api http://${cfg.host || "127.0.0.1"}:${api.address().port}, chain ${dep.chainId}, epoch ${EPOCH_BLOCKS} blocks, beacon ${beaconOn ? "commit-reveal" : "prevrandao"}, meps ${[...meps.keys()].map((m) => m.slice(0, 10)).join(",")}`);
if (process.send) process.send({ relay: relay.url, api: `http://${cfg.host || "127.0.0.1"}:${api.address().port}` });
const loop = async () => { try { await tick(); } catch (e) { status.errors.push({ label: "tick", msg: String(e.shortMessage || e.message).slice(0, 200) }); log("tick error", String(e.shortMessage || e.message).slice(0, 160)); } };
await loop(); setInterval(loop, cfg.pollMs || 2000);
