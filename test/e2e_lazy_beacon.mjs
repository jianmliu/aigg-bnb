// The lazy beacon (PORW_BEACON_LAZY=1) on a local anvil: a mesh nobody is using produces no beacon and costs
// nothing, a bonded instance wakes it with POST /wake, the epochs it asked for roll normally and carry claims,
// the beacon keeps going by itself for as long as claims keep arriving, and the mesh goes back to sleep once
// they stop. Epoch parameters come from the harness (EPOCH_BLOCKS 40, COMMIT/REVEAL 10), so epoch e starts at
// block 40e, its commit window is [40e-10, 40e) and its reveal window [40e, 40e+10).
import fs from "node:fs"; import path from "node:path";
import { parseEther } from "viem";
import * as H from "./harness.mjs";
let fails = 0; const check = (n, ok) => { console.log((ok ? "  ok   " : "  FAIL ") + n); if (!ok) fails++; };
const anvil = await H.startAnvil(8556);
try {
  const dep = await H.deploy(anvil.rpc);
  const { mep, mepId, payload, steps } = await H.registerSyntheticMep(dep, H.KEYS[0]);
  const R = await H.startRelayer(dep, H.KEYS[3], [mepId], { env: { PORW_BEACON_LAZY: "1", PORW_BEACON_WAKE_EPOCHS: "2" } });
  const d = await R.api("/deployment"); const domains = d.domains;
  const toBlock = async (b) => { const cur = await anvil.block(); if (b > cur) await anvil.mine(b - cur); };
  const waitFor = async (pred, ms = 15000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await pred()) return true; await H.sleep(200); } return false; };
  const settle = () => H.sleep(1500); // a few relayer ticks at PORW_POLL_MS=500
  const S = () => R.api("/status");
  // anvil_mine jumps instantly, so walk an epoch the way a real chain arrives: commit window, reveal window, roll
  const enterEpoch = async (e) => {
    await toBlock(e * 40 - 5); const c = await waitFor(async () => (await S()).commits.includes(e));
    await toBlock(e * 40 + 2); const r = await waitFor(async () => (await S()).reveals.includes(e));
    await toBlock(e * 40 + 12); const rolled = await waitFor(async () => (await S()).epochsRolled.includes(e));
    return { c, r, rolled };
  };

  // ---- 1. nobody is here: the commit window for epoch 1 passes without a commit ----
  await toBlock(33); await settle();
  const s1 = await R.api("/status");
  check("lazy mode on, and no beacon commit for epoch 1 while nothing has asked for one", s1.beacon.lazy && s1.beacon.warm === false && !s1.commits.includes(1));
  await toBlock(55); await settle();
  const e1 = await R.api("/epoch");
  check("epoch 1 is cold: no beacon, the claim manager never rolled it, zero gas spent", e1.epoch === 1 && !e1.rolled && e1.lazy && !e1.warm && (await R.api("/status")).txs.length === 0);

  // ---- 2. /wake is for bonded instances only ----
  const stranger = await R.api("/wake", { instance: "0x000000000000000000000000000000000000dEaD" });
  check("/wake from an address with no sortition weight is refused", /no sortition weight/.test(stranger.error || "") && (await R.api("/status")).beacon.warm === false);

  // ---- 3. a real instance bonds, delegates and wakes the mesh ----
  const E = await H.porw("eip712.js"); const { keypair } = await H.porw("claim.js"); const { PorwNode } = await H.porw("node.js"); const { loadKernelFromBytes } = await H.porw("porw.js"); const { RelayClient } = await H.porw("relay_client.js"); const { NodeService } = await H.porw("node_service.js");
  const c = H.clientsFor(dep, H.KEYS[1]); const wallet = E.localWallet(H.KEYS[1]); const session = keypair("0x" + "11".repeat(32));
  await c.pub.waitForTransactionReceipt({ hash: await c.instances.write.bond([[mepId]], { value: parseEther("0.5") }) });
  const del = await E.makeDelegation(wallet, domains.registry, H.hex(session.address), 100000);
  await R.api("/tx/delegate", { instance: del.instance, session: del.session, expiry: del.expiry, sig: del.sig });
  const woke = await R.api("/wake", { instance: wallet.address });
  check(`a bonded instance wakes the beacon for the next two epochs (${JSON.stringify(woke)})`, woke.ok && woke.wakeUntil === woke.epoch + 2);

  // ---- 4. the epochs it asked for are produced normally ----
  const r2 = await enterEpoch(2);
  check("epoch 2: committed, revealed and rolled once it had been asked for", r2.c && r2.r && r2.rolled);
  const ep2 = await R.api("/epoch?mep=" + mepId);
  check("epoch 2 has a beacon and a challenge", ep2.rolled && ep2.challenge.length === 66);

  // ---- 5. a claim in epoch 2, and the beacon now keeps itself going without another wake ----
  const wasm = fs.readFileSync(path.join(H.porwDir, "sketch.wasm"));
  const nd = new PorwNode(await loadKernelFromBytes(wasm), { privHex: "0x" + "11".repeat(32), domains, delegation: del }); await nd.loadModel("flywire-female", payload, { steps });
  const rc = new RelayClient([d.relay], nd.key); await rc.connect(); const svc = new NodeService(nd, rc, {}); svc.serve(mep.mepId);
  await svc.announce(mep.mepId, H.unhex(ep2.challenge), { stimulusSeed: 1 });
  check("the relayer's aggregator collected the epoch-2 claim", await waitFor(async () => (await R.api("/status")).aggregators[0].epochs.some((x) => x.epoch === 2 && x.claims === 1)));
  await toBlock(113); check("beacon committed for epoch 3, kept warm by the epoch-2 claim", await waitFor(async () => (await S()).commits.includes(3)));
  // epoch 3 is skipped past its reveal window on purpose: this is what a relayer that restarted, or whose commit
  // failed, looks like. The epoch gets no beacon and never rolls -- and the epoch-2 root must still be posted,
  // or the claim collected in epoch 2 would be stranded with no way to materialize it.
  await toBlock(132); await settle();
  const s3 = await S();
  check("epoch 3 got no beacon and never rolled (reveal window missed)", !s3.reveals.includes(3) && !s3.epochsRolled.includes(3));
  check("the epoch-2 root was posted anyway, during the unrolled epoch 3", await waitFor(async () => (await S()).rootsPosted.some((r) => r.epoch === 2 && r.count === 1)));
  const m = await R.api("/tx/materialize", { mep: mepId, epoch: 2, instance: wallet.address.toLowerCase() });
  check(`the epoch-2 claim still materializes through the relayer (gas ${m.gasUsed})`, m.ok && (await c.claims.read.hasValidClaim([wallet.address, mepId, 2n])));
  await toBlock(4 * 40 - 5); // the wake window expired two epochs ago: the collected claim is what keeps it warm now
  const byClaims = await waitFor(async () => { const s = await S(); return s.beacon.warm && s.beacon.reason.startsWith("claims collected"); });
  const r4 = await enterEpoch(4);
  check("epoch 4 produced on the strength of the epoch-2 claim alone, with the wake window long expired", byClaims && r4.c && r4.rolled);

  // ---- 6. the node goes away: the mesh puts itself back to sleep ----
  rc.close();
  await toBlock(193);
  const wentCold = await waitFor(async () => (await S()).beacon.warm === false);
  const cold = await S();
  check("the relayer went cold again once the claims aged out, and skipped the epoch-5 commit", wentCold && !cold.commits.includes(5) && cold.beacon.reason.startsWith("cold"));
  await toBlock(215); await settle();
  const e5 = await R.api("/epoch");
  check("epoch 5 is cold again: the mesh is asleep and spending nothing", e5.epoch === 5 && !e5.rolled);
  check(`only the epochs that were asked for were paid for (commits ${JSON.stringify(cold.commits)})`, JSON.stringify(cold.commits) === "[2,3,4]");
  const st = await S();
  console.log(`relayer txs: ${st.txs.length} (${st.txs.filter((t) => t.ok).length} ok), errors: ${st.errors.length}${st.errors.length ? " " + JSON.stringify(st.errors.slice(0, 3)) : ""}`);
  check("no relayer errors", st.errors.length === 0);
  R.stop();
} catch (e) { console.error(e); fails++; } finally { anvil.stop(); }
console.log(fails ? `${fails} FAILURES` : "ALL PASS"); process.exit(fails ? 1 : 0);
