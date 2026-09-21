// The sponsorship guard on a local anvil. Every /tx/* call spends the relayer's own BNB for somebody else, so
// each one must name a bonded instance, must simulate successfully (a reverted transaction still costs gas), and
// must fit a per-instance-per-epoch and a relayer-wide daily gas budget. What this proves, in order: an
// unattributed call is refused, an unbonded one is refused, a call that would revert is refused WITHOUT
// broadcasting anything, a good call goes through and is charged, and both budgets stop a caller who keeps going.
// The relayer runs with PORW_BEACON_LAZY=1 so it sends nothing of its own and every transaction in /status is one
// it was asked to sponsor. Budgets cover one delegateBySig plus estimation margin; the next call cannot fit.
import { parseEther } from "viem";
import * as H from "./harness.mjs";
let fails = 0; const check = (n, ok) => { console.log((ok ? "  ok   " : "  FAIL ") + n); if (!ok) fails++; };
const anvil = await H.startAnvil(Number(process.env.SPONSOR_TEST_PORT || 8557));
try {
  const dep = await H.deploy(anvil.rpc);
  const { mepId } = await H.registerSyntheticMep(dep, H.KEYS[0]);
  const R = await H.startRelayer(dep, H.KEYS[3], [mepId], { env: { PORW_BEACON_LAZY: "1", PORW_SPONSOR_EPOCH_GAS: "80000", PORW_SPONSOR_DAY_GAS: "150000" } });
  const d = await R.api("/deployment"); const domains = d.domains;
  const E = await H.porw("eip712.js"); const { keypair } = await H.porw("claim.js");
  const sent = async () => (await R.api("/status")).txs.length;
  const sponsorOf = async () => (await R.api("/status")).sponsor;
  const bond = async (key) => { const c = H.clientsFor(dep, key); await c.pub.waitForTransactionReceipt({ hash: await c.instances.write.bond([[mepId]], { value: parseEther("0.5") }) }); return { c, wallet: E.localWallet(key) }; };
  const delegation = async (wallet, seed) => { const s = keypair("0x" + seed.repeat(32)); return await E.makeDelegation(wallet, domains.registry, H.hex(s.address), 100000); };
  const delegateCall = (del) => R.api("/tx/delegate", { instance: del.instance, session: del.session, expiry: del.expiry, sig: del.sig });

  check("the relayer is idle: lazy beacon, nothing sent yet", (await sent()) === 0 && (await sponsorOf()).epochGasLimit === 80000);

  // ---- 1. a sponsored call must say who it is for ----
  let n = await sent();
  const anon = await R.api("/tx/settle", { taskId: "0x" + "11".repeat(32) });
  check("settle with no instance named is refused, and nothing was broadcast", /no instance/.test(anon.error || "") && (await sent()) === n);

  // ---- 2. and that instance must carry real weight, not a token bond ----
  const unbonded = await R.api("/tx/settle", { taskId: "0x" + "11".repeat(32), instance: "0x000000000000000000000000000000000000dEaD" });
  check("settle for an instance that never bonded is refused, and nothing was broadcast", /no sortition weight/.test(unbonded.error || "") && (await sent()) === n);
  // bond() only requires msg.value > 0, so a wei buys a bond. It must not buy a sponsorship budget: otherwise the
  // per-instance limit costs a Sybil one wei per budget and only the relayer-wide daily cap does any work.
  const dust = H.clientsFor(dep, H.KEYS[2]); await dust.pub.waitForTransactionReceipt({ hash: await dust.instances.write.bond([[mepId]], { value: 1n }) });
  check("a one-wei bond is a real bond on-chain", (await dust.instances.read.bonded([dust.account.address])) === 1n && (await dust.instances.read.weightOf([dust.account.address])) === 0n);
  const dustCall = await R.api("/tx/settle", { taskId: "0x" + "11".repeat(32), instance: dust.account.address });
  check("but it buys no sponsorship: refused for want of sortition weight, nothing broadcast", /no sortition weight/.test(dustCall.error || "") && (await sent()) === n);

  // ---- 3. the simulation guard: a call that would revert costs the relayer nothing ----
  const A = await bond(H.KEYS[1]);
  const doomed = await R.api("/tx/settle", { taskId: "0x" + "22".repeat(32), instance: A.wallet.address });
  check(`a bonded instance's settle of a nonexistent task is refused before signing (${String(doomed.error).slice(0, 60)}…)`, /would revert/.test(doomed.error || "") && (await sent()) === n);

  // ---- 4. a good call goes through and is charged ----
  const d1 = await delegateCall(await delegation(A.wallet, "11"));
  check(`a valid delegateBySig is sponsored (gas ${d1.gasUsed})`, d1.ok && (await sent()) === n + 1);
  const s1 = await sponsorOf();
  check(`the gas was charged against the daily budget (${s1.dayGas}/${s1.dayGasLimit})`, s1.dayGas === d1.gasUsed);

  // ---- 5. the per-instance, per-epoch budget stops the same caller looping ----
  n = await sent();
  const d2 = await delegateCall(await delegation(A.wallet, "aa"));
  check(`the same instance's next call is refused by its epoch budget (${String(d2.error).slice(0, 70)}…)`, /epoch/.test(d2.error || "") && (await sent()) === n);

  // ---- 6. a different instance still has its own budget ----
  const B = await bond(H.KEYS[2]); // tops the one-wei bond above up past a UNIT
  const d3 = await delegateCall(await delegation(B.wallet, "22"));
  check("a different bonded instance has its own epoch budget and is sponsored", d3.ok && (await sent()) === n + 1);

  // ---- 7. the relayer-wide daily cap stops everyone ----
  n = await sent();
  const C = await bond(H.KEYS[4]);
  const d4 = await delegateCall(await delegation(C.wallet, "44"));
  check(`a third instance is refused by the relayer's daily cap (${String(d4.error).slice(0, 70)}…)`, /daily/.test(d4.error || "") && (await sent()) === n);

  const sp = await sponsorOf();
  check("every refusal is recorded for the operator, with its reason", sp.refused.length === 6 && sp.refused.every((r) => r.label && r.why));
  const st = await R.api("/status");
  console.log(`sponsored txs: ${st.txs.length} (all ok: ${st.txs.every((t) => t.ok)}), refusals: ${sp.refused.length}, day gas ${sp.dayGas}/${sp.dayGasLimit}`);
  check("exactly the two affordable calls were paid for, and the relayer logged no errors", st.txs.length === 2 && st.txs.every((t) => t.ok) && st.errors.length === 0);
  R.stop();

  // Concurrent requests must not all pass the same unused budget while the first receipt is pending.
  for (const [label, limits, wallets] of [
    ["epoch", { PORW_SPONSOR_EPOCH_GAS: "80000", PORW_SPONSOR_DAY_GAS: "10000000" }, [A.wallet, A.wallet, A.wallet]],
    ["daily", { PORW_SPONSOR_EPOCH_GAS: "10000000", PORW_SPONSOR_DAY_GAS: "80000" }, [A.wallet, B.wallet, C.wallet]],
  ]) {
    const Q = await H.startRelayer(dep, H.KEYS[3], [mepId], { env: { PORW_BEACON_LAZY: "1", ...limits } });
    try {
      const dels = await Promise.all(wallets.map((w, i) => delegation(w, (label === "epoch" ? ["55", "66", "77"] : ["88", "99", "bb"])[i])));
      const rs = await Promise.all(dels.map((del) => Q.api("/tx/delegate", { instance: del.instance, session: del.session, expiry: del.expiry, sig: del.sig })));
      const qs = await Q.api("/status");
      check(`concurrent requests respect the ${label} budget`, rs.filter((r) => r.ok).length === 1 && rs.filter((r) => new RegExp(label).test(r.error || "")).length === 2 && qs.txs.length === 1);
    } finally { Q.stop(); }
  }
} catch (e) { console.error(e); fails++; } finally { anvil.stop(); }
console.log(fails ? `${fails} FAILURES` : "ALL PASS"); process.exit(fails ? 1 : 0);
