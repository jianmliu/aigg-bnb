// The relayer's tick is one pass at a time. A tick awaits its transactions to a receipt, which outlasts the poll
// interval on a real chain (seconds on BSC against a 2 s poll), and what a tick has done is only recorded after
// that receipt -- so a tick started mid-pass sees the beacon commit still missing and sends it again. The chain
// refuses the duplicate ("committed"), but it lands in /status.errors as a failure that is not one; seen on the
// BSC testnet relayer, three per epoch. anvil mines a transaction before the next tick can start, which is why no
// other test sees this -- so here automine is off and the test is the miner, a block for whatever is pending every
// 300 ms, against a poll of 100 ms: every transaction of two epochs has ticks landing on top of it, as on a real
// chain. Each must be sent once, and nothing may revert.
import * as H from "./harness.mjs";
let fails = 0; const check = (n, ok) => { console.log((ok ? "  ok   " : "  FAIL ") + n); if (!ok) fails++; };
const anvil = await H.startAnvil(8565);
try {
  const dep = await H.deploy(anvil.rpc);
  const { mepId } = await H.registerSyntheticMep(dep, H.KEYS[0]);
  const R = await H.startRelayer(dep, H.KEYS[3], [mepId], { env: { PORW_POLL_MS: "100" } });
  await anvil.call("evm_setAutomine", [false]);
  const miner = setInterval(async () => { try { if (Number((await anvil.call("txpool_status")).pending)) await anvil.mine(1); } catch {} }, 300);
  const toBlock = async (b) => { const cur = await anvil.block(); if (b > cur) await anvil.mine(b - cur); };
  const waitFor = async (pred, ms = 15000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await pred()) return true; await H.sleep(100); } return false; };
  const S = () => R.api("/status");
  // walk an epoch the way a real chain arrives: commit window, reveal window, roll (as e2e_lazy_beacon does)
  const enterEpoch = async (e) => {
    await toBlock(e * 40 - 5); const c = await waitFor(async () => (await S()).commits.includes(e));
    await toBlock(e * 40 + 2); const r = await waitFor(async () => (await S()).reveals.includes(e));
    await toBlock(e * 40 + 12); const rolled = await waitFor(async () => (await S()).epochsRolled.includes(e));
    await H.sleep(1000); // a duplicate queued behind any of the three is sent, and refused, as soon as the first is mined
    return c && r && rolled;
  };
  check("epoch 1: committed, revealed and rolled", await enterEpoch(1));
  check("epoch 2: committed, revealed and rolled", await enterEpoch(2));
  const st = await S(); const sent = (p) => st.txs.filter((t) => t.label.startsWith(p)).length + st.errors.filter((x) => x.label.startsWith(p)).length;
  console.log(`relayer txs: ${st.txs.length} (${st.txs.filter((t) => t.ok).length} ok), errors: ${st.errors.length}${st.errors.length ? " " + JSON.stringify(st.errors.slice(0, 3)) : ""}`);
  check(`no tick re-sent what a tick in flight had already sent (${st.errors.length} errors: ${JSON.stringify([...new Set(st.errors.map((x) => x.label))])})`, st.errors.length === 0);
  check(`one commit, one reveal and one roll per epoch (${JSON.stringify({ commits: st.commits, reveals: st.reveals, epochsRolled: st.epochsRolled })})`, [st.commits, st.reveals, st.epochsRolled].every((a) => JSON.stringify(a) === "[1,2]"));
  check("and exactly those six transactions were attempted", sent("beacon.commit") === 2 && sent("beacon.reveal") === 2 && sent("claims.rollEpoch") === 2 && st.txs.length === 6);
  clearInterval(miner); R.stop();
} catch (e) { console.error(e); fails++; } finally { anvil.stop(); }
console.log(fails ? `${fails} FAILURES` : "ALL PASS"); process.exit(fails ? 1 : 0);
