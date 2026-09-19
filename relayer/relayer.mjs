// The BNB relayer: one process = (1) the stage-1 WebSocket relay hub, (2) the epoch aggregator for the MEPs it
// serves (collects claims over the relay, posts one root per epoch), (3) a commit-reveal beacon participant and
// epoch roller, (4) a gas-sponsoring transaction submitter for bonded instances (delegateBySig, materializeClaim,
// submitResult, settle) — browser tabs hold session keys with no BNB, so someone must pay the gas; the relayer
// only sponsors calls that succeed in simulation and belong to a bonded instance.
//   source .env.<network> && node relayer/relayer.mjs        (addresses + PORW_RELAYER_KEY + PORW_MEP_IDS from env)
//   node relayer/relayer.mjs --env .env.bsc-testnet             (same, loading the env file itself)
//   node relayer/relayer.mjs --config relayer/config.json       (optional file for ports/names; env wins for addresses/keys)
// With PORW_COLLECTION set it is also (5) the hatch keeper for that FlyCollection.
// HTTP API (JSON): GET /deployment  GET /epoch?mep=0x..  GET /proof?mep&epoch&instance  GET /status
//                  POST /tx/delegate {instance,session,expiry,sig}  POST /tx/materialize {mep,epoch,instance}
//                  POST /tx/result {taskId,execDigest,execRoot,signature}  POST /tx/settle {taskId,instance}
import fs from "node:fs"; import http from "node:http"; import path from "node:path"; import { fileURLToPath } from "node:url";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { clients, eip712Domains } from "./chain.mjs";
import { FlyCollectionAbi } from "./abi.mjs";
import { loadEnv, deploymentFromEnv, relayerFromEnv } from "./env.mjs";
const here = path.dirname(fileURLToPath(import.meta.url)); const porw = (f) => import(path.join(here, "../contracts/lib/aigg-porw/web/porw-browser/", f));
const { startRelay } = await porw("relay.js"); const { RelayClient } = await porw("relay_client.js"); const { Aggregator, EpochTree } = await porw("aggregator.js"); const { keypair, recoverAddress } = await porw("claim.js"); const { resultDigest } = await porw("eip712.js"); const V = await porw("verify.js"); const { makeMep, withTerms, EXEC_INT_SPMV_Q16 } = await porw("mep.js"); const { lifExecKind } = await porw("lif.js");

