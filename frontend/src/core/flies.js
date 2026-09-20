// The collection, as the page sees it: the flies this wallet owns, the pairing, and the eggs.
//
// Same rule as controller.js and for the same reason -- no React here, the state lives in `state.flies` and the UI
// only renders it. What is particular to this file is the egg. `FlyCollection.breed` fixes the recipe and a SEED
// BLOCK (the block after the one it lands in) and nothing else; the child's seed, and with it its sex, is
// keccak(recipe, blockhash(seedBlock)), written on-chain by whoever calls `hatch` first. So there are two moments,
// and the page shows both: one block after breeding it can already compute what the child will be (`preview`),
// and some seconds later the chain agrees (`seed`). In between, the hash is only good for 256 blocks: an egg
// nobody hatches in that window needs `rearm`, which costs a whole BREED_FEE. A relayer running the hatch keeper
// makes that window irrelevant; the Hatch button is for when nobody is.
import { keccakWords, decodeUint, decodeAddress } from "./abi.js";
import { state, call, send, read, log, notify } from "./controller.js";
import { loadPhenotypes } from "./phenotypes.js";

export const FEMALE = 0, MALE = 1, UNHATCHED = 2;
export const WINDOW = 256; // block hashes the EVM keeps
const ZERO32 = "0x" + "0".repeat(64);
const MAX_LISTED = 500; // the page walks ids 1..totalSupply (the contract has no owner index); past this it needs an indexer

const words = (data) => { const h = data.slice(2); const out = []; for (let i = 0; i + 64 <= h.length; i += 64) out.push("0x" + h.slice(i, i + 64)); return out; };
const blockNumber = async () => Number(await read("eth_blockNumber"));

/** Individual, in the order the contract's getter returns it */
function decodeIndividual(id, data) {
  const w = words(data);
  return { id, baseModelId: w[0], deltaHash: w[1], modelId: w[2], mepId: w[3], sex: Number(BigInt(w[4])), generation: Number(BigInt(w[5])),
    parentA: Number(BigInt(w[6])), parentB: Number(BigInt(w[7])), seed: w[8], seedBlock: Number(BigInt(w[9])) };
}

/** where an individual is in its life: an egg has no seed, an unborn has a seed and no brain, the rest have a delta */
export function stageOf(f) {
  if (f.seedBlock !== 0 && f.seed === ZERO32) return "egg";
  if (f.deltaHash === ZERO32) return "unborn";
  return f.mepId === ZERO32 ? "unregistered" : "registered";
}
export const canBreed = (f) => f.mine && f.deltaHash !== ZERO32 && (f.sex === FEMALE || f.sex === MALE);
export const sexMark = (sex) => (sex === FEMALE ? "♀" : sex === MALE ? "♂" : "?");
/** `#41 ♀ · gen 3 · ♀12 × ♂27`: what the animal is, from the record alone */
export function lineage(f, byId) {
  const p = (id) => { const x = byId.get(id); return x ? sexMark(x.sex) + id : "#" + id; };
  return `#${f.id} ${sexMark(f.sex)} · gen ${f.generation}${f.parentA ? ` · ${p(f.parentA)} × ${p(f.parentB)}` : " · genesis"}`;
}

/** read the whole collection: the fees, and every individual with whether this wallet holds it */
export async function loadFlies() {
  await loadPhenotypes(); // what the published runs measured about these individuals; absent, the page says so per fly
  const address = state.deployment?.addresses?.collection;
  if (!address) { state.flies = { missing: true, all: [] }; notify(); return; }
  const n = Number(decodeUint(await call(address, "totalSupply()")));
  const flies = { address, missing: false, truncated: n > MAX_LISTED, block: await blockNumber(),
    breedFee: decodeUint(await call(address, "BREED_FEE()")), bounty: decodeUint(await call(address, "HATCH_BOUNTY()")),
    mintPrice: decodeUint(await call(address, "MINT_PRICE()")), mintBond: decodeUint(await call(address, "MINT_BOND()")),
    royaltyBps: Number(decodeUint(await call(address, "ROYALTY_BPS()"))),
    // the base's part OF THE ROYALTY (a collection from before the mainnet revision has no such getter: nothing comes off)
    baseShareBps: await call(address, "BASE_SHARE_BPS()").then((r) => Number(decodeUint(r)), () => 0), market: decodeAddress(await call(address, "MARKET()")),
    genesisRoot: await call(address, "GENESIS_ROOT()"), owed: state.wallet ? decodeUint(await call(address, "owed(address)", [state.wallet])) : 0n,
    genesis: state.flies?.genesis || null,
    baseFemale: await call(address, "BASE_FEMALE()"), baseMale: await call(address, "BASE_MALE()"), all: [] };
  for (let id = 1; id <= Math.min(n, MAX_LISTED); id++) {
    const f = decodeIndividual(id, await call(address, "individuals(uint256)", [id]));
    f.owner = decodeAddress(await call(address, "ownerOf(uint256)", [id])); f.mine = !!state.wallet && f.owner === state.wallet;
    f.preview = state.flies?.all.find((x) => x.id === id && x.seedBlock === f.seedBlock)?.preview || null; // keep what we already worked out
    // what its experiments have set aside and nobody has moved to its owner yet (the market holds it until `settle`)
    f.pending = flies.royaltyBps > 0 && f.mepId !== ZERO32 ? decodeUint(await call(flies.market, "royalties(bytes32)", [f.mepId])) : 0n;
    flies.all.push(f);
  }
  state.flies = flies; notify(); await watchEggs();
}

