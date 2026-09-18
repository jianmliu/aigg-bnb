// The hatch keeper. FlyCollection.breed fixes nothing but the recipe and a seed block -- the block after the one
// it lands in -- and pays HATCH_BOUNTY to whoever calls hatch(id) once that block's hash exists. The EVM forgets a
// hash after 256 blocks, and an egg nobody hatched in time costs its owner a whole BREED_FEE to re-arm, so "in
// seconds" is only true if somebody is standing there. With PORW_COLLECTION set the relayer is: it watches Bred
// and Rearmed, hatches from the first block it is possible, and only when the bounty pays for the gas.
//
// The mesh here is deployed from the build artifacts rather than by DeployBNB, and without ExecutionDisputes:
// the relayer never talks to it, and the keeper should not wait on a contract it has nothing to do with.
import { parseEther } from "viem";
import * as H from "./harness.mjs";
let fails = 0; const check = (n, ok) => { console.log((ok ? "  ok   " : "  FAIL ") + n); if (!ok) fails++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (p, ms = 15000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await p()) return true; await sleep(100); } return false; };
const ZERO32 = "0x" + "0".repeat(64);

H.forgeBuild();
const anvil = await H.startAnvil(8561);
const relayers = [];
try {
  const dep = await H.deployMesh(anvil.rpc); const D = H.clientsFor(dep, H.KEYS[0]);
  const { mepId } = await H.registerSyntheticMep(dep, H.KEYS[0]);
  const B = H.clientsFor(dep, H.KEYS[1]); // the breeder
  const breed = async (c) => { const r = await H.sendTo(B, c, "FlyCollection", "breed", [1n, 2n], H.FLY_BREED_FEE); return { id: BigInt(await H.readFrom(D, c, "FlyCollection", "totalSupply")), block: r.blockNumber }; };
  const seedOf = async (c, id) => (await H.readFrom(D, c, "FlyCollection", "individuals", [id]))[8];
  const keeperOf = async (R) => (await R.api("/status")).keeper;

  // ---- a bounty that pays for the gas ----
  const C = await H.deployCollection(dep, parseEther("0.002")); await H.adoptBoth(B, C);
  const early = await breed(C); await anvil.mine(3); // bred BEFORE the relayer exists: it has to find this egg on startup
  const R = await H.startRelayer(dep, H.KEYS[3], [mepId], { env: { PORW_BEACON_LAZY: "1", PORW_COLLECTION: C } }); relayers.push(R);
  const relayer = H.clientsFor(dep, H.KEYS[3]).account.address;
  check("/deployment names the collection", ((await R.api("/deployment")).addresses.collection || "").toLowerCase() === C.toLowerCase());
  check("an egg laid before the relayer started is found and hatched", await waitFor(async () => (await seedOf(C, early.id)) !== ZERO32));

  const late = await breed(C); await anvil.mine(2);
  check("an egg laid while it runs is hatched", await waitFor(async () => (await seedOf(C, late.id)) !== ZERO32));
  const seedBlock = late.block + 1n; const h = (await D.pub.getBlock({ blockNumber: seedBlock })).hash;
  check("the seed is the recipe and the hash of the block after the breed", (await seedOf(C, late.id)) === H.flySeed(late.id, h));
  const hatched = await D.pub.getContractEvents({ address: C, abi: H.artifact("FlyCollection").abi, eventName: "Hatched", fromBlock: 0n });
  const senders = await Promise.all(hatched.map(async (l) => (await D.pub.getTransaction({ hash: l.transactionHash })).from.toLowerCase()));
  check(`both were hatched by the relayer (${hatched.length} Hatched)`, hatched.length === 2 && senders.every((s) => s === relayer.toLowerCase()));
  check("and both bounties left the collection", (await D.pub.getBalance({ address: C })) === 0n);
  const k = await keeperOf(R);
  check(`/status.keeper reports them (${JSON.stringify(k.hatched.map((x) => x.id))})`, k.hatched.length === 2 && k.eggs.length === 0);

  // ---- a bounty that does not: the keeper is not a subsidy ----
  const P = await H.deployCollection(dep, 1n); await H.adoptBoth(B, P);
  const R2 = await H.startRelayer(dep, H.KEYS[2], [mepId], { env: { PORW_BEACON_LAZY: "1", PORW_COLLECTION: P } }); relayers.push(R2);
  const poor = await breed(P); await anvil.mine(3);
  check("the keeper sees the egg and says why it will not hatch it", await waitFor(async () => { const s = await keeperOf(R2); return s.skipped.some((x) => x.id === String(poor.id) && /bounty/.test(x.why)); }));
  const s2 = await R2.api("/status");
  check("nothing was sent for it, and the egg is still an egg", !s2.txs.some((t) => /hatch/.test(t.label)) && (await seedOf(P, poor.id)) === ZERO32);
  check("it stays on the list: the gas price may yet fall inside the window", s2.keeper.eggs.some((x) => x.id === String(poor.id)));
} catch (e) { console.error(e); fails++; }
finally { for (const R of relayers) R.stop(); anvil.stop(); }
console.log(fails ? `${fails} FAILURES` : "keeper: all checks passed"); process.exit(fails ? 1 : 0);
