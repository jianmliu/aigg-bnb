// NOTE: the `mep` block of each model in task.json still carries scheme sketch-tile-keccak:v1 values. Under v2 a
// mep_id binds (scheme, model_id, exec kind, neurons, synapses, synapseRoot) and no longer binds steps or the
// stride, so `schemeDigest` and `mepId` there must be regenerated with `web/porw-browser/model_id.mjs
// <payload.bin>` against the real payloads before this runs on a v2 deployment. Nothing else in the file moves:
// `model_id`, `synapseRoot`, the sha256s and every `delta` block are unaffected — the scheme bump changed what the
// mesh signs, not how bytes are committed. `steps` and `clampQ16` stay too: they are the task's parameters now.
//
// Post the tasks of task.json on a deployed mesh and drive them to settlement: postTask (skipped when the task id
// already exists), task-announce with the stimulus ids to the sortitioned executors over the relayer's relay, wait
// for the sponsored submitResult transactions, settle through the relayer API, and compare the settled digests with
// task.json's expected ones. Works against the anvil harness (e2e_gate_task.mjs imports runTasks) and a live
// network (source the aigg-bnb .env.<network>; the client key pays the fees).
//   AIGG_BNB=/path/to/aigg-bnb node post_tasks.mjs --env /path/to/.env.bsc-testnet --relayer http://host:8788 [--only full,ablate4,keep4] [--fee 0.001] [--deadline 600]
import fs from "node:fs"; import path from "node:path"; import { createRequire } from "node:module";
const here = path.dirname(new URL(import.meta.url).pathname); const bnb = process.env.AIGG_BNB || "/Volumes/T7-Data/rspeech/aigg-bnb-work";
const { parseEther, keccak256, encodeAbiParameters, parseAbiItem } = await import(createRequire(path.join(bnb, "package.json")).resolve("viem"));
const porw = (f) => import(path.join(bnb, "contracts/lib/aigg-porw/web/porw-browser", f));
const hex = (b) => "0x" + Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/**
 * @param clients   aigg-bnb `clients`/`clientsFor` object of the paying client (pub, market, ...)
 * @param clientKey the client's private key (signs the relay envelopes)
 * @param api       async (path, body?) => JSON, the relayer HTTP API
 * @param opts      { taskJson, fee, deadlineBlocks, only: [model names], sessionOf: async wallet -> session address, log }
 */
/** taskId = keccak256(abi.encode(Task, nonce)) -- the id binds every field of the task, deadline and fee included,
 *  so a squatter cannot take a client's id with different parameters (TaskMarket.postTask / PorwMeshHash.taskId). */
export const taskIdOf = (t, nonce) => keccak256(encodeAbiParameters(
  [{ type: "tuple", components: [{ name: "mepId", type: "bytes32" }, { name: "stimulusSeed", type: "uint32" }, { name: "steps", type: "uint32" }, { name: "commitStride", type: "uint32" },
     { name: "inputCommit", type: "bytes32" }, { name: "fee", type: "uint256" }, { name: "deadline", type: "uint64" }, { name: "redundancy", type: "uint8" }] }, { type: "bytes32" }],
  [t, nonce]));

