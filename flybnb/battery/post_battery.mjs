// Post an individual's standard battery to the network as ONE batched task, and turn what comes back into dataset rows.
//
//   import { postBattery, checkAgainstOffline } from "./post_battery.mjs";
//   const att = await postBattery({ battery, mepId, runsRoot, chain, relay, porw, fee });
//
// What the network adds to a row is not the numbers: a row's readout is recomputed by whoever wants it
// (flybnb/analysis/run_battery.py, 0.2-2 s per run). It is that N bonded executors, drawn by the chain, ran the same 39
// (or 42) runs of the same registered brain and signed the same batch, under a bond that any one of those runs can take.
// So the output is an ATTESTATION: the task, who executed it, the settled root, and per run the execRoot and the counts
// digest -- the same digest run_battery.py writes, so `checkAgainstOffline` joins the two with an equality.
//
// The requester's key pays the fee and nothing else; it comes from the environment (FLYBNB_REQUESTER_KEY) in the CLI and
// is never written anywhere. Executors are addressed by their session keys, read from the chain's SessionKeySet events.
import { parseAbiItem, keccak256, encodeAbiParameters } from "viem";
import { batteryBatch, rowOf, resolvedRuns } from "./battery_batch.mjs";

const TASK_TUPLE = { type: "tuple", components: [{ name: "mepId", type: "bytes32" }, { name: "stimulusSeed", type: "uint32" }, { name: "steps", type: "uint32" }, { name: "commitStride", type: "uint32" }, { name: "initStateRoot", type: "bytes32" }, { name: "fee", type: "uint256" }, { name: "deadline", type: "uint64" }, { name: "redundancy", type: "uint8" }] };
export const batchIdOf = (t, runs, nonce) => keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "uint32" }], [keccak256(encodeAbiParameters([TASK_TUPLE, { type: "bytes32" }], [t, nonce])), runs]));
const hex = (b) => (typeof b === "string" ? b.toLowerCase() : "0x" + Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("")), unhex = (s) => Uint8Array.from(s.slice(2).match(/../g).map((h) => parseInt(h, 16)));
const SESSION_EVENT = parseAbiItem("event SessionKeySet(address indexed instance, address indexed session, uint64 expiry)");

/** the live session key of each instance: its latest SessionKeySet whose delegation the registry still holds */
export async function sessionsOf(chain, instances, { fromBlock = 0n } = {}) {
  const out = {}, now = await chain.pub.getBlockNumber({ cacheTime: 0 });
  for (const inst of instances) {
    const logs = await chain.pub.getLogs({ address: chain.instances.address, event: SESSION_EVENT, args: { instance: inst }, fromBlock, toBlock: now });
    for (const l of logs.reverse()) { const [owner, expiry] = await chain.instances.read.delegations([l.args.session]); if (owner.toLowerCase() === inst.toLowerCase() && BigInt(expiry) > now) { out[inst.toLowerCase()] = l.args.session.toLowerCase(); break; } }
  }
  return out;
}

/** does the MEP run under the weight unit this battery's population names? (a battery without one is the default kind's) */
export async function kindMatches(chain, battery, mepId) {
  const want = battery.population?.w_unit_q16 ?? 18022; let have = null;
  const m = await chain.meps.read.getMEP([mepId]);
  try { have = Number(await chain.meps.read.lifWeightUnit([m.execKind])); } catch { return { ok: want === 18022 ? null : false, want, have: null }; }   // a registry without kinds runs the default unit only
  return { ok: have === want, want, have };
}

/** may this address post tasks the relayer will sponsor? `/deployment.taskClients` is null while the network is open to anybody's tasks */
export const clientAllowed = (deployment, address) => !Array.isArray(deployment.taskClients) || deployment.taskClients.map((a) => a.toLowerCase()).includes(address.toLowerCase());

/**
 * Post, announce, collect. `chain` is relayer/chain.mjs clients() with the requester's key; `relay` a connected RelayClient;
 * `porw` = { batch: batch.js, verify: verify.js }; `runsRoot` is PorwNode.batchRunsRoot(mepId, resolvedRuns(batch)).runsRoot.
 * Resolves when every drawn executor has replied (or refused, or timed out): the caller decides what a partial answer is worth.
 */