const args = Object.fromEntries(process.argv.slice(2).reduce((a, v, i, arr) => { if (v.startsWith("--")) a.push([v.slice(2), arr[i + 1]]); return a; }, []));
loadEnv(args.env || process.env.PORW_ENV_FILE);
const fileCfg = args.config || fs.existsSync(path.join(here, "config.json")) ? JSON.parse(fs.readFileSync(args.config || path.join(here, "config.json"), "utf8")) : {};
const envCfg = relayerFromEnv(); const cfg = { ...fileCfg, ...Object.fromEntries(Object.entries(envCfg).filter(([, v]) => v !== null)) };
// deployment: environment first (never in git), else the file named in the config (local anvil runs)
const dep = deploymentFromEnv() || (cfg.deployment ? JSON.parse(fs.readFileSync(path.resolve(here, "..", cfg.deployment), "utf8")) : null);
if (!dep) throw new Error("no deployment: source the .env.<network> from deploy.sh (PORW_* variables) or set config.deployment");
dep.rpc = process.env.PORW_RPC || cfg.rpc || dep.rpc; if (!dep.rpc) throw new Error("PORW_RPC (or config.rpc) required");
if (!cfg.privateKey) throw new Error("PORW_RELAYER_KEY (or config.privateKey) required"); if (!(cfg.meps && cfg.meps.length) && !dep.addresses.whitelist) throw new Error("nothing to serve: PORW_MEP_IDS (or config.meps) and/or PORW_WHITELIST required");
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
const epochTrees = new Map(); // epoch -> EpochTree over every MEP's claims (null: an epoch nobody claimed in) -- the tree behind the one posted root
// a valid claim keeps its instance eligible for this many epochs (older deployments have no such getter: 1)
let CLAIM_VALIDITY = 1; try { CLAIM_VALIDITY = Number(await ch.instances.read.claimValidityEpochs()); } catch {}
// what a replicator needs to know before it re-executes for a reason: how long a settled result stays challengeable
// and the base deposit (0 blocks: off, or a deployment older than the feature). The relayer itself never challenges.
let CHALLENGE = { windowBlocks: 0, depositWei: "0" }; try { CHALLENGE = { windowBlocks: Number(await ch.market.read.challengeWindow()), depositWei: String(await ch.market.read.challengeDepositWei()) }; } catch {}
// One brain, read from the registry and rebuilt as the object the aggregator verifies claims against. A profile under
// TERMS (a beneficiary's share of every settled fee) has the terms inside its id, so they are read and wrapped back on;
// then the id has to come out the same, or this relayer and the chain disagree about what the MEP is.
const ZERO_ADDR = "0x" + "0".repeat(40);
async function loadMep(id, { name = null, collection = null, token = null, pinned = false } = {}) {
  id = id.toLowerCase(); const m = await ch.meps.read.getMEP([id]);
  // int-lif is a FAMILY of kinds, one per weight unit (a connectome counted on another scale pins another unit); the
  // chain knows which digests are int-lif and under what unit. Older deployments have no such getter: the default kind only.
  let wUnitQ16 = 0; try { wUnitQ16 = Number(await ch.meps.read.lifWeightUnit([m.execKind])); } catch { wUnitQ16 = m.execKind.toLowerCase() === hex(lifExecKind()).toLowerCase() ? 18022 : 0; }
  const isLif = wUnitQ16 !== 0;
  let terms = null; try { const [beneficiary, royaltyBps] = await ch.meps.read.termsOf([id]); if (beneficiary !== ZERO_ADDR) terms = { beneficiary, royaltyBps: Number(royaltyBps) }; } catch {} // a registry older than terms
  const info = { mepId: id, modelId: m.modelId, execKind: m.execKind, exec: isLif ? "int-lif" : "int-spmv-q16", wUnitQ16: isLif ? wUnitQ16 : null, neurons: Number(m.neurons), synapses: Number(m.synapses), synapseRoot: m.synapseRoot,
    weightsDA: (() => { try { return new TextDecoder().decode(unhex(m.weightsDA)); } catch { return m.weightsDA; } })(), name: (cfg.mepNames || {})[id] || name,
    collection, token, beneficiary: terms ? terms.beneficiary : null, royaltyBps: terms ? terms.royaltyBps : 0 };
  let mep = makeMep({ name: id.slice(0, 10), modelId: unhex(m.modelId), execKind: isLif ? lifExecKind(wUnitQ16) : EXEC_INT_SPMV_Q16 /* recomputed from the unit, so a kind the chain mis-stated would not reproduce the id below */, neurons: Number(m.neurons), synapses: Number(m.synapses), synapseRoot: unhex(m.synapseRoot) });
  if (terms) mep = withTerms(mep, terms.beneficiary, terms.royaltyBps);
  if (hex(mep.mepId).toLowerCase() !== id) throw new Error(`MEP ${id}: cannot reproduce mep_id (scheme/exec kind/terms mismatch)`);
  return { mep, info, aggregators: new Map(), posted: new Set(), pinned };
}
// PORW_MEP_IDS: brains this relayer serves whatever any list says. A mismatch here is a misconfiguration: refuse to start.
for (const id of cfg.meps || []) meps.set(id.toLowerCase(), await loadMep(id, { pinned: true }));
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
  // the brains served follow the whitelist: before aggregation, so a brain listed this pass is collected for this epoch
  if (wl) try { await follow(bn); } catch (err) { status.errors.push({ label: "whitelist", msg: String(err.shortMessage || err.message).slice(0, 200) }); log("whitelist error", String(err.shortMessage || err.message).slice(0, 160)); }
  // (2) aggregation: collect this epoch's claims once it is rolled -- but post the previous epoch's root either
  // way. An epoch with no beacon (nobody revealed, or a cold epoch under PORW_BEACON_LAZY) must not strand the
  // claims collected in the epoch before it: without that root nobody can materialize them.
  if (rolled) for (const [id] of meps) { const chal = await ch.claims.read.epochChallenge([BigInt(e), id]); aggregatorFor(id, e, chal); }
  // ONE root for the previous epoch over the claims of every MEP served here (the leaf carries its mepId), so the
  // cost of the root does not grow with the number of brains. Proofs are served from this shared tree.
  const prev = e - 1;
  if (prev >= 0 && !epochTrees.has(prev) && [...meps.values()].some((M) => M.aggregators.has(prev))) {
    const As = [...meps.values()].map((M) => M.aggregators.get(prev)).filter((A) => A && A.claims.size > 0);
    const markPosted = () => { for (const M of meps.values()) if (M.aggregators.has(prev)) { M.posted.add(prev); const A = M.aggregators.get(prev); A.stop && A.stop(); } }; // stop collecting for a closed epoch
    if (As.length === 0) { epochTrees.set(prev, null); markPosted(); }
    else {
      const T = new EpochTree(As, prev); const call = T.postRootCall(); const already = await ch.claims.read.epochRoots([BigInt(prev), ch.account.address]);
      let ok = already[0] !== ZERO32; // a root of ours from before a restart: the same claims give the same tree only if nothing was lost, so proofs may not verify -- instances then fall back to submitClaim
      if (!ok) { const r = await tx(`claims.postEpochRoot(${prev}, ${call.count} claims of ${As.length} MEPs)`, (o) => ch.claims.write.postEpochRoot([BigInt(prev), call.root, BigInt(call.count)], o)); ok = r.ok; if (ok) status.rootsPosted.push({ epoch: prev, root: call.root, count: call.count, meps: As.length }); }
      if (ok) { for (const A of As) A.epochTree = T; epochTrees.set(prev, T); markPosted(); }
    }
  }
  if (e !== lastEpoch) { log(`epoch ${e} (block ${bn})`); lastEpoch = e; }
  // after the mesh's own work, and never in its way: a collection that misbehaves must not stop an epoch rolling
  if (keeper) try { await keep(bn); } catch (err) { status.errors.push({ label: "keeper", msg: String(err.shortMessage || err.message).slice(0, 200) }); log("keeper error", String(err.shortMessage || err.message).slice(0, 160)); }
}
// ---- the whitelist (PORW_WHITELIST): which brains are the system's ----
// The mesh is permissionless -- anybody may register a MEP -- but this relayer's attention is not: aggregating a
// brain's claims, serving its proofs and sponsoring the gas of tasks against it is what being "one of ours" means, and
// whose brains those are is decided on-chain by CollectionWhitelist. Its unit is the collection. For every listed
// collection this serves the two bases it names and every brain bound to one of its tokens -- so a fly is served from
// the pass after its owner registers it, adopted or BRED alike, with nobody editing PORW_MEP_IDS and nothing
// restarted. A collection taken off the list stops being served the same way; PORW_MEP_IDS stay pinned regardless.
// Walked, not followed by logs: a token's binding never changes once made, so a pass re-reads only the tokens that
// were unbound last time, and a restart needs no history (public RPCs cap a log query at a few thousand blocks).
const note = (list, entry) => { list.push(entry); if (list.length > 50) list.shift(); };
const WL_EVERY = BigInt(cfg.whitelistEvery || 20), WL_MAX = 5000;
const wl = ch.whitelist ? { walked: null, bound: new Map() /* collection -> Map(token -> mepId) */ } : null;
status.whitelist = wl ? { address: dep.addresses.whitelist, collections: [], served: 0, walkedAt: null, skipped: [] } : null;
async function follow(bn) {
  if (wl.walked !== null && bn < wl.walked + WL_EVERY) return;
  const listed = (await ch.whitelist.read.collections()).map((a) => a.toLowerCase()); const want = new Map(); // mepId -> where it comes from
  for (const c of listed) {
    const rd = (functionName, args = []) => ch.pub.readContract({ address: c, abi: FlyCollectionAbi, functionName, args });
    for (const [fn, name] of [["BASE_MEP_FEMALE", "base ♀"], ["BASE_MEP_MALE", "base ♂"]]) { const id = String(await rd(fn)).toLowerCase(); if (id !== ZERO32 && !want.has(id)) want.set(id, { collection: c, token: null, name }); }
    if (!wl.bound.has(c)) wl.bound.set(c, new Map()); const bound = wl.bound.get(c);
    const n = Math.min(Number(await rd("totalSupply")), WL_MAX);
    for (let t = 1; t <= n; t++) {
      if (!bound.has(t)) { const mepId = String((await rd("individuals", [BigInt(t)]))[3]).toLowerCase(); if (mepId !== ZERO32) bound.set(t, mepId); }
      const id = bound.get(t); if (id && !want.has(id)) want.set(id, { collection: c, token: t, name: `fly #${t}` });
    }
  }
  for (const c of [...wl.bound.keys()]) if (!listed.includes(c)) wl.bound.delete(c);
  for (const [id, from] of want) { const M = meps.get(id);
    if (M) { if (!M.info.collection) Object.assign(M.info, { collection: from.collection, token: from.token, name: M.info.name || from.name }); continue; }
    try { meps.set(id, await loadMep(id, from)); log(`whitelist: now serving ${id.slice(0, 12)}… (${from.name}, collection ${from.collection.slice(0, 10)}…)`); }
    catch (err) { const why = String(err.shortMessage || err.message).slice(0, 160); if (!status.whitelist.skipped.some((x) => x.mepId === id)) { note(status.whitelist.skipped, { mepId: id, ...from, why }); log(`whitelist: NOT serving ${id.slice(0, 12)}…: ${why}`); } } }
  // what is no longer listed is no longer served -- except what PORW_MEP_IDS pins
  for (const [id, M] of [...meps]) if (!M.pinned && !want.has(id)) { for (const A of M.aggregators.values()) A.stop && A.stop(); meps.delete(id); log(`whitelist: no longer serving ${id.slice(0, 12)}… (its collection left the list)`); }
  wl.walked = bn; Object.assign(status.whitelist, { collections: listed, served: [...meps.values()].filter((M) => !M.pinned).length, walkedAt: Number(bn) });
}

