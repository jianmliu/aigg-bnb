// What it takes to run the relayer behind a proxy on a host that routes one port per service.
// PORW_RELAY_PATH puts the relay hub on the API's own port under that path; PORW_PUBLIC_RELAY_URL is what
// browsers are told, because the address the process bound is an implementation detail and is wrong for anyone
// who is not on this machine -- before this the API handed every tab `ws://127.0.0.1:8787` and they all failed.
import * as H from "./harness.mjs";
let fails = 0; const check = (n, ok) => { console.log((ok ? "  ok   " : "  FAIL ") + n); if (!ok) fails++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (p, ms = 8000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await p()) return true; await sleep(50); } return false; };
const anvil = await H.startAnvil(8558);
try {
  const dep = await H.deploy(anvil.rpc);
  const { mepId } = await H.registerSyntheticMep(dep, H.KEYS[0]);
  const ANNOUNCED = "wss://relay.example.test/relay";
  const R = await H.startRelayer(dep, H.KEYS[3], [mepId], { env: { PORW_BEACON_LAZY: "1", PORW_RELAY_PATH: "/relay", PORW_PUBLIC_RELAY_URL: ANNOUNCED } });
  const d = await R.api("/deployment");
  check(`/deployment announces the public relay URL, not the bound address (${d.relay})`, d.relay === ANNOUNCED);

  // the hub really is on the API's port, under the path -- one port for both
  const apiUrl = new URL(R.apiBase); const local = `ws://${apiUrl.host}/relay`;
  const { RelayClient } = await H.porw("relay_client.js"); const { keypair } = await H.porw("claim.js"); const { topicMep } = await H.porw("envelope.js");
  const A = new RelayClient([local], keypair("0x" + "11".repeat(32))), B = new RelayClient([local], keypair("0x" + "22".repeat(32)));
  check("a client connects to the hub on the API's own port", (await A.connect()) === 1 && (await B.connect()) === 1);
  const got = []; B.subscribe(topicMep(mepId), (env) => got.push(env.payload.n));
  A.publish(topicMep(mepId), "claim", mepId, { n: 7 });
  check("and envelopes are forwarded normally through it", await waitFor(() => got.includes(7)));
  const wrongPath = new RelayClient([`ws://${apiUrl.host}/not-the-relay`], keypair("0x" + "33".repeat(32)), { reconnect: false });
  check("another path on the same port is not the hub", (await wrongPath.connect()) === 0);
  const st = await R.api("/status");
  check("the relayer's own aggregator client is connected through it too", st.relay.clients >= 3);
  check("the HTTP API still answers on that port", (await R.api("/epoch")).epoch >= 0);
  A.close(); B.close(); wrongPath.close(); R.stop();
} catch (e) { console.error(e); fails++; } finally { anvil.stop(); }
console.log(fails ? `${fails} FAILURES` : "ALL PASS"); process.exit(fails ? 1 : 0);
