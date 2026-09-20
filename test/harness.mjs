// Local end-to-end harness: anvil + DeployBNB (small epoch parameters) + a registered MEP over a synthetic
// brain + the relayer as a child process. Blocks are advanced with anvil_mine so epochs are deterministic.
import { spawn, fork, spawnSync } from "node:child_process"; import fs from "node:fs"; import path from "node:path"; import { fileURLToPath } from "node:url";
import { createPublicClient, createWalletClient, http, defineChain, getContract, parseEther, keccak256, encodeAbiParameters, encodePacked } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { MEPRegistryAbi, InstanceRegistryAbi, ClaimManagerAbi, TaskMarketAbi } from "../relayer/abi.mjs";
import { eip712Domains } from "../relayer/chain.mjs";
export const here = path.dirname(fileURLToPath(import.meta.url)); export const root = path.join(here, "..");
export const porwDir = path.join(root, "contracts/lib/aigg-porw/web/porw-browser"); export const porw = (f) => import(path.join(porwDir, f));
export const FOUNDRY = process.env.FOUNDRY_BIN || "/root/.foundry171";
// anvil's deterministic accounts
export const KEYS = ["0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80", "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d", "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a", "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6", "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a"];
export const hex = (b) => "0x" + Array.from(b, (x) => x.toString(16).padStart(2, "0")).join(""); export const unhex = (s) => Uint8Array.from(s.slice(2).match(/../g).map((h) => parseInt(h, 16)));
/** taskId = keccak256(abi.encode(Task, nonce)): the id binds every field of the task, fee and deadline included */
export const TASK_TUPLE = { type: "tuple", components: [{ name: "mepId", type: "bytes32" }, { name: "stimulusSeed", type: "uint32" }, { name: "steps", type: "uint32" }, { name: "commitStride", type: "uint32" },
  { name: "initStateRoot", type: "bytes32" }, { name: "fee", type: "uint256" }, { name: "deadline", type: "uint64" }, { name: "redundancy", type: "uint8" }] };
export const taskIdOf = (t, nonce) => keccak256(encodeAbiParameters([TASK_TUPLE, { type: "bytes32" }], [t, nonce]));
/** PorwMeshHash.batchId: a batch is never the single task with the same fields */
export const batchIdOf = (t, runs, nonce) => keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "uint32" }], [taskIdOf(t, nonce), runs]));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rpcCall = async (rpc, method, params = []) => (await (await fetch(rpc, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) })).json()).result;

