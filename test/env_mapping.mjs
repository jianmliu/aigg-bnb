// Every PORW_* variable the relayer documents must actually reach its config. This is a dull test that exists
// because of a dull failure: a line comment added mid-line silently commented out `host`, `pollMs` and `name`,
// so PORW_HOST stopped being read and the relayer bound 127.0.0.1 on a host that routes to 0.0.0.0 -- valid
// JavaScript, every other test still green, and the service simply unreachable. Nothing here needs a chain.
import { relayerFromEnv, deploymentFromEnv } from "../relayer/env.mjs";
let fails = 0; const check = (n, ok) => { console.log((ok ? "  ok   " : "  FAIL ") + n); if (!ok) fails++; };
const A = "0x" + "11".repeat(20);
const env = {
  PORW_CHAIN_ID: "97", PORW_RPC: "https://rpc.example", PORW_EPOCH_BLOCKS: "800", PORW_NETWORK: "bsc-testnet",
  PORW_VERIFIER: A, PORW_MEP_REGISTRY: A, PORW_INSTANCES: A, PORW_BEACON: A, PORW_CLAIMS: A, PORW_MARKET: A, PORW_DISPUTES: A, PORW_RELAYS: A,
  PORW_RELAYER_KEY: "0x" + "22".repeat(32), PORW_MEP_IDS: "0xaa,0xbb", PORW_MEP_NAMES: "0xaa=female,0xbb=male",
  PORW_RELAY_PORT: "8787", PORW_API_PORT: "8788", PORW_HOST: "0.0.0.0", PORW_POLL_MS: "500", PORW_RELAYER_NAME: "n",
  PORW_BEACON_LAZY: "1", PORW_BEACON_WAKE_EPOCHS: "3", PORW_SPONSOR_EPOCH_GAS: "111", PORW_SPONSOR_DAY_GAS: "222",
  PORW_RELAY_PATH: "/relay", PORW_PUBLIC_RELAY_URL: "wss://example.org/relay",
};
Object.assign(process.env, env);
const r = relayerFromEnv(), d = deploymentFromEnv();
const want = {
  privateKey: env.PORW_RELAYER_KEY, meps: ["0xaa", "0xbb"], mepNames: { "0xaa": "female", "0xbb": "male" },
  relayPort: 8787, apiPort: 8788, host: "0.0.0.0", pollMs: 500, name: "n",
  beaconLazy: true, wakeEpochs: 3, sponsorEpochGas: 111, sponsorDayGas: 222, relayPath: "/relay", publicRelayUrl: "wss://example.org/relay",
};
for (const [k, v] of Object.entries(want)) check(`relayerFromEnv().${k}`, JSON.stringify(r[k]) === JSON.stringify(v));
check("relayerFromEnv() returns no undefined field (a field lost to an edit reads as undefined)", Object.keys(want).every((k) => r[k] !== undefined));
check("deploymentFromEnv(): chain, rpc, epoch blocks, and every address", d.chainId === 97 && d.rpc === env.PORW_RPC && d.epochBlocks === 800 && d.network === "bsc-testnet" && Object.values(d.addresses).every((x) => x === A) && Object.keys(d.addresses).length === 8);
// PORT is what a PaaS hands a process; PORW_API_PORT wins when both are set
delete process.env.PORW_API_PORT; process.env.PORT = "10000";
check("apiPort falls back to PORT", relayerFromEnv().apiPort === 10000);
process.env.PORW_API_PORT = "8788";
check("PORW_API_PORT still wins over PORT", relayerFromEnv().apiPort === 8788);
// unset means null, so a config file's value is left alone rather than overwritten with a default
for (const k of Object.keys(env)) delete process.env[k];
delete process.env.PORT;
const empty = relayerFromEnv();
check("with nothing set, every relayer field is null (the config file wins, nothing is clobbered)", Object.values(empty).every((v) => v === null));
check("with nothing set, deploymentFromEnv() is null rather than a half-built deployment", deploymentFromEnv() === null);
console.log(fails ? `${fails} FAILURES` : "ALL PASS"); process.exit(fails ? 1 : 0);