export async function postBattery({ battery, mepId, runsRoot, chain, relay, porw, fee, redundancy = 2, deadlineBlocks = 2000, nonce = null, silence = null, timeoutMs = 3600000, sessions = null, log = () => {} }) {
  const b = batteryBatch(battery, { silence }); const R = b.runs.length; nonce = nonce || keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "uint256" }], [mepId, BigInt(Date.now())]));
  const head = await chain.pub.getBlockNumber({ cacheTime: 0 }); const task = { mepId, stimulusSeed: 0, steps: b.steps, commitStride: b.commitStride, initStateRoot: hex(runsRoot), fee, deadline: head + BigInt(deadlineBlocks), redundancy };
  const txHash = await chain.market.write.postBatch([task, R, nonce], { value: fee }); const rcpt = await chain.pub.waitForTransactionReceipt({ hash: txHash }); if (rcpt.status !== "success") throw new Error("postBatch reverted");
  const taskId = batchIdOf(task, R, nonce); if (Number(await chain.market.read.batchRuns([taskId])) !== R) throw new Error("the chain does not know this batch under the id computed here");
  const executors = (await chain.market.read.executors([taskId])).map((x) => x.toLowerCase()); log(`posted ${R} runs as ${taskId} (${rcpt.gasUsed} gas); executors ${executors.join(", ")}`);
  const sess = sessions || await sessionsOf(chain, executors); const announce = { taskId, steps: b.steps, commitStride: b.commitStride, initStateRoot: hex(runsRoot), sets: b.sets, runs: b.runs };
  const replies = await Promise.all(executors.map(async (ex) => {
    if (!sess[ex]) return { executor: ex, error: "no live session key on chain" };
    try { const env = await relay.request(sess[ex], "batch-announce", mepId, announce, { timeoutMs, responseType: "result" }); return { executor: ex, session: sess[ex], result: env.payload }; }
    catch (e) { return { executor: ex, session: sess[ex], error: String(e.message || e) }; }
  }));
  // what came back: each reply's per-run roots must hash to the batch root it signed, and the replies must be the same batch
  const ok = replies.filter((r) => r.result && Array.isArray(r.result.runs) && r.result.runs.length === R);
  for (const r of ok) r.consistent = hex(porw.verify.merkleRoot(r.result.runs.map((x, k) => porw.batch.runResultLeaf(k, unhex(x.execRoot))))) === r.result.execRoot.toLowerCase();
  const good = ok.filter((r) => r.consistent), roots = new Set(good.map((r) => r.result.execRoot.toLowerCase())); const agreed = good.length >= 2 && roots.size === 1 && good.length === executors.length;
  const rows = good.length ? good[0].result.runs.map((x, k) => ({ run: k, ...rowOf(battery, k), execRoot: x.execRoot, initStateRoot: x.initStateRoot, countsDigest: x.countsDigest, agree: good.every((g) => g.result.runs[k].execRoot === x.execRoot && g.result.runs[k].countsDigest === x.countsDigest) })) : [];
  return { battery: { name: battery.name, version: battery.version, brain: battery.brain, silence: silence ? silence.length : 0 }, mepId, taskId, txHash, block: Number(rcpt.blockNumber), gasUsed: Number(rcpt.gasUsed), chainId: chain.chain.id, market: chain.market.address,
    runsRoot: hex(runsRoot), fee: fee.toString(), redundancy, executors, replies: replies.map((r) => ({ executor: r.executor, session: r.session || null, error: r.error || null, execRoot: r.result?.execRoot || null, consistent: r.consistent ?? null })), agreed, batchRoot: agreed ? [...roots][0] : null, rows };
}

/** after settlement: is the root the executors agreed on the one the chain paid for? */
export async function settledAs(chain, att) {
  const settled = []; for (const ex of att.executors) { const [, root] = await chain.market.read.resultOf([att.taskId, ex]); settled.push(root.toLowerCase()); }
  return { onChain: settled, matches: att.agreed && settled.every((r) => r === att.batchRoot) };
}

/** join an attestation with run_battery.py's row of the same individual: the network's digests ARE the offline digests, or they are not */
export function checkAgainstOffline(att, offline, battery) {
  const want = new Map(offline.rows.map((w) => [w.stim + "|" + w.seed, w.digest.toLowerCase()])); const bad = [];
  for (const r of att.rows) { const d = want.get(r.stimulus + "|" + r.seed); if (d !== r.countsDigest.toLowerCase()) bad.push({ run: r.run, stimulus: r.stimulus, seed: r.seed, network: r.countsDigest, offline: d || null }); }
  return { runs: att.rows.length, expected: battery.stimuli.length * battery.seeds.length, matched: att.rows.length - bad.length, mismatches: bad, ok: bad.length === 0 && att.rows.length === battery.stimuli.length * battery.seeds.length };
}