export async function startAnvil(port = 8555) {
  const p = spawn(path.join(FOUNDRY, "anvil"), ["--port", String(port), "--silent", "--chain-id", "31337"], { stdio: "ignore" });
  const rpc = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 60; i++) { try { if (await rpcCall(rpc, "eth_chainId")) break; } catch {} await sleep(250); }
  return { proc: p, rpc, call: (method, params) => rpcCall(rpc, method, params), mine: (n) => rpcCall(rpc, "anvil_mine", ["0x" + n.toString(16)]), block: async () => Number(await rpcCall(rpc, "eth_blockNumber")), stop: () => p.kill() };
}
export async function deploy(rpc, env = {}) {
  const e = { ...process.env, PATH: `${FOUNDRY}:${process.env.PATH}`, EPOCH_BLOCKS: "40", COMMIT_BLOCKS: "10", REVEAL_BLOCKS: "10", EXIT_DELAY: "5", OPENING_WINDOW: "10", TASK_TIMEOUT: "30", ROUND_BLOCKS: "10", ...env };
  await new Promise((res, rej) => { const p = spawn(path.join(FOUNDRY, "forge"), ["script", "script/DeployBNB.s.sol", "--rpc-url", rpc, "--chain-id", "31337", "--private-key", KEYS[0], "--broadcast"], { cwd: path.join(root, "contracts"), env: e, stdio: ["ignore", "pipe", "pipe"] }); let out = ""; p.stdout.on("data", (d) => (out += d)); p.stderr.on("data", (d) => (out += d)); p.on("exit", (c) => (c === 0 ? res() : rej(new Error("deploy failed: " + out.slice(-800))))); });
  const dep = JSON.parse(fs.readFileSync(path.join(root, "deployments/31337.json"), "utf8")); dep.rpc = rpc;
  // the file is written from the script's SIMULATION: a contract created outside the broadcast has an address there and
  // no code on the chain. Every address the deployment names has to be a contract.
  const pub = createPublicClient({ transport: http(rpc) });
  for (const [name, address] of Object.entries(dep.addresses)) if (typeof address === "string" /* forge's serializer leaves chainId and epochBlocks in here too */ && !(await pub.getCode({ address }))) throw new Error(`deployments/31337.json names ${name} at ${address}, and there is no contract there`);
  return dep;
}
export function clientsFor(dep, key) {
  const chain = defineChain({ id: dep.chainId, name: "anvil", nativeCurrency: { name: "BNB", symbol: "BNB", decimals: 18 }, rpcUrls: { default: { http: [dep.rpc] } } });
  const pub = createPublicClient({ chain, transport: http(dep.rpc) }); const account = privateKeyToAccount(key); const wallet = createWalletClient({ chain, transport: http(dep.rpc), account });
  const c = (address, abi) => getContract({ address, abi, client: { public: pub, wallet } }); const a = dep.addresses;
  return { pub, wallet, account, meps: c(a.meps, MEPRegistryAbi), instances: c(a.instances, InstanceRegistryAbi), claims: c(a.claims, ClaimManagerAbi), market: c(a.market, TaskMarketAbi) };
}
/** a synthetic brain and the profile it registers as: { mep, fields (the registry's MEP struct), payload, st } -- nothing is sent */
export async function syntheticMep({ name = "flywire-female", neurons = 4000, synapses = 40000, steps = 2 } = {}) {
  const { synthesizePayload } = await porw("synth.js"); const { PorwNode } = await porw("node.js"); const { loadKernelFromBytes } = await porw("porw.js");
  const payload = synthesizePayload(name, neurons, synapses); const wasm = fs.readFileSync(path.join(porwDir, "sketch.wasm"));
  const nd = new PorwNode(await loadKernelFromBytes(wasm), { privHex: KEYS[4] }); const st = await nd.loadModel(name, payload, { maxSteps: steps }); const mep = st.mep;
  const fields = { modelId: hex(mep.modelId), schemeDigest: hex(mep.schemeDigest), execKind: hex(mep.execKind), neurons: st.hdr.neurons, synapses: st.hdr.synapses, synapseRoot: hex(st.csr.synapseRoot), weightsDA: "0x" + Buffer.from(`gnfd://aigg-brains/${name}.bin`).toString("hex") };
  return { mep, mepId: hex(mep.mepId), fields, payload, st, steps };
}
/** register a MEP for a synthetic v1 brain: returns { mep, mepId, payload, st } (st from a throwaway node: synapseRoot) */
export async function registerSyntheticMep(dep, key, opts = {}) {
  const S = await syntheticMep(opts); const c = clientsFor(dep, key);
  await c.pub.waitForTransactionReceipt({ hash: await c.meps.write.registerMEP([S.fields]) });
  return S;
}
export async function startRelayer(dep, key, mepIds, { relayPort = 0, apiPort = 0, env: extra = {} } = {}) {
  // the production path: everything from PORW_* environment variables (what deploy.sh's .env.<network> provides)
  const a = dep.addresses; const env = { ...process.env, PORW_NETWORK: "anvil", PORW_CHAIN_ID: String(dep.chainId), PORW_RPC: dep.rpc, PORW_EPOCH_BLOCKS: String(dep.epochBlocks), PORW_VERIFIER: a.verifier, PORW_MEP_REGISTRY: a.meps, PORW_INSTANCES: a.instances, PORW_BEACON: a.beacon, PORW_CLAIMS: a.claims, PORW_MARKET: a.market, PORW_DISPUTES: a.disputes, PORW_RELAYS: a.relays,
    PORW_RELAYER_KEY: key, PORW_MEP_IDS: mepIds.join(","), PORW_RELAY_PORT: String(relayPort), PORW_API_PORT: String(apiPort), PORW_POLL_MS: "500", PORW_RELAYER_NAME: "test-relayer", ...extra };
  const child = fork(path.join(root, "relayer/relayer.mjs"), [], { env, stdio: ["ignore", "pipe", "pipe", "ipc"] }); let log = ""; child.stdout.on("data", (d) => (log += d)); child.stderr.on("data", (d) => (log += d));
  const info = await new Promise((res, rej) => { child.on("message", res); child.on("exit", (c) => rej(new Error("relayer exited " + c + "\n" + log))); setTimeout(() => rej(new Error("relayer start timeout\n" + log)), 60000); });
  const api = async (p, body) => (await fetch(info.api + p, body ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {})).json();
  return { ...info, apiBase: info.api, child, api, log: () => log, stop: () => child.kill() };
}
/** the gateway (gateway/gateway.mjs) as a child process, configured the way production is: from the environment. `env` wins. */
export async function startGateway(R, key, env = {}) {
  const child = fork(path.join(root, "gateway/gateway.mjs"), [], { env: { ...process.env, GATEWAY_KEY: key, GATEWAY_RELAYER: R.apiBase, GATEWAY_PORT: "0", ...env }, stdio: ["ignore", "pipe", "pipe", "ipc"] });
  let log = ""; child.stdout.on("data", (d) => (log += d)); child.stderr.on("data", (d) => (log += d));
  const info = await new Promise((res, rej) => { child.on("message", res); child.on("exit", (c) => rej(new Error("gateway exited " + c + "\n" + log))); setTimeout(() => rej(new Error("gateway start timeout\n" + log)), 60000); });
  return { ...info, child, log: () => log, stop: () => new Promise((res) => { child.once("exit", res); child.kill("SIGKILL"); }) };
}
// ---- a mesh deployed from the build artifacts, and a two-fly collection ----
// DeployBNB deploys everything, ExecutionDisputes included. The collection tests need only what the relayer reads
// at startup, and should not wait on a contract they never touch -- so this deploys that part, from contracts/out.
const ZERO_ADDR = "0x" + "0".repeat(40), ZERO_WORD = "0x" + "0".repeat(64);
export function forgeBuild() { const r = spawnSync(path.join(FOUNDRY, "forge"), ["build"], { cwd: path.join(root, "contracts"), env: { ...process.env, PATH: `${FOUNDRY}:${process.env.PATH}` }, encoding: "utf8" }); if (r.status !== 0) throw new Error("forge build failed: " + (r.stderr || r.stdout).slice(-600)); }
export const artifact = (name) => JSON.parse(fs.readFileSync(path.join(root, `contracts/out/${name}.sol/${name}.json`), "utf8"));
export async function create(c, name, args = []) { const a = artifact(name); const hash = await c.wallet.deployContract({ abi: a.abi, bytecode: a.bytecode.object, args }); return (await c.pub.waitForTransactionReceipt({ hash })).contractAddress; }
export async function sendTo(c, address, name, functionName, args = [], value = 0n) { const hash = await c.wallet.writeContract({ address, abi: artifact(name).abi, functionName, args, value }); return c.pub.waitForTransactionReceipt({ hash }); }
export const readFrom = (c, address, name, functionName, args = []) => c.pub.readContract({ address, abi: artifact(name).abi, functionName, args });
export async function deployMesh(rpc, key = KEYS[0], marketContract = "TaskMarket") {
  const c = clientsFor({ chainId: 31337, rpc, addresses: {} }, key); const a = { disputes: ZERO_ADDR, relays: ZERO_ADDR };
  a.verifier = await create(c, "PorwVerifierKeccak"); a.meps = await create(c, "MEPRegistry"); a.instances = await create(c, "InstanceRegistry", [parseEther("0.05"), 5n]);
  a.beacon = await create(c, "CommitRevealBeacon", [40n, 10n, 10n, parseEther("0.1")]);
  a.claims = await create(c, "PoRWClaimManager", [a.meps, a.instances, a.verifier, 40n, 10n, parseEther("0.01"), parseEther("0.5"), a.beacon]);
  a.market = await create(c, marketContract, [a.meps, a.instances, a.claims, 30n]);
  await sendTo(c, a.instances, "InstanceRegistry", "setClaimManager", [a.claims, 1n]); // claim validity: DeployBNB's default of one epoch
  return { chainId: 31337, rpc, epochBlocks: 40, addresses: a };
}
/** a genesis set of two: index 0 female, index 1 male (ids 1 and 2 once adopted, in that order) */
export const GENESIS = (() => { const DF = keccak256("0x01"), DM = keccak256("0x02"); const leaf = (i, sex, d) => keccak256(encodeAbiParameters([{ type: "uint32" }, { type: "uint8" }, { type: "bytes32" }], [i, sex, d]));
  const L0 = leaf(0, 0, DF), L1 = leaf(1, 1, DM); return { DF, DM, L0, L1, root: keccak256(encodePacked(["bytes32", "bytes32"], BigInt(L0) < BigInt(L1) ? [L0, L1] : [L1, L0])) }; })();
