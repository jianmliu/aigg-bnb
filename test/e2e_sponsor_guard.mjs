// The sponsorship guard on a local anvil. Every /tx/* call spends the relayer's own BNB for somebody else, so
// each one must name a bonded instance, must simulate successfully (a reverted transaction still costs gas), and
// must fit a per-instance-per-epoch and a relayer-wide daily gas budget. What this proves, in order: an
// unattributed call is refused, an unbonded one is refused, a call that would revert is refused WITHOUT
// broadcasting anything, a good call goes through and is charged, and both budgets stop a caller who keeps going.
// The relayer runs with PORW_BEACON_LAZY=1 so it sends nothing of its own and every transaction in /status is one
// it was asked to sponsor. Budgets are set just under one delegateBySig (~55k gas) so two calls trip them.
import { parseEther } from "viem";
import * as H from "./harness.mjs";
let fails = 0; const check = (n, ok) => { console.log((ok ? "  ok   " : "  FAIL ") + n); if (!ok) fails++; };
const anvil = await H.startAnvil(8557);
try {
  const dep = await H.deploy(anvil.rpc);
  const { mepId } = await H.registerSyntheticMep(dep, H.KEYS[0]);
  const R = await H.startRelayer(dep, H.KEYS[3], [mepId], { env: { PORW_BEACON_LAZY: "1", PORW_SPONSOR_EPOCH_GAS: "50000", PORW_SPONSOR_DAY_GAS: "100000" } });
  const d = await R.api("/deployment"); const domains = d.domains;
  const E = await H.porw("eip712.js"); const { keypair } = await H.porw("claim.js");
  const sent = async () => (await R.api("/status")).txs.length;
  const sponsorOf = async () => (await R.api("/status")).sponsor;
  const bond = async (key) => { const c = H.clientsFor(dep, key); await c.pub.waitForTransactionReceipt({ hash: await c.instances.write.bond([[mepId]], { value: parseEther("0.5") }) }); return { c, wallet: E.localWallet(key) }; };
  const delegation = async (wallet, seed) => { const s = keypair("0x" + seed.repeat(32)); return await E.makeDelegation(wallet, domains.registry, H.hex(s.address), 100000); };
  const delegateCall = (del) => R.api("/tx/delegate", { instance: del.instance, session: del.session, expiry: del.expiry, sig: del.sig });

  check("the relayer is idle: lazy beacon, nothing sent yet", (await sent()) === 0 && (await sponsorOf()).epochGasLimit === 50000);

  // ---- 1. a sponsored call must say who it is for ----
  let n = await sent();
  const anon = await R.api("/tx/settle", { taskId: "0x" + "11".repeat(32) });
  check("settle with no instance named is refused, and nothing was broadcast", /no instance/.test(anon.error || "") && (await sent()) === n);

  // ---- 2. and that instance must be bonded ----
  const unbonded = await R.api("/tx/settle", { taskId: "0x" + "11".repeat(32), instance: "0x000000000000000000000000000000000000dEaD" });
  check("settle for an unbonded instance is refused, and nothing was broadcast", unbonded.error === "instance not bonded" && (await sent()) === n);

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
  const B = await bond(H.KEYS[2]);
  const d3 = await delegateCall(await delegation(B.wallet, "22"));
  check("a different bonded instance has its own epoch budget and is sponsored", d3.ok && (await sent()) === n + 1);

  // ---- 7. the relayer-wide daily cap stops everyone ----
  n = await sent();
  const C = await bond(H.KEYS[4]);
  const d4 = await delegateCall(await delegation(C.wallet, "44"));
  check(`a third instance is refused by the relayer's daily cap (${String(d4.error).slice(0, 70)}…)`, /daily/.test(d4.error || "") && (await sent()) === n);

  const sp = await sponsorOf();
  check("every refusal is recorded for the operator, with its reason", sp.refused.length === 5 && sp.refused.every((r) => r.label && r.why));
  const st = await R.api("/status");
  console.log(`sponsored txs: ${st.txs.length} (all ok: ${st.txs.every((t) => t.ok)}), refusals: ${sp.refused.length}, day gas ${sp.dayGas}/${sp.dayGasLimit}`);
  check("exactly the two affordable calls were paid for, and the relayer logged no errors", st.txs.length === 2 && st.txs.every((t) => t.ok) && st.errors.length === 0);
  R.stop();
} catch (e) { console.error(e); fails++; } finally { anvil.stop(); }
console.log(fails ? `${fails} FAILURES` : "ALL PASS"); process.exit(fails ? 1 : 0);
