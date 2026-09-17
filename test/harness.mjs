// Local end-to-end harness: anvil + DeployBNB (small epoch parameters) + a registered MEP over a synthetic
// brain + the relayer as a child process. Blocks are advanced with anvil_mine so epochs are deterministic.
import { spawn, fork } from "node:child_process"; import fs from "node:fs"; import path from "node:path"; import { fileURLToPath } from "node:url";
import { createPublicClient, createWalletClient, http, defineChain, getContract, parseEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { MEPRegistryAbi, InstanceRegistryAbi, ClaimManagerAbi, TaskMarketAbi } from "../relayer/abi.mjs";
import { eip712Domains } from "../relayer/chain.mjs";
export const here = path.dirname(fileURLToPath(import.meta.url)); export const root = path.join(here, "..");
export const porwDir = path.join(root, "contracts/lib/aigg-porw/web/porw-browser"); export const porw = (f) => import(path.join(porwDir, f));
export const FOUNDRY = process.env.FOUNDRY_BIN || "/root/.foundry171";
// anvil's deterministic accounts
export const KEYS = ["0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80", "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d", "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a", "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6", "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a"];
export const hex = (b) => "0x" + Array.from(b, (x) => x.toString(16).padStart(2, "0")).join(""); export const unhex = (s) => Uint8Array.from(s.slice(2).match(/../g).map((h) => parseInt(h, 16)));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rpcCall = async (rpc, method, params = []) => (await (await fetch(rpc, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) })).json()).result;

export async function startAnvil(port = 8555) {
  const p = spawn(path.join(FOUNDRY, "anvil"), ["--port", String(port), "--silent", "--chain-id", "31337"], { stdio: "ignore" });
  const rpc = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 60; i++) { try { if (await rpcCall(rpc, "eth_chainId")) break; } catch {} await sleep(250); }
  return { proc: p, rpc, mine: (n) => rpcCall(rpc, "anvil_mine", ["0x" + n.toString(16)]), block: async () => Number(await rpcCall(rpc, "eth_blockNumber")), stop: () => p.kill() };
}
export async function deploy(rpc, env = {}) {
  const e = { ...process.env, PATH: `${FOUNDRY}:${process.env.PATH}`, EPOCH_BLOCKS: "40", COMMIT_BLOCKS: "10", REVEAL_BLOCKS: "10", EXIT_DELAY: "5", OPENING_WINDOW: "10", TASK_TIMEOUT: "30", ROUND_BLOCKS: "10", ...env };
  await new Promise((res, rej) => { const p = spawn(path.join(FOUNDRY, "forge"), ["script", "script/DeployBNB.s.sol", "--rpc-url", rpc, "--chain-id", "31337", "--private-key", KEYS[0], "--broadcast"], { cwd: path.join(root, "contracts"), env: e, stdio: ["ignore", "pipe", "pipe"] }); let out = ""; p.stdout.on("data", (d) => (out += d)); p.stderr.on("data", (d) => (out += d)); p.on("exit", (c) => (c === 0 ? res() : rej(new Error("deploy failed: " + out.slice(-800))))); });
  const dep = JSON.parse(fs.readFileSync(path.join(root, "deployments/31337.json"), "utf8")); dep.rpc = rpc; return dep;
}
export function clientsFor(dep, key) {
  const chain = defineChain({ id: dep.chainId, name: "anvil", nativeCurrency: { name: "BNB", symbol: "BNB", decimals: 18 }, rpcUrls: { default: { http: [dep.rpc] } } });
  const pub = createPublicClient({ chain, transport: http(dep.rpc) }); const account = privateKeyToAccount(key); const wallet = createWalletClient({ chain, transport: http(dep.rpc), account });
  const c = (address, abi) => getContract({ address, abi, client: { public: pub, wallet } }); const a = dep.addresses;
  return { pub, wallet, account, meps: c(a.meps, MEPRegistryAbi), instances: c(a.instances, InstanceRegistryAbi), claims: c(a.claims, ClaimManagerAbi), market: c(a.market, TaskMarketAbi) };
}
/** register a MEP for a synthetic v1 brain: returns { mep, mepId, payload, st } (st from a throwaway node: synapseRoot) */
export async function registerSyntheticMep(dep, key, { name = "flywire-female", neurons = 4000, synapses = 40000, steps = 2 } = {}) {
  const { synthesizePayload } = await porw("synth.js"); const { PorwNode } = await porw("node.js"); const { loadKernelFromBytes } = await porw("porw.js");
  const payload = synthesizePayload(name, neurons, synapses); const wasm = fs.readFileSync(path.join(porwDir, "sketch.wasm"));
  const nd = new PorwNode(await loadKernelFromBytes(wasm), { privHex: KEYS[4] }); const st = await nd.loadModel(name, payload, { steps }); const mep = st.mep;
  const c = clientsFor(dep, key);
  const h = await c.meps.write.registerMEP([{ modelId: hex(mep.modelId), schemeDigest: hex(mep.schemeDigest), execKind: hex(mep.execKind), steps: mep.steps, clampQ16: mep.clampQ16, neurons: st.hdr.neurons, synapses: st.hdr.synapses, synapseRoot: hex(st.csr.synapseRoot), weightsDA: "0x" + Buffer.from(`gnfd://aigg-brains/${name}.bin`).toString("hex") }]);
  await c.pub.waitForTransactionReceipt({ hash: h });
  return { mep, mepId: hex(mep.mepId), payload, st, steps };
}
export async function startRelayer(dep, key, mepIds, { relayPort = 0, apiPort = 0 } = {}) {
  // the production path: everything from PORW_* environment variables (what deploy.sh's .env.<network> provides)
  const a = dep.addresses; const env = { ...process.env, PORW_NETWORK: "anvil", PORW_CHAIN_ID: String(dep.chainId), PORW_RPC: dep.rpc, PORW_EPOCH_BLOCKS: String(dep.epochBlocks), PORW_VERIFIER: a.verifier, PORW_MEP_REGISTRY: a.meps, PORW_INSTANCES: a.instances, PORW_BEACON: a.beacon, PORW_CLAIMS: a.claims, PORW_MARKET: a.market, PORW_DISPUTES: a.disputes, PORW_RELAYS: a.relays,
    PORW_RELAYER_KEY: key, PORW_MEP_IDS: mepIds.join(","), PORW_RELAY_PORT: String(relayPort), PORW_API_PORT: String(apiPort), PORW_POLL_MS: "500", PORW_RELAYER_NAME: "test-relayer" };
  const child = fork(path.join(root, "relayer/relayer.mjs"), [], { env, stdio: ["ignore", "pipe", "pipe", "ipc"] }); let log = ""; child.stdout.on("data", (d) => (log += d)); child.stderr.on("data", (d) => (log += d));
  const info = await new Promise((res, rej) => { child.on("message", res); child.on("exit", (c) => rej(new Error("relayer exited " + c + "\n" + log))); setTimeout(() => rej(new Error("relayer start timeout\n" + log)), 60000); });
  const api = async (p, body) => (await fetch(info.api + p, body ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {})).json();
  return { ...info, apiBase: info.api, child, api, log: () => log, stop: () => child.kill() };
}
export const domainsOf = eip712Domains;
export { sleep };
