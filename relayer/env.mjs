// Deployment + relayer settings from environment variables (PORW_*). An env file (deploy.sh writes
// .env.<network>) can be loaded with --env <file> or PORW_ENV_FILE; process env always wins.
// Addresses never live in git: deploy.sh writes them to the env file, and the relayer/frontend read them here.
export function loadEnv(file) { if (file) { try { process.loadEnvFile(file); } catch (e) { throw new Error(`cannot load env file ${file}: ${e.message}`); } } }
const need = (k) => { const v = process.env[k]; if (!v) throw new Error(`missing ${k} (source the .env.<network> written by deploy.sh)`); return v; };
export function deploymentFromEnv() {
  const e = process.env; if (!e.PORW_CLAIMS) return null;
  return { chainId: Number(need("PORW_CHAIN_ID")), rpc: need("PORW_RPC"), epochBlocks: Number(e.PORW_EPOCH_BLOCKS || 0), network: e.PORW_NETWORK || String(e.PORW_CHAIN_ID),
    addresses: { verifier: e.PORW_VERIFIER || null, meps: need("PORW_MEP_REGISTRY"), instances: need("PORW_INSTANCES"), beacon: e.PORW_BEACON || null, claims: need("PORW_CLAIMS"), market: need("PORW_MARKET"), disputes: e.PORW_DISPUTES || null, relays: e.PORW_RELAYS || null } };
}
export function relayerFromEnv() {
  const e = process.env; return { privateKey: e.PORW_RELAYER_KEY || null, meps: e.PORW_MEP_IDS ? e.PORW_MEP_IDS.split(",").map((s) => s.trim()).filter(Boolean) : null,
    mepNames: e.PORW_MEP_NAMES ? Object.fromEntries(e.PORW_MEP_NAMES.split(",").map((kv) => kv.split("=").map((s) => s.trim()))) : null,
    relayPort: e.PORW_RELAY_PORT ? Number(e.PORW_RELAY_PORT) : null, apiPort: e.PORW_API_PORT ? Number(e.PORW_API_PORT) : null, host: e.PORW_HOST || null, pollMs: e.PORW_POLL_MS ? Number(e.PORW_POLL_MS) : null, name: e.PORW_RELAYER_NAME || null };
}
