// The hatch keeper. FlyCollection.breed fixes nothing but the recipe and a seed block -- the block after the one
// it lands in -- and pays HATCH_BOUNTY to whoever calls hatch(id) once that block's hash exists. The EVM forgets a
// hash after 256 blocks, and an egg nobody hatched in time costs its owner a whole BREED_FEE to re-arm, so "in
// seconds" is only true if somebody is standing there. With PORW_COLLECTION set the relayer is: it watches Bred
// and Rearmed, hatches from the first block it is possible, and only when the bounty pays for the gas.
//
// The mesh here is deployed from the build artifacts rather than by DeployBNB, and without ExecutionDisputes:
// the relayer never talks to it, and the keeper should not wait on a contract it has nothing to do with.
import fs from "node:fs"; import path from "node:path"; import { spawnSync } from "node:child_process";
import { parseEther, keccak256, encodeAbiParameters, encodePacked } from "viem";
import * as H from "./harness.mjs";
let fails = 0; const check = (n, ok) => { console.log((ok ? "  ok   " : "  FAIL ") + n); if (!ok) fails++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (p, ms = 15000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await p()) return true; await sleep(100); } return false; };
const ZERO = "0x" + "0".repeat(40), ZERO32 = "0x" + "0".repeat(64), TREASURY = "0x0000000000000000000000000000000000007ea5";

{ const r = spawnSync(path.join(H.FOUNDRY, "forge"), ["build"], { cwd: path.join(H.root, "contracts"), env: { ...process.env, PATH: `${H.FOUNDRY}:${process.env.PATH}` }, encoding: "utf8" }); if (r.status !== 0) throw new Error("forge build failed: " + (r.stderr || r.stdout).slice(-600)); }
const artifact = (name, file = name) => JSON.parse(fs.readFileSync(path.join(H.root, `contracts/out/${file}.sol/${name}.json`), "utf8"));