/** the executor's current session key (its relay inbox): the latest SessionKeySet event of the instance registry for that wallet */
export async function sessionFromLogs(clients, instancesAddress, wallet) {
  const logs = await clients.pub.getLogs({ address: instancesAddress, event: parseAbiItem("event SessionKeySet(address indexed instance, address indexed session, uint64 expiry)"), args: { instance: wallet }, fromBlock: 0n });
  const block = await clients.pub.getBlockNumber(); const live = logs.filter((l) => BigInt(l.args.expiry) > block); if (!live.length) throw new Error(`no live session key delegated by ${wallet}`);
  return live[live.length - 1].args.session.toLowerCase();
}
export async function runTasks(clients, clientKey, api, { taskJson = path.join(here, "task.json"), fee = "0.01", deadlineBlocks = 50, only = null, sessionOf = null, log = console.log } = {}) {
  const T = JSON.parse(fs.readFileSync(taskJson, "utf8")); const { keypair } = await porw("claim.js"); const { RelayClient } = await porw("relay_client.js");
  const d = await api("/deployment"); const client = new RelayClient([d.relay], keypair(clientKey)); await client.connect(); const out = [];
  try {
    for (const t of T.tasks) {
      if (only && !only.some((o) => t.model.endsWith(o) || (o === "full" && t.model === "flywire-783-min5"))) continue;
      const mep = T.models[t.model].mep; const ids = T.stimulusSets[t.stimulusSet].payloadIndices; const seed = T.stimulusSeed;
      // The task's own parameters: `steps` and `commitStride` ride on the task under scheme v2, and the id binds
      // the whole struct -- so it has to be built before it can be identified, deadline included.
      const block = await clients.pub.getBlockNumber();
      const task = { mepId: mep.mepId, stimulusSeed: seed, steps: mep.steps, commitStride: mep.clampQ16, inputCommit: t.inputCommit,
        fee: parseEther(fee), deadline: block + BigInt(deadlineBlocks), redundancy: 2 };
      const taskId = taskIdOf(task, t.nonce); const r = { model: t.model, stimulusSet: t.stimulusSet, taskId, expected: t.expectedExecDigest };
      let ex = []; try { ex = (await clients.market.read.executors([taskId])).map((x) => x.toLowerCase()); } catch {}
      if (!ex.length) {
        const h = await clients.market.write.postTask([task, t.nonce], { value: parseEther(fee) });
        const rc = await clients.pub.waitForTransactionReceipt({ hash: h }); r.postTx = h; if (rc.status !== "success") { r.error = "postTask reverted"; out.push(r); log(`FAIL ${t.model} | ${t.stimulusSet}: postTask reverted ${h}`); continue; }
        ex = (await clients.market.read.executors([taskId])).map((x) => x.toLowerCase());
      } else r.postTx = "(already posted)";
      r.executors = ex; log(`task ${taskId.slice(0, 12)}… ${t.model} | ${t.stimulusSet}: executors ${ex.map((x) => x.slice(0, 8)).join(", ")}`);
      // executors answer on their session inbox (the delegated session key), not on their wallet address
      r.results = {};
      for (const x of ex) {
        let session; try { session = sessionOf ? await sessionOf(x) : await sessionFromLogs(clients, d.addresses.instances, x); } catch (e) { r.results[x] = { error: String(e) }; log(`  ${x.slice(0, 8)}: ${e.message}`); continue; }
        try { const resp = await client.request(session, "task-announce", mep.mepId, { taskId, stimulusSeed: seed, steps: task.steps, commitStride: task.commitStride, stimulusIds: ids }, { timeoutMs: 600000, responseType: "result" }); r.results[x] = { execDigest: resp.payload.execDigest, execRoot: resp.payload.execRoot, ok: resp.payload.execDigest === t.expectedExecDigest }; log(`  ${x.slice(0, 8)} -> ${resp.payload.execDigest.slice(0, 12)}… ${r.results[x].ok ? "matches" : "DIFFERS FROM"} the expected digest`); }
        catch (e) { r.results[x] = { error: String(e) }; log(`  ${x.slice(0, 8)} no result: ${e}`); }
      }
      const t0 = Date.now(); let all = false; while (Date.now() - t0 < 300000) { const s = await Promise.all(ex.map((x) => clients.market.read.submitted([taskId, x]))); if (s.every(Boolean)) { all = true; break; } await sleep(1000); }
      r.submitted = all; if (all) { r.settle = await api("/tx/settle", { taskId }); log(`  settle: ${r.settle.ok ? "ok " + (r.settle.hash || r.settle.tx || "") : JSON.stringify(r.settle).slice(0, 200)}`); } else log("  not all results submitted within 5 min");
      out.push(r);
    }
  } finally { client.close(); }
  return out;
}
if (import.meta.url === `file://${process.argv[1]}`) {
  const args = Object.fromEntries(process.argv.slice(2).reduce((a, v, i, arr) => { if (v.startsWith("--")) a.push([v.slice(2), arr[i + 1]]); return a; }, []));
  const { loadEnv, deploymentFromEnv } = await import(path.join(bnb, "relayer/env.mjs")); const { clients } = await import(path.join(bnb, "relayer/chain.mjs"));
  loadEnv(args.env); const dep = deploymentFromEnv(); if (!dep) throw new Error("--env <aigg-bnb .env.<network>>"); const key = process.env.PORW_CLIENT_KEY || process.env.PORW_DEPLOYER_KEY; if (!key) throw new Error("PORW_CLIENT_KEY or PORW_DEPLOYER_KEY");
  const base = args.relayer || `http://127.0.0.1:${process.env.PORW_API_PORT || 8788}`; const api = async (p, body) => (await fetch(base + p, body ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {})).json();
  const res = await runTasks(clients(dep, key), key, api, { fee: args.fee || "0.001", deadlineBlocks: Number(args.deadline || 600), only: args.only ? args.only.split(",") : null });
  fs.writeFileSync(path.join(here, `posted-${dep.chainId}.json`), JSON.stringify(res, null, 1)); console.log(`${res.filter((r) => r.settle?.ok).length}/${res.length} settled; record posted-${dep.chainId}.json`);
}