// ---- CLI ----
//   FLYBNB_REQUESTER_KEY=0x... node flybnb/battery/post_battery.mjs --relayer https://relayer... --payload brain.bin --name NAME \
//        --battery flybnb/battery/battery-male-v1.json [--fee 0.01] [--redundancy 2] [--offline rows.jsonl --id M000] [--out attestation.json]
if (import.meta.url === `file://${process.argv[1]}`) {
  const fs = await import("node:fs"), path = await import("node:path"), { fileURLToPath } = await import("node:url"), { parseEther } = await import("viem");
  const arg = (k, d = null) => { const i = process.argv.indexOf("--" + k); return i > 0 ? process.argv[i + 1] : d; };
  const here = path.dirname(fileURLToPath(import.meta.url)), root = path.join(here, "..", ".."), P = (f) => import(path.join(root, "contracts/lib/aigg-porw/web/porw-browser", f));
  const key = process.env.FLYBNB_REQUESTER_KEY; if (!key || !arg("relayer") || !arg("payload")) { console.error("FLYBNB_REQUESTER_KEY=<funded key> node post_battery.mjs --relayer URL --payload brain.bin --name NAME [--battery F] [--fee BNB] [--redundancy N] [--offline rows.jsonl --id ID] [--out F]"); process.exit(2); }
  const battery = JSON.parse(fs.readFileSync(arg("battery", path.join(here, "battery-v1.json")), "utf8")); const dep = await (await fetch(arg("relayer").replace(/\/$/, "") + "/deployment")).json();
  const { clients } = await import(path.join(root, "relayer/chain.mjs")); const chain = clients(dep, key);
  const { PorwNode } = await P("node.js"), { loadKernelFromBytes } = await P("porw.js"), { RelayClient } = await P("relay_client.js"), { keypair } = await P("claim.js"); const porw = { batch: await P("batch.js"), verify: await P("verify.js") };
  const node = new PorwNode(await loadKernelFromBytes(fs.readFileSync(path.join(root, "contracts/lib/aigg-porw/web/porw-browser/sketch.wasm"))), { privHex: key }); const wUnitQ16 = battery.population?.w_unit_q16;
  const st = await node.loadModel(arg("name", path.basename(arg("payload"), ".bin")), new Uint8Array(fs.readFileSync(arg("payload"))), { maxSteps: battery.steps, exec: "lif", ...(wUnitQ16 ? { wUnitQ16 } : {}) }); const mepId = hex(st.mep.mepId);
  if (!clientAllowed(dep, chain.account.address)) { console.error(`${chain.account.address} is not among this relayer's task clients: the executors' results would not be sponsored, and the fee would buy nothing`); process.exit(1); }
  const km = await kindMatches(chain, battery, mepId); if (km.ok === false) { console.error(`this brain is registered under weight unit ${km.have}; the battery's population needs ${km.want}`); process.exit(1); }
  const b = batteryBatch(battery); const { runsRoot } = await node.batchRunsRoot(st.mep.mepId, resolvedRuns(b)); const relay = new RelayClient([dep.relay], keypair(key)); await relay.connect();
  const att = await postBattery({ battery, mepId, runsRoot, chain, relay, porw, fee: parseEther(arg("fee", "0.01")), redundancy: Number(arg("redundancy", "2")), log: (m) => console.log(m) });
  console.log(att.agreed ? `all ${att.executors.length} executors signed the same batch: ${att.batchRoot}` : "NO AGREEMENT: " + JSON.stringify(att.replies));
  if (arg("offline")) { const row = fs.readFileSync(arg("offline"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).find((r) => r.id === arg("id")); if (!row) { console.error("no offline row with id " + arg("id")); process.exit(1); }
    att.offline = { id: row.id, delta_id: row.delta_id, ...checkAgainstOffline(att, row, battery) }; console.log(`offline rows: ${att.offline.matched}/${att.offline.expected} digests equal`); }
  fs.writeFileSync(arg("out", `attestation-${att.taskId.slice(2, 10)}.json`), JSON.stringify(att, null, 1)); process.exit(att.agreed && (!att.offline || att.offline.ok) ? 0 : 1);
}