export const FLY_PRICE = parseEther("0.06"), FLY_BREED_FEE = parseEther("0.01"), FLY_TREASURY = "0x0000000000000000000000000000000000007ea5";
/** `baseMepFemale`: the base brain the collection answers for (and bonds adopters for, when `mintBond` > 0); `royaltyBps` > 0 registers
 *  its flies under terms and needs the market; `genesis` { root, size, baseModelId }: a real genesis set instead of the two-fly one */
export const deployCollection = (dep, bounty, key = KEYS[0], { baseMepFemale = ZERO_WORD, royaltyBps = 0, genesis = null, mintPrice = FLY_PRICE, mintBond = 0n, baseVendor = ZERO_ADDR, baseShareBps = 0, saleRoyaltyBps = 0, owner = ZERO_ADDR } = {}) => create(clientsFor(dep, key), "FlyCollection",
  [genesis ? genesis.baseModelId : keccak256("0x0f"), keccak256("0x0e"), genesis ? genesis.root : GENESIS.root, genesis ? genesis.size : 2, mintPrice, mintBond, FLY_BREED_FEE, bounty, FLY_TREASURY, dep.addresses.meps,
   mintBond ? dep.addresses.instances : ZERO_ADDR, ZERO_ADDR, baseMepFemale, ZERO_WORD, royaltyBps ? dep.addresses.market : ZERO_ADDR, royaltyBps, { baseVendor, baseShareBps, saleRoyaltyBps, owner }]);
export async function adoptBoth(c, collection) { await sendTo(c, collection, "FlyCollection", "mint", [0, 0, GENESIS.DF, [GENESIS.L1]], FLY_PRICE); await sendTo(c, collection, "FlyCollection", "mint", [1, 1, GENESIS.DM, [GENESIS.L0]], FLY_PRICE); }
/** the seed FlyCollection.hatch computes for child `id` of 1 x 2, given the hash of its seed block */
export const flySeed = (id, blockHash) => keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "bytes32" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }, { type: "bytes32" }], [GENESIS.DF, GENESIS.DM, 1n, 2n, BigInt(id), blockHash]));
export const domainsOf = eip712Domains;
export { sleep };
