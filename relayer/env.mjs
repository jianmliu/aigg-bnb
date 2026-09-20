// Deployment + relayer settings from environment variables (PORW_*). An env file (deploy.sh writes
// .env.<network>) can be loaded with --env <file> or PORW_ENV_FILE; process env always wins.
// Addresses never live in git: deploy.sh writes them to the env file, and the relayer/frontend read them here.
export function loadEnv(file) { if (file) { try { process.loadEnvFile(file); } catch (e) { throw new Error(`cannot load env file ${file}: ${e.message}`); } } }
const need = (k) => { const v = process.env[k]; if (!v) throw new Error(`missing ${k} (source the .env.<network> written by deploy.sh)`); return v; };
export function deploymentFromEnv() {
  const e = process.env; if (!e.PORW_CLAIMS) return null;
  return { batteryApi: e.PORW_BATTERY_API || null, tokenBatteryApi: e.PORW_TOKEN_BATTERY_API || null, chainId: Number(need("PORW_CHAIN_ID")), rpc: need("PORW_RPC"), epochBlocks: Number(e.PORW_EPOCH_BLOCKS || 0), network: e.PORW_NETWORK || String(e.PORW_CHAIN_ID),
    addresses: { verifier: e.PORW_VERIFIER || null, meps: need("PORW_MEP_REGISTRY"), instances: need("PORW_INSTANCES"), beacon: e.PORW_BEACON || null, claims: need("PORW_CLAIMS"), market: need("PORW_MARKET"), disputes: e.PORW_DISPUTES || null, relays: e.PORW_RELAYS || null,
      batteryBudget: e.PORW_BATTERY_BUDGET || null,
      tokenBatteryBudget: e.PORW_TOKEN_BATTERY_BUDGET || null,
      inventorySale: e.PORW_INVENTORY_SALE || null,
      collection: e.PORW_COLLECTION || null, // FlyCollection: set it and the relayer hatches its eggs (the keeper)
      whitelist: e.PORW_WHITELIST || null } }; // CollectionWhitelist: which collections' brains are the system's; served to the page over /deployment
}
export function relayerFromEnv() {
  const e = process.env; return { privateKey: e.PORW_RELAYER_KEY || null, meps: e.PORW_MEP_IDS ? e.PORW_MEP_IDS.split(",").map((s) => s.trim()).filter(Boolean) : null,
    mepNames: e.PORW_MEP_NAMES ? Object.fromEntries(e.PORW_MEP_NAMES.split(",").map((kv) => kv.split("=").map((s) => s.trim()))) : null,
    relayPort: e.PORW_RELAY_PORT ? Number(e.PORW_RELAY_PORT) : null, apiPort: e.PORW_API_PORT ? Number(e.PORW_API_PORT) : (e.PORT ? Number(e.PORT) : null), // PORT: what a PaaS hands us
    host: e.PORW_HOST || null, pollMs: e.PORW_POLL_MS ? Number(e.PORW_POLL_MS) : null, name: e.PORW_RELAYER_NAME || null,
    // lazy beacon: only commit for an epoch somebody will use (PORW_BEACON_LAZY=1). null leaves a config file's value alone.
    beaconLazy: e.PORW_BEACON_LAZY == null ? null : (e.PORW_BEACON_LAZY === "1" || e.PORW_BEACON_LAZY === "true"),
    wakeEpochs: e.PORW_BEACON_WAKE_EPOCHS ? Number(e.PORW_BEACON_WAKE_EPOCHS) : null,
    // sponsorship budgets, in gas: per instance per epoch, and across everyone per rolling day
    sponsorEpochGas: e.PORW_SPONSOR_EPOCH_GAS ? Number(e.PORW_SPONSOR_EPOCH_GAS) : null,
    sponsorDayGas: e.PORW_SPONSOR_DAY_GAS ? Number(e.PORW_SPONSOR_DAY_GAS) : null,
    // hosting: serve the relay hub on the API's own port under this path (single-port hosts), and tell browsers
    // the URL they can actually reach us on rather than whatever address we happened to bind
    relayPath: e.PORW_RELAY_PATH || null, publicRelayUrl: e.PORW_PUBLIC_RELAY_URL || null,
    // PORW_KEEPER=0 still names PORW_COLLECTION to the page over /deployment, but leaves its eggs to somebody else
    // whose tasks this relayer sponsors. Unset: anybody's. Set: only tasks posted by these addresses -- third-party tasks are not open yet
    taskClients: e.PORW_TASK_CLIENTS ? e.PORW_TASK_CLIENTS.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean) : null,
    // Where a brain's bytes can be fetched from BESIDES the storage provider its MEP pins. A brain is content
    // addressed -- the loader recomputes model_id and compares it with the chain -- so a mirror cannot lie, only
    // fail, and that is what makes an ordinary static host safe here. It is also what keeps one SP from being a
    // single point of failure for every host of a collection, and keeps a hundred hosts pulling the same 77 MB
    // base off a paid read quota. URL prefixes; `gnfd://bucket/object` is appended as `bucket/object`.
    brainMirrors: e.PORW_BRAIN_MIRRORS ? e.PORW_BRAIN_MIRRORS.split(",").map((s) => s.trim().replace(/\/$/, "")).filter(Boolean) : null,
    // how often (in blocks) the collections on PORW_WHITELIST are walked for brains to serve
    whitelistEvery: e.PORW_WHITELIST_EVERY ? Number(e.PORW_WHITELIST_EVERY) : null,
    keeper: e.PORW_KEEPER == null ? null : !(e.PORW_KEEPER === "0" || e.PORW_KEEPER === "false") };
}