const anvil = await H.startAnvil(8561);
const relayers = [];
try {
  const D = H.clientsFor({ chainId: 31337, rpc: anvil.rpc, addresses: {} }, H.KEYS[0]);
  const create = async (name, args = []) => { const a = artifact(name); const hash = await D.wallet.deployContract({ abi: a.abi, bytecode: a.bytecode.object, args }); return (await D.pub.waitForTransactionReceipt({ hash })).contractAddress; };
  const send = async (c, address, name, functionName, args = [], value = 0n) => { const hash = await c.wallet.writeContract({ address, abi: artifact(name).abi, functionName, args, value }); return c.pub.waitForTransactionReceipt({ hash }); };
  const read = (address, name, functionName, args = []) => D.pub.readContract({ address, abi: artifact(name).abi, functionName, args });

  // the part of the mesh the relayer reads at startup, with the harness's small epochs
  const a = { disputes: ZERO, relays: ZERO };
  a.verifier = await create("PorwVerifierKeccak"); a.meps = await create("MEPRegistry"); a.instances = await create("InstanceRegistry", [parseEther("0.05"), 5n]);
  a.beacon = await create("CommitRevealBeacon", [40n, 10n, 10n, parseEther("0.1")]);
  a.claims = await create("PoRWClaimManager", [a.meps, a.instances, a.verifier, 40n, 10n, parseEther("0.01"), parseEther("0.5"), a.beacon]);
  a.market = await create("TaskMarket", [a.meps, a.instances, a.claims, 30n]);
  await send(D, a.instances, "InstanceRegistry", "setClaimManager", [a.claims]);
  const dep = { chainId: 31337, rpc: anvil.rpc, epochBlocks: 40, addresses: a };
  const { mepId } = await H.registerSyntheticMep(dep, H.KEYS[0]);

  // a two-individual genesis set: index 0 female, index 1 male
  const DF = keccak256("0x01"), DM = keccak256("0x02");
  const leaf = (i, sex, d) => keccak256(encodeAbiParameters([{ type: "uint32" }, { type: "uint8" }, { type: "bytes32" }], [i, sex, d]));
  const L0 = leaf(0, 0, DF), L1 = leaf(1, 1, DM); const root = keccak256(encodePacked(["bytes32", "bytes32"], BigInt(L0) < BigInt(L1) ? [L0, L1] : [L1, L0]));
  const PRICE = parseEther("0.06"), FEE = parseEther("0.01");
  const collection = (bounty) => create("FlyCollection", [keccak256("0x0f"), keccak256("0x0e"), ZERO32, ZERO32, root, 2, PRICE, 0n, FEE, bounty, TREASURY, a.meps, ZERO]);
  const B = H.clientsFor(dep, H.KEYS[1]); // the breeder
  const adoptBoth = async (c) => { await send(B, c, "FlyCollection", "mint", [0, 0, DF, [L1]], PRICE); await send(B, c, "FlyCollection", "mint", [1, 1, DM, [L0]], PRICE); };
  const breed = async (c) => { const r = await send(B, c, "FlyCollection", "breed", [1n, 2n], FEE); return { id: BigInt(await read(c, "FlyCollection", "totalSupply")), block: r.blockNumber }; };
  const seedOf = async (c, id) => (await read(c, "FlyCollection", "individuals", [id]))[8];
  const keeperOf = async (R) => (await R.api("/status")).keeper;

  // ---- a bounty that pays for the gas ----
  const BOUNTY = parseEther("0.002"); const C = await collection(BOUNTY); await adoptBoth(C);
  const early = await breed(C); await anvil.mine(3); // bred BEFORE the relayer exists: it has to find this egg on startup
  const R = await H.startRelayer(dep, H.KEYS[3], [mepId], { env: { PORW_BEACON_LAZY: "1", PORW_COLLECTION: C } }); relayers.push(R);
  const relayer = H.clientsFor(dep, H.KEYS[3]).account.address;
  check("/deployment names the collection", ((await R.api("/deployment")).addresses.collection || "").toLowerCase() === C.toLowerCase());
  check("an egg laid before the relayer started is found and hatched", await waitFor(async () => (await seedOf(C, early.id)) !== ZERO32));

  const late = await breed(C); await anvil.mine(2);
  check("an egg laid while it runs is hatched", await waitFor(async () => (await seedOf(C, late.id)) !== ZERO32));
  const seedBlock = late.block + 1n; const h = (await D.pub.getBlock({ blockNumber: seedBlock })).hash;
  const expected = keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "bytes32" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }, { type: "bytes32" }], [DF, DM, 1n, 2n, late.id, h]));
  check("the seed is the recipe and the hash of the block after the breed", (await seedOf(C, late.id)) === expected);
  const hatched = await D.pub.getContractEvents({ address: C, abi: artifact("FlyCollection").abi, eventName: "Hatched", fromBlock: 0n });
  const senders = await Promise.all(hatched.map(async (l) => (await D.pub.getTransaction({ hash: l.transactionHash })).from.toLowerCase()));
  check(`both were hatched by the relayer (${hatched.length} Hatched)`, hatched.length === 2 && senders.every((s) => s === relayer.toLowerCase()));
  check("and both bounties left the collection", (await D.pub.getBalance({ address: C })) === 0n);
  const k = await keeperOf(R);
  check(`/status.keeper reports them (${JSON.stringify(k.hatched.map((x) => x.id))})`, k.hatched.length === 2 && k.eggs.length === 0);

  // ---- a bounty that does not: the keeper is not a subsidy ----
  const P = await collection(1n); await adoptBoth(P);
  const R2 = await H.startRelayer(dep, H.KEYS[2], [mepId], { env: { PORW_BEACON_LAZY: "1", PORW_COLLECTION: P } }); relayers.push(R2);
  const poor = await breed(P); await anvil.mine(3);
  check("the keeper sees the egg and says why it will not hatch it", await waitFor(async () => { const s = await keeperOf(R2); return s.skipped.some((x) => x.id === String(poor.id) && /bounty/.test(x.why)); }));
  const s2 = await R2.api("/status");
  check("nothing was sent for it, and the egg is still an egg", !s2.txs.some((t) => /hatch/.test(t.label)) && (await seedOf(P, poor.id)) === ZERO32);
  check("it stays on the list: the gas price may yet fall inside the window", s2.keeper.eggs.some((x) => x.id === String(poor.id)));
} catch (e) { console.error(e); fails++; }
finally { for (const R of relayers) R.stop(); anvil.stop(); }
console.log(fails ? `${fails} FAILURES` : "keeper: all checks passed"); process.exit(fails ? 1 : 0);
