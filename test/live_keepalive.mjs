// Does a relay connection survive being idle behind whatever is in front of the relayer? That is the one thing
// a local run can never answer: on one machine nothing is in a position to cut an idle WebSocket, so the ping
// and the reconnect are never exercised. Point this at a deployed relayer and it holds a connection open doing
// nothing for a while, then publishes -- which is exactly the shape of a browser tab between two epochs.
//   node test/live_keepalive.mjs https://relayer.example.org [idleSeconds=180]
//   node test/live_keepalive.mjs --ws wss://relayer.example.org/relay [idleSeconds]
// Before the keepalive fix this fails after the proxy's idle timeout (typically ~100 s) with "no relay
// connected", and it fails silently in production rather than loudly here.
import * as H from "./harness.mjs";
let fails = 0; const check = (n, ok) => { console.log((ok ? "  ok   " : "  FAIL ") + n); if (!ok) fails++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (p, ms = 20000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await p()) return true; await sleep(250); } return false; };
const args = process.argv.slice(2);
let wsUrl = null, base = null;
if (args[0] === "--ws") { wsUrl = args[1]; args.splice(0, 2); } else { base = (args.shift() || "").replace(/\/$/, ""); }
const idleS = Number(args[0] || 180);
if (!wsUrl && !base) { console.log("usage: live_keepalive.mjs <relayer api url> [idleSeconds] | --ws <wss url> [idleSeconds]"); process.exit(2); }
let mepId = "0x" + "ab".repeat(32);
if (base) {
  const d = await (await fetch(base + "/deployment")).json();
  wsUrl = d.relay; mepId = d.meps?.[0] || mepId;
  console.log(`relayer ${base}\n  announces relay ${wsUrl}\n  chain ${d.chainId}, mep ${String(mepId).slice(0, 12)}…`);
  check("the announced relay URL is one a browser could actually use (wss:// or ws://, not a bind address)", /^wss:\/\//.test(wsUrl) || (/^ws:\/\//.test(wsUrl) && !/127\.0\.0\.1|localhost|0\.0\.0\.0/.test(wsUrl)));
}
const { RelayClient } = await H.porw("relay_client.js"); const { keypair } = await H.porw("claim.js"); const { topicMep } = await H.porw("envelope.js");
const A = new RelayClient([wsUrl], keypair("0x" + "11".repeat(32)), { onLog: (m) => console.log("  A:", m) });
const B = new RelayClient([wsUrl], keypair("0x" + "22".repeat(32)), { onLog: (m) => console.log("  B:", m) });
check("both clients connected", (await A.connect()) === 1 && (await B.connect()) === 1);
const topic = topicMep(mepId);
const got = []; B.subscribe(topic, (env) => got.push(env.payload.n));
// The hub is stateless pub/sub with no replay, and a subscription racing a publish across two sockets can lose
// the first frame, so keep offering until it lands (or the window closes). Each attempt is a fresh envelope.
const deliver = async (n, ms = 25000) => { const t0 = Date.now(); while (Date.now() - t0 < ms && !got.includes(n)) { try { A.publish(topic, "claim", mepId, { n }); } catch {} await sleep(500); } return got.includes(n); };
check("a message gets through before the idle period", await deliver(1));

console.log(`\nidling ${idleS}s with no traffic at all — this is where an unattended connection used to die…`);
const t0 = Date.now(); let lastReport = 0;
while ((Date.now() - t0) / 1000 < idleS) {
  await sleep(1000);
  const el = Math.floor((Date.now() - t0) / 1000);
  if (el - lastReport >= 30) { lastReport = el; console.log(`  ${el}s: A ${A.socks[0].open ? "open" : "DOWN"} (${A.reconnects} redials), B ${B.socks[0].open ? "open" : "DOWN"} (${B.reconnects} redials)`); }
}
const redials = A.reconnects + B.reconnects;
console.log(redials ? `\nthe connection was cut ${redials}x and redialled — the reconnect half did the work` : "\nthe connection was never cut — the ping half kept it warm");
check("both clients are connected after the idle period", A.socks[0].open && B.socks[0].open);
check(`a message still gets through after ${idleS}s of silence (subscriptions survived)`, await deliver(2));
A.close(); B.close();
console.log(fails ? `${fails} FAILURES` : "ALL PASS"); process.exit(fails ? 1 : 0);
