// Two headless hosts of ONE brain on the live BSC testnet: what two browser tabs do, without the browser. They bond,
// delegate a session key through the relayer, hold the payload, claim every epoch and materialize the claim -- and then
// stay up, serving whatever task sortition sends them. Nothing here posts a task: that is the gateway's, or a client's.
//
// Two, because one provider's word is not a result: a task at redundancy 2 is drawn from the instances eligible for its
// MEP, and only agreeing results are paid. So both hosts hold the SAME brain.
//
//   source .env.bsc-testnet; source .env.hosts-testnet     (PORW_HOST_KEY_A, PORW_HOST_KEY_B: funded wallets)
//   PORW_RELAYER_API=https://… node test/live_hosts.mjs <payload.bin> [bondBNB=0.005] [--once]
// --once exits as soon as both are eligible (a check, not a host); otherwise it runs until it is killed.
import fs from "node:fs"; import path from "node:path";
import { parseEther, formatEther } from "viem";
import { deploymentFromEnv } from "../relayer/env.mjs"; import { clients } from "../relayer/chain.mjs";
import * as H from "./harness.mjs";
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const args = process.argv.slice(2).filter((a) => !a.startsWith("--")); const once = process.argv.includes("--once");
const [payloadPath, bondBnb = "0.005"] = args; if (!payloadPath) { console.log("usage: live_hosts.mjs <payload.bin> [bondBNB] [--once]"); process.exit(2); }
const API = (process.env.PORW_RELAYER_API || "http://127.0.0.1:8799").replace(/\/$/, "");
const api = async (p, body) => (await fetch(API + p, body ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {})).json();
const dep = deploymentFromEnv(); if (!dep) throw new Error("source .env.<network> first");
const keys = ["A", "B"].map((n) => process.env[`PORW_HOST_KEY_${n}`]).filter(Boolean); if (keys.length < 2) throw new Error("PORW_HOST_KEY_A and PORW_HOST_KEY_B (source .env.hosts-testnet)");

const d = await api("/deployment"); const domains = d.domains;
const E = await H.porw("eip712.js"); const { keypair } = await H.porw("claim.js"); const { PorwNode } = await H.porw("node.js"); const { loadKernelFromBytes } = await H.porw("porw.js");
const { RelayClient } = await H.porw("relay_client.js"); const { NodeService } = await H.porw("node_service.js");
const wasm = fs.readFileSync(path.join(H.porwDir, "sketch.wasm")); const payload = new Uint8Array(fs.readFileSync(payloadPath));
const STEPS = Number(process.env.PORW_STEPS || 100); // a slot's capacity: a task longer than this finds this host unable to run it
const stop = [];