// ---- (5) hatch keeper (PORW_COLLECTION) ----
// FlyCollection.breed fixes the recipe and a seed block -- the block after the one it lands in -- and hatch(id),
// which anyone may call, turns that block's hash into the child's seed and pays the caller HATCH_BOUNTY. The EVM
// forgets a hash after 256 blocks, and an egg nobody hatched in time costs its owner a whole BREED_FEE to re-arm,
// so breeding is only "seconds" if somebody is standing there. This is somebody: it follows Bred and Rearmed,
// and hatches from the first tick after the seed block. It is not a subsidy -- an egg is hatched only when the
// bounty covers the gas at the current price, and one that does not stays listed, because the price may fall
// inside the window. Not sponsored and not budgeted: this is the relayer's own transaction, paid for by the
// bounty it collects. Anyone else may run the same loop, and whoever lands first takes the bounty; losing that
// race costs one reverted estimate, not a transaction.
const WINDOW = 256n;
const keeper = ch.collection && cfg.keeper !== false ? { eggs: new Map(), scanned: null, bounty: await ch.collection.read.HATCH_BOUNTY() } : null;
status.keeper = keeper ? { collection: dep.addresses.collection, bounty: keeper.bounty, eggs: [], hatched: [], skipped: [] } : null;
async function keep(bn) {
  // on the first pass look back exactly one window: an egg older than that has expired whoever was watching
  const from = keeper.scanned === null ? (bn > WINDOW ? bn - WINDOW : 0n) : keeper.scanned + 1n;
  if (from <= bn) {
    for (const l of await ch.pub.getContractEvents({ address: ch.collection.address, abi: ch.collection.abi, fromBlock: from, toBlock: bn })) {
      if (l.eventName === "Bred" || l.eventName === "Rearmed") keeper.eggs.set(l.args.id, { seedBlock: l.args.seedBlock, skipped: false });
      else if (l.eventName === "Hatched") keeper.eggs.delete(l.args.id);
    }
    keeper.scanned = bn;
  }
  for (const [id, egg] of keeper.eggs) {
    if (bn <= egg.seedBlock) continue; // its hash does not exist yet
    if (bn > egg.seedBlock + WINDOW) { keeper.eggs.delete(id); note(status.keeper.skipped, { id, why: `seed block ${egg.seedBlock} expired unhatched: it needs rearm()` }); log(`egg ${id}: expired unhatched`); continue; }
    let gas; try { gas = await ch.collection.estimateGas.hatch([id], { account: ch.account }); } catch { keeper.eggs.delete(id); continue; } // somebody else got there
    const cost = gas * (await ch.pub.getGasPrice());
    if (cost > keeper.bounty) { if (!egg.skipped) { egg.skipped = true; note(status.keeper.skipped, { id, why: `bounty ${keeper.bounty} wei does not cover ${gas} gas (${cost} wei)` }); log(`egg ${id}: not hatched, the bounty does not cover the gas`); } continue; }
    const r = await tx(`collection.hatch(${id})`, (o) => ch.collection.write.hatch([id], o));
    if (r.ok) { keeper.eggs.delete(id); note(status.keeper.hatched, { id, seedBlock: egg.seedBlock, hash: r.hash, gas: r.gasUsed }); } // a failure is re-examined next tick by the estimate above
  }
  status.keeper.eggs = [...keeper.eggs].map(([id, egg]) => ({ id, seedBlock: egg.seedBlock }));
}
// ---- (6) FlyBnB acknowledgments (PORW_COLLECTION) ----
// The FlyBnB dataset acknowledges whoever holds an individual: the list in the paper's appendix is this list at a
// block, and the list on the page is this list now. It follows the chain and nothing else -- a mint adds an address,
// a transfer moves a token from one address to another, and an address that holds nothing is not on it. Read by
// walking ids 1..totalSupply (the contract keeps no owner index), at most once every HOLDERS_EVERY blocks and only
// when somebody asks; past HOLDERS_MAX tokens this wants an indexer, and says so instead of going quiet.
const HOLDERS_EVERY = 10n, HOLDERS_MAX = 2000;
let holdersCache = null, holdersPass = null;
async function holders() {
  const bn = await ch.pub.getBlockNumber({ cacheTime: 0 }); // viem remembers the block number for seconds; this cache is counted in blocks
  if (holdersCache && bn < BigInt(holdersCache.block) + HOLDERS_EVERY) return holdersCache;
  return holdersPass ||= (async () => {
    const n = Number(await ch.collection.read.totalSupply()); const tokens = []; const by = new Map();
    for (let id = 1; id <= Math.min(n, HOLDERS_MAX); id++) {
      const [owner, ind] = await Promise.all([ch.collection.read.ownerOf([BigInt(id)]), ch.collection.read.individuals([BigInt(id)])]);
      const t = { id, owner, sex: ind[4], generation: ind[5], registered: ind[3] !== ZERO32 }; tokens.push(t);
      if (!by.has(owner)) by.set(owner, []); by.get(owner).push(id);
    }
    // most individuals first, then the earliest token: a stable order, so a list that did not change does not move
    const list = [...by].map(([address, ids]) => ({ address, tokens: ids })).sort((a, b) => b.tokens.length - a.tokens.length || a.tokens[0] - b.tokens[0]);
    holdersCache = { collection: dep.addresses.collection, chainId: dep.chainId, block: Number(bn), totalSupply: n, truncated: n > HOLDERS_MAX, holders: list, tokens };
    return holdersCache;
  })().finally(() => { holdersPass = null; });
}
// ---- (4) HTTP API ----
const json = (res, code, body) => { res.writeHead(code, { "content-type": "application/json", "access-control-allow-origin": "*", "access-control-allow-headers": "content-type" }); res.end(JSON.stringify(body, (k, v) => (typeof v === "bigint" ? v.toString() : v))); };
const body = (req) => new Promise((r) => { let s = ""; req.on("data", (c) => (s += c)); req.on("end", () => r(s ? JSON.parse(s) : {})); });
// A participating instance is one with at least one sortition vote. `bonded() > 0` is not that: bond() takes any
// msg.value > 0, so a single wei passes it -- which would make the per-instance budget below worth nothing, since
// a Sybil could mint one budget per wei. weightOf() is bonded/UNIT (capped), i.e. what the mesh itself means by an
// instance, and it puts the price of a sponsorship budget at one UNIT.
const hasWeight = async (addr) => (await ch.instances.read.weightOf([addr])) > 0n;
// ---- sponsorship guard ----
// Every /tx/* call spends the relayer's own BNB on somebody else's behalf, so each one must name a bonded
// instance to charge, must simulate successfully from the relayer's account (a reverted transaction still costs
// gas -- this is the guard the README always claimed and the code never had), and must fit inside a budget.
// Budgets are in gas: SPONSOR_EPOCH_GAS per instance per epoch stops one bonded instance from looping a call
// that simulates fine, and SPONSOR_DAY_GAS caps the whole relayer. Both are deliberately finite by default:
// an operator should raise them knowingly rather than inherit an unbounded wallet.
const TASK_CLIENTS = cfg.taskClients && cfg.taskClients.length ? new Set(cfg.taskClients) : null; // null: anybody's tasks
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
// Queue the complete admission decision through receipt accounting, not only the broadcast. Otherwise a
// concurrent burst can all observe an unused budget and simulate against the same stale chain state.
let sponsorChain = Promise.resolve();
function sponsored(res, instance, label, simulate, send, taskId = null) {
  const run = async () => {
    if (!instance || !/^0x[0-9a-fA-F]{40}$/.test(instance)) return refuse(res, 400, label, "no instance to charge this call to");
    if (!(await hasWeight(instance))) return refuse(res, 403, label, "instance has no sortition weight (bond at least one UNIT)");
    const inst = instance.toLowerCase();
    const bud = budget(inst); if (!bud.ok) return refuse(res, 429, label, bud.why);
    // Sponsorship is for the brains this relayer serves. A task against any other MEP settles on-chain exactly as well
    // -- its executor pays its own gas -- but it is not ours to pay for: that is what being off the list means. A task
    // that does not exist has no MEP to judge; the simulation below is what refuses it.
    // And, while PORW_TASK_CLIENTS is set, only for the tasks of those clients. Third-party tasks are not open yet:
    // every task on this network is one the FlyBnB dataset needs, posted by the project. The market is permissionless
    // and cannot refuse anybody's task; what is withheld is this relayer's gas, and a session key holds none of its own.
    if (taskId) { let m = ZERO32, client = null; try { const t = await ch.market.read.taskInfo([taskId]); m = String(t[0]).toLowerCase(); client = String(t[2]).toLowerCase(); } catch {}
      if (m !== ZERO32 && !meps.has(m)) return refuse(res, 403, label, "the task's MEP is not one this relayer serves (not pinned, not on the whitelist)");
      if (m !== ZERO32 && TASK_CLIENTS && !TASK_CLIENTS.has(client)) return refuse(res, 403, label, "tasks are not open to third parties yet: this relayer sponsors only the dataset's own (PORW_TASK_CLIENTS)"); }
    try { await simulate(); } catch (e) { return refuse(res, 400, label, "would revert: " + String(e.shortMessage || e.message).split("\n")[0].slice(0, 200)); }
    const r = await tx(label, send);
    if (r.gasUsed) bud.charge(r.gasUsed); // a revert that still got mined is charged too: it cost the relayer gas
    return json(res, 200, r);
  };
  const p = sponsorChain.then(run, run); sponsorChain = p.catch(() => {}); return p;
}
api.on("request", async (req, res) => {
  try {
    const u = new URL(req.url, "http://x"); if (req.method === "OPTIONS") return json(res, 204, {});
    if (u.pathname === "/deployment") return json(res, 200, { ...dep, taskClients: TASK_CLIENTS ? [...TASK_CLIENTS] : null, relay: publicRelayUrl, relayer: ch.account.address, domains, epochBlocks: EPOCH_BLOCKS, claimValidityEpochs: CLAIM_VALIDITY, challenge: CHALLENGE, meps: [...meps.keys()] });
    if (u.pathname === "/flybnb/holders") return ch.collection ? json(res, 200, await holders()) : json(res, 404, { error: "no collection configured (PORW_COLLECTION)" });
    if (u.pathname === "/meps") return json(res, 200, [...meps.values()].map((M) => M.info));
    if (u.pathname === "/status") return json(res, 200, { block: lastBlock, epoch: lastEpoch, relay: relay.stats, nonce: nonceState, ...status, aggregators: [...meps].map(([id, M]) => ({ mep: id, epochs: [...M.aggregators].map(([ep, A]) => ({ epoch: ep, claims: A.claims.size, rejected: A.rejected.length, posted: M.posted.has(ep) })) })) });
    if (u.pathname === "/epoch") { const id = (u.searchParams.get("mep") || "").toLowerCase(); const e = Number(await ch.claims.read.currentEpoch()); const b = await ch.claims.read.beacon([BigInt(e)]);
      return json(res, 200, { epoch: e, block: await ch.pub.getBlockNumber(), beacon: b, rolled: b !== ZERO32, lazy: LAZY, warm: status.beacon.warm, challenge: id ? await ch.claims.read.epochChallenge([BigInt(e), id]) : null }); }
    if (u.pathname === "/proof") { const id = (u.searchParams.get("mep") || "").toLowerCase(), e = Number(u.searchParams.get("epoch")), inst = u.searchParams.get("instance"); const M = meps.get(id); const T = epochTrees.get(e); const p = M && T && T.proofFor(id, inst);
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
      if (e + WAKE_EPOCHS > wakeUntil) { if (!(await hasWeight(b.instance))) return json(res, 403, { error: "instance has no sortition weight (bond at least one UNIT)" }); wakeUntil = e + WAKE_EPOCHS; status.beacon.wakeUntil = wakeUntil; }
      return json(res, 200, { ok: true, lazy: LAZY, epoch: e, wakeUntil }); }
    if (u.pathname === "/tx/delegate") { const args = [b.instance, b.session, BigInt(b.expiry), b.sig];
      return await sponsored(res, b.instance, `instances.delegateBySig(${String(b.instance).slice(0, 10)})`,
        () => ch.instances.simulate.delegateBySig(args, { account: ch.account }), (o) => ch.instances.write.delegateBySig(args, o)); }
    if (u.pathname === "/tx/materialize") { const id = String(b.mep).toLowerCase(); const M = meps.get(id); const T = epochTrees.get(Number(b.epoch));
      if (M && M.aggregators.has(Number(b.epoch)) && !T) return json(res, 409, { error: "root not posted yet" }); const p = M && T && T.proofFor(id, b.instance); if (!p) return json(res, 404, { error: "no proof" });
      const l = p.payload.leaf; const args = [BigInt(b.epoch), ch.account.address, BigInt(p.payload.index), { mepId: l.mepId, instance: l.instance, partialsRoot: l.partialsRoot, coverageBytes: BigInt(l.coverageBytes), signature: l.signature }, p.payload.proof];
      return await sponsored(res, b.instance, `claims.materializeClaim(${String(b.instance).slice(0, 10)}, ${b.epoch})`,
        () => ch.claims.simulate.materializeClaim(args, { account: ch.account }), (o) => ch.claims.write.materializeClaim(args, o)); }
    if (u.pathname === "/tx/result") {
      // Only the signature identifies the payer; caller-supplied signer metadata is not authenticated.
      const recovered = hex(recoverAddress(resultDigest(domains.market, unhex(b.taskId), unhex(b.execDigest), unhex(b.execRoot)), unhex(b.signature)));
      const signer = await ch.instances.read.resolve([recovered]); if (signer === "0x0000000000000000000000000000000000000000") return json(res, 403, { error: "signer not bonded/delegated" });
      const args = [b.taskId, { execDigest: b.execDigest, execRoot: b.execRoot }, b.signature]; // charged to the instance the session key resolves to
      return await sponsored(res, signer, `market.submitResult(${String(b.taskId).slice(0, 10)})`,
        () => ch.market.simulate.submitResult(args, { account: ch.account }), (o) => ch.market.write.submitResult(args, o), b.taskId); }
    // settle is permissionless on-chain, so anyone may settle their own task by paying for it; the relayer only
    // sponsors it for a selected executor, so callers cannot spend an unrelated instance's budget.
    if (u.pathname === "/tx/settle") { const args = [b.taskId];
      return await sponsored(res, b.instance, `market.settle(${String(b.taskId).slice(0, 10)})`,
        async () => {
          const executors = await ch.market.read.executors(args);
          if (!executors.some((a) => a.toLowerCase() === b.instance.toLowerCase())) throw new Error("instance is not a task executor");
          return ch.market.simulate.settle(args, { account: ch.account });
        }, (o) => ch.market.write.settle(args, o), b.taskId); }
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
// One pass at a time. A tick awaits each transaction to its receipt -- seconds on BSC, against a 2 s poll -- and
// what it did is only recorded after that await (`secrets`, the on-chain flags the other branches read). A second
// tick started meanwhile sees the commit still missing and sends it again with a fresh secret; tx() serializes it
// behind the first, where it reverts in estimation ("committed": no gas lost, but a failure in /status.errors that
// is not one), and reveal, rollEpoch and postEpochRoot double up the same way. A tick that lands mid-pass joins
// the pass already running instead of queueing behind it: a queued pass would only act on a block number gone stale.
const runPass = async () => { try { await tick(); } catch (e) { status.errors.push({ label: "tick", msg: String(e.shortMessage || e.message).slice(0, 200) }); log("tick error", String(e.shortMessage || e.message).slice(0, 160)); } };
let pass = null; const loop = () => (pass ||= runPass().finally(() => { pass = null; }));
await loop(); setInterval(loop, cfg.pollMs || 2000);