/** what the child will be, from the seed block's hash -- the same arithmetic as FlyCollection.hatch */
async function previewOf(f, byId) {
  const b = await read("eth_getBlockByNumber", ["0x" + f.seedBlock.toString(16), false]);
  if (!b || !b.hash) return null;
  const seed = keccakWords([byId.get(f.parentA).deltaHash, byId.get(f.parentB).deltaHash, f.parentA, f.parentB, f.id, b.hash]);
  return { seed, sex: Number(BigInt(seed) & 1n) };
}

// One pass at a time, like the node loop and for the same reason: a pass awaits the wallet provider.
let pass = null, timer = null;
export function watchEggs() { return pass ||= runPass().finally(() => { pass = null; }); }
async function runPass() {
  const F = state.flies; if (!F || F.missing) return;
  const eggs = F.all.filter((f) => stageOf(f) === "egg");
  if (!eggs.length) { if (timer) { clearInterval(timer); timer = null; } return; }
  if (!timer) timer = setInterval(() => watchEggs().catch(() => {}), 1500); // only while there is an egg to watch
  F.block = await blockNumber(); const byId = new Map(F.all.map((f) => [f.id, f]));
  for (const f of eggs) {
    const fresh = decodeIndividual(f.id, await call(F.address, "individuals(uint256)", [f.id]));
    if (fresh.seedBlock !== f.seedBlock) f.preview = null; // re-armed: a new block is a new draw
    Object.assign(f, fresh);
    if (f.seed !== ZERO32) { log(`fly #${f.id} hatched on-chain: ${sexMark(f.sex)}, seed ${f.seed.slice(0, 12)}…`); continue; }
    if (!f.preview && F.block > f.seedBlock && F.block <= f.seedBlock + WINDOW) {
      f.preview = await previewOf(f, byId);
      if (f.preview) log(`fly #${f.id}: block ${f.seedBlock} is in — it will be ${sexMark(f.preview.sex)} (seed ${f.preview.seed.slice(0, 12)}…), waiting for hatch`);
    }
  }
  notify();
}
/** blocks left before the seed block's hash is gone; <= 0 means it needs rearm */
export const blocksLeft = (f) => (state.flies ? f.seedBlock + WINDOW - state.flies.block : 0);

/** what the pairing panel says before anyone spends anything; null when the pair is fine */
export function checkPair(dam, sire) {
  if (!dam || !sire) return "choose one female and one male";
  if (!canBreed(dam) || !canBreed(sire)) return "both parents must be yours and born (an egg or an unborn child cannot breed)";
  if (dam.sex !== FEMALE || sire.sex !== MALE) return "breeding needs one of each sex";
  return null;
}
export async function breed(damId, sireId) {
  const F = state.flies; const byId = new Map(F.all.map((f) => [f.id, f]));
  const problem = checkPair(byId.get(damId), byId.get(sireId)); if (problem) throw new Error(problem);
  log(`breeding #${damId} ♀ × #${sireId} ♂ — this records the child's lineage; its seed is the hash of the next block`);
  const r = await send(F.address, "breed(uint256,uint256)", [damId, sireId], F.breedFee);
  if (r.status !== "0x1") throw new Error("breed reverted");
  await loadFlies();
  return state.flies.all.length; // ids are sequential: the newborn is the last one
}
// ---- adoption ----
// The genesis set ships with the page (/genesis/genesis-v1.json: index, sex, deltaHash, recipe, proof). It is only
// offered if its root IS the collection's GENESIS_ROOT -- a page pointed at another collection must not sell this
// one's founders -- and an individual only while `genesisMinted(index)` is false.
const GENESIS_URL = "/genesis/genesis-v1.json";
export async function loadGenesis() {
  const F = state.flies; if (!F || F.missing) return;
  let file = null; try { file = await (await fetch(GENESIS_URL)).json(); } catch {}
  if (!file || String(file.root).toLowerCase() !== String(F.genesisRoot).toLowerCase()) { F.genesis = { matches: false, open: [] }; notify(); return; }
  const open = []; const chunk = 10;
  for (let i = 0; i < file.individuals.length; i += chunk) {
    const part = file.individuals.slice(i, i + chunk);
    const taken = await Promise.all(part.map((x) => call(F.address, "genesisMinted(uint256)", [x.index])));
    part.forEach((x, k) => { if (decodeUint(taken[k]) === 0n) open.push(x); });
  }
  F.genesis = { matches: true, size: file.size, open }; notify();
}
export async function adopt(index) {
  const F = state.flies; const x = F.genesis?.open.find((g) => g.index === index); if (!x) throw new Error("that individual is not open for adoption");
  log(`adopting founder #${index} — ${Number(F.mintPrice) / 1e18} BNB${F.mintBond ? `, of which ${Number(F.mintBond) / 1e18} becomes your own bond` : ""}`);
  const r = await send(F.address, "mint(uint32,uint8,bytes32,bytes32[])", [x.index, x.sex, x.deltaHash, x.proof], F.mintPrice);
  if (r.status !== "0x1") throw new Error("adoption reverted");
  await loadFlies(); await loadGenesis();
}
// ---- the royalty: set aside by the market per brain, moved to the fly's owner by `settle`, collected by `withdraw` ----
export async function settle(id) { await send(state.flies.address, "settle(uint256)", [id]); await loadFlies(); }
export async function withdraw() { await send(state.flies.address, "withdraw()"); await loadFlies(); }

export async function hatch(id) { await send(state.flies.address, "hatch(uint256)", [id]); await loadFlies(); }
export async function rearm(id) { await send(state.flies.address, "rearm(uint256)", [id], state.flies.breedFee); await loadFlies(); }