/** one host: bonded, delegated, resident, serving */
async function host(name, pk) {
  const c = clients(dep, pk); const wallet = c.account.address;
  const bal = await c.pub.getBalance({ address: wallet });
  if (bal === 0n) throw new Error(`${name} ${wallet} holds nothing: it cannot bond`);
  // the brain first: its mep_id comes out of its bytes, and a bond enrols for a MEP in the same transaction
  const nd = new PorwNode(await loadKernelFromBytes(wasm), { privHex: H.hex(keypair(null).priv) });
  const t0 = Date.now(); const st = await nd.loadModel(path.basename(payloadPath, ".bin"), payload, { maxSteps: STEPS, exec: "lif" });
  const mepId = H.hex(st.mep.mepId);
  if ((await c.instances.read.bonded([wallet])) === 0n) {
    const need = parseEther(bondBnb); if (bal < need) throw new Error(`${name} ${wallet} holds ${formatEther(bal)} tBNB, less than the ${bondBnb} bond`);
    const h = await c.instances.write.bond([[mepId]], { value: need }); await c.pub.waitForTransactionReceipt({ hash: h }); log(`${name}: bonded ${bondBnb} tBNB and enrolled for the brain ${h}`);
  } else if (!(await c.instances.read.isBondedFor([wallet, mepId]))) { // bonded before, for something else: enrolling takes a payment
    const h = await c.instances.write.bond([[mepId]], { value: parseEther("0.0001") }); await c.pub.waitForTransactionReceipt({ hash: h }); log(`${name}: enrolled for the brain ${h}`);
  }
  const session = keypair(null); const lw = E.localWallet(pk);
  const del = await E.makeDelegation(lw, domains.registry, H.hex(session.address), Number(await c.pub.getBlockNumber()) + 200000);
  const dr = await api("/tx/delegate", { instance: del.instance, session: del.session, expiry: del.expiry, sig: del.sig });
  if (!dr.ok) throw new Error(`${name}: delegate failed ${dr.error || JSON.stringify(dr)}`);
  nd.key = session; nd.domains = domains; nd.delegation = del; // the session key signs the results, the wallet stays offline
  const rc = new RelayClient([d.relay], nd.key); await rc.connect(); stop.push(() => rc.close());
  const served = [];
  const svc = new NodeService(nd, rc, { onResult: async (res) => { const r = await api("/tx/result", res); served.push({ taskId: res.taskId, ok: r.ok, hash: r.hash, error: r.error });
    log(`${name}: task ${res.taskId.slice(0, 12)}… executed, submitResult ${r.ok ? "ok " + String(r.hash).slice(0, 12) + "…" : "FAILED " + r.error}`); } });
  svc.serve(st.mep.mepId); stop.push(() => svc.stop());
  log(`${name}: ${wallet} · ${st.hdr.neurons} neurons resident in ${((Date.now() - t0) / 1000).toFixed(1)}s · mep ${mepId.slice(0, 12)}… · ${await c.instances.read.weightOf([wallet])} vote(s), enrolled ${await c.instances.read.isBondedFor([wallet, mepId])}`);
  return { name, c, wallet, session, nd, st, mepId, svc, served, claims: {}, materialized: {} };
}

const hosts = []; for (const [i, k] of keys.entries()) hosts.push(await host(["A", "B"][i], k));
const mepId = hosts[0].mepId; if (hosts.some((h) => h.mepId !== mepId)) throw new Error("the hosts loaded different brains");
log(`both hosts on ${mepId} (relayer serves ${d.meps.includes(mepId.toLowerCase()) ? "it" : "OTHER brains: this one is not served"})`);

let woke = null;
for (;;) {
  try {
    const e = await api("/epoch?mep=" + mepId); const prev = e.epoch - 1;
    if (woke !== e.epoch) { woke = e.epoch; const w = await api("/wake", { instance: hosts[0].wallet }).catch(() => ({})); if (w.lazy) log(`epoch ${e.epoch}: woke the lazy beacon until ${w.wakeUntil}`); }
    for (const h of hosts) {
      if (e.rolled && !h.claims[e.epoch]) { const { r } = await h.svc.announce(h.st.mep.mepId, H.unhex(e.challenge)); h.claims[e.epoch] = H.hex(r.claimHash); log(`${h.name}: epoch ${e.epoch} claim announced`); }
      if (h.claims[prev] && !h.materialized[prev]) { const p = await api(`/proof?mep=${mepId}&epoch=${prev}&instance=${h.wallet}`);
        if (p.posted) { const r = await api("/tx/materialize", { mep: mepId, epoch: prev, instance: h.wallet }); h.materialized[prev] = !!r.ok; log(`${h.name}: epoch ${prev} claim materialized ${r.ok ? r.hash : "FAILED " + r.error}`); } }
    }
    const votes = await hosts[0].c.instances.read.eligibleVotes([mepId, BigInt(e.epoch)]);
    const eligible = new Set(votes.map((a) => a.toLowerCase())); const ready = hosts.filter((h) => eligible.has(h.wallet.toLowerCase()));
    log(`epoch ${e.epoch}${e.rolled ? "" : " (not rolled)"}: ${ready.length}/${hosts.length} eligible, ${votes.length} vote(s) for this brain${ready.length === hosts.length ? " -- a task at redundancy 2 can be drawn" : ""}`);
    if (once && ready.length === hosts.length) break;
  } catch (err) { log("loop:", String(err.shortMessage || err.message).slice(0, 200)); }
  await H.sleep(15000);
}
for (const f of stop) try { f(); } catch {}
process.exit(0);
