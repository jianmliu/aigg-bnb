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
import { state, call, send, read, log, notify, eth, api } from "./controller.js";
import { loadPhenotypes } from "./phenotypes.js";

export const FEMALE = 0, MALE = 1, UNHATCHED = 2;
export const WINDOW = 256; // block hashes the EVM keeps
const ZERO32 = "0x" + "0".repeat(64);
let pageRequest = 0, pageDeployment;
let pageQuery = { view: "adopt", sex: "all", page: 1 };

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

/** The collection's TERMS alone: what it costs, and how a fee is divided. Reading every individual to answer that
 *  would be a hundred calls for five numbers, which is what the docs page would otherwise have to do -- and a second
 *  copy of these reads is how a documentation page starts quietly disagreeing with the thing it documents. So both
 *  pages come through here: `loadFlies` calls it and takes the numbers from it. */
export async function loadTerms() {
  const address = state.deployment?.addresses?.collection;
  if (!address) { state.flyTerms = { missing: true }; notify(); return state.flyTerms; }
  // a collection from before the mainnet revision has no BASE_SHARE_BPS or SALE_ROYALTY_BPS getter: nothing comes off
  const num = (sig, dflt = 0n) => call(address, sig).then((r) => decodeUint(r), () => dflt);
  state.flyTerms = { address, missing: false,
    mintPrice: await num("MINT_PRICE()"), mintBond: await num("MINT_BOND()"), breedFee: await num("BREED_FEE()"), bounty: await num("HATCH_BOUNTY()"),
    royaltyBps: Number(await num("ROYALTY_BPS()")), baseShareBps: Number(await num("BASE_SHARE_BPS()")), saleRoyaltyBps: Number(await num("SALE_ROYALTY_BPS()")) };
  notify(); return state.flyTerms;
}

/** Discover one indexed page, then verify its individuals and sale quotes on-chain. */
export async function loadFlies(options = {}) {
  const request = ++pageRequest, deployment = state.deployment, wallet = state.wallet, previous = state.flies;
  if (pageDeployment !== deployment) { delete pageQuery.minBlock; pageDeployment = deployment; }
  pageQuery = { ...pageQuery, ...options };
  const query = { ...pageQuery };
  const current = () => request === pageRequest && state.deployment === deployment && state.wallet === wallet;
  state.flies = null; notify();
  if (query.view === "mine" && !wallet) return;
  try {
    await loadPhenotypes(); // what the published runs measured about these individuals; absent, the page says so per fly
    if (!current()) return;
    const address = deployment?.addresses?.collection;
    if (!address) { state.flies = { missing: true, all: [] }; notify(); return; }
    const T = await loadTerms();
    const page = await api("/flies/page?" + new URLSearchParams({ ...query, ...(wallet ? {owner:wallet} : {}) }));
    if (page.error) throw new Error(page.error);
    if (page.collection?.toLowerCase() !== address.toLowerCase() || !Array.isArray(page.ids) || page.ids.length > 12) throw new Error("Invalid collection page response.");
    const flies = { address, missing: false, loading: true, page, block: await blockNumber(),
      breedFee: T.breedFee, bounty: T.bounty, mintPrice: T.mintPrice, mintBond: T.mintBond,
      royaltyBps: T.royaltyBps, baseShareBps: T.baseShareBps, market: decodeAddress(await call(address, "MARKET()")),
      genesisRoot: await call(address, "GENESIS_ROOT()"), owed: state.wallet ? decodeUint(await call(address, "owed(address)", [state.wallet])) : 0n,
      genesis: null, sale: null,
      baseFemale: await call(address, "BASE_FEMALE()"), baseMale: await call(address, "BASE_MALE()"), all: [] };
    for (const id of page.ids) {
      const f = decodeIndividual(id, await call(address, "individuals(uint256)", [id]));
      f.owner = decodeAddress(await call(address, "ownerOf(uint256)", [id])); f.mine = !!state.wallet && f.owner.toLowerCase() === state.wallet.toLowerCase();
      f.preview = previous?.all.find((x) => x.id === id && x.seedBlock === f.seedBlock)?.preview || null; // keep what we already worked out
      // what its experiments have set aside and nobody has moved to its owner yet (the market holds it until `settle`)
      f.pending = flies.royaltyBps > 0 && f.mepId !== ZERO32 ? decodeUint(await call(flies.market, "royalties(bytes32)", [f.mepId])) : 0n;
      if (query.view !== "mine" || f.mine) flies.all.push(f);
    }
    if (!current()) return;
    state.flies = flies;
    if (query.view === "adopt") await loadGenesis();
    else { await loadBattery(); await watchEggs(); }
    if (current()) { delete pageQuery.minBlock; flies.loading = false; notify(); }
  } catch (error) {
    if (current()) { state.flies = { error: error.message || String(error), all: [] }; notify(); }
    throw error;
  }
}

/** what the child will be, from the seed block's hash -- the same arithmetic as FlyCollection.hatch */
async function previewOf(f, byId, address) {
  const b = await read("eth_getBlockByNumber", ["0x" + f.seedBlock.toString(16), false]);
  if (!b || !b.hash) return null;
  for (const id of [f.parentA, f.parentB]) if (!byId.has(id)) byId.set(id, decodeIndividual(id, await call(address, "individuals(uint256)", [id])));
  const seed = keccakWords([byId.get(f.parentA).deltaHash, byId.get(f.parentB).deltaHash, f.parentA, f.parentB, f.id, b.hash]);
  return { seed, sex: Number(BigInt(seed) & 1n) };
}

// One pass at a time, like the node loop and for the same reason: a pass awaits the wallet provider.
let pass = null, timer = null;
export function watchEggs() { return pass ||= runPass().finally(() => { pass = null; }); }
async function runPass() {
  const F = state.flies; if (!F || F.missing || F.error) return;
  const eggs = F.all.filter((f) => stageOf(f) === "egg");
  if (!eggs.length) { if (timer) { clearInterval(timer); timer = null; } return; }
  if (!timer) timer = setInterval(() => watchEggs().catch(() => {}), 1500); // only while there is an egg to watch
  F.block = await blockNumber(); const byId = new Map(F.all.map((f) => [f.id, f]));
  for (const f of eggs) {
    if (state.flies !== F) return;
    const fresh = decodeIndividual(f.id, await call(F.address, "individuals(uint256)", [f.id]));
    if (fresh.seedBlock !== f.seedBlock) f.preview = null; // re-armed: a new block is a new draw
    Object.assign(f, fresh);
    if (f.seed !== ZERO32) { log(`fly #${f.id} hatched on-chain: ${sexMark(f.sex)}, seed ${f.seed.slice(0, 12)}…`); continue; }
    if (!f.preview && F.block > f.seedBlock && F.block <= f.seedBlock + WINDOW) {
      f.preview = await previewOf(f, byId, F.address);
      if (f.preview) log(`fly #${f.id}: block ${f.seedBlock} is in — it will be ${sexMark(f.preview.sex)} (seed ${f.preview.seed.slice(0, 12)}…), waiting for hatch`);
    }
  }
  if (state.flies === F) notify();
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
  const F = state.flies;
  if (!F || F.loading || F.error) throw new Error("Wait for your flies to load.");
  const wallet = state.wallet, deployment = state.deployment;
  const byId = new Map();
  for (const id of [damId, sireId]) {
    const f = decodeIndividual(id, await call(F.address, "individuals(uint256)", [id]));
    f.mine = decodeAddress(await call(F.address, "ownerOf(uint256)", [id])).toLowerCase() === state.wallet?.toLowerCase();
    byId.set(id, f);
  }
  if (state.wallet !== wallet || state.deployment !== deployment || state.flies !== F) throw new Error("Wallet or page changed; review the pair again.");
  const problem = checkPair(byId.get(damId), byId.get(sireId)); if (problem) throw new Error(problem);
  if (!F.battery?.address || F.battery.error) throw new Error("Funded battery breeding is not configured.");
  if (!state.wallet || !state.chainOk) throw new Error("Connect on the deployment chain first.");
  const battery=F.battery;const factory=battery.address;
  if(battery.tokenMode&&!battery.quote)throw Error("Get a BNB quote first.");
  if(Number(await ethChainId())!==Number(state.deployment.chainId))throw Error("Wrong wallet chain.");
  for(const id of [damId,sireId]) {
    const approved=decodeAddress(await call(F.address,"getApproved(uint256)",[id]));
    const all=decodeUint(await call(F.address,"isApprovedForAll(address,address)",[state.wallet,factory]));
    if(approved.toLowerCase()!==factory.toLowerCase() && all===0n) {
      const r=await send(F.address,"approve(address,uint256)",[factory,id]);if(r.status!=="0x1")throw new Error("Parent approval reverted");
    }
  }
  const r=battery.tokenMode
    ? await send(factory,"breedWithBNB(uint256,uint256,uint256)",[damId,sireId,battery.quote.deadline],F.breedFee+battery.quote.maxInput)
    : await send(factory,"breed(uint256,uint256)",[damId,sireId],F.breedFee+battery.budget);
  if(r.status!=="0x1")throw new Error("Funded breed reverted");
  const newborn = Number(decodeUint(await call(F.address, "totalSupply()", [], r.blockNumber)));
  await loadFlies({ minBlock: Number(BigInt(r.blockNumber)) });
  return newborn;
}
// ---- treasury inventory adoption (existing NFTs, never mint) ----
export async function loadGenesis() {
  const F = state.flies; if (!F || F.missing || F.error) return;
  F.sale = null; notify();
  const address = state.deployment?.addresses?.inventorySale;
  if (!address) { F.sale = { unavailable: "Treasury adoption is not configured for this deployment.", open: [] }; notify(); return; }
  try {
    const collection = decodeAddress(await call(address, "collection()"));
    if (collection.toLowerCase() !== F.address.toLowerCase()) throw new Error("Sale contract does not match this collection.");
    const treasury = decodeAddress(await call(address, "treasury()"));
    const open = [];
    for (const f of F.all) {
      if (f.owner.toLowerCase() !== treasury.toLowerCase()) continue;
      const q = words(await call(address, "listings(uint256)", [f.id]));
      if (BigInt(q[0]) === 0n || decodeUint(await call(address, "available(uint256)", [f.id])) === 0n) continue;
      open.push({ ...f, price: BigInt(q[0]), expiresAt: BigInt(q[1]), revision: BigInt(q[2]) });
    }
    if (state.flies !== F) return;
    F.sale = { address, treasury, open }; notify();
  } catch (e) {
    if (state.flies === F) { F.sale = { unavailable: e.message || "Could not verify treasury inventory.", open: [] }; notify(); }
    throw e;
  }
}
const pendingAdoptions = new Set();
export async function adopt(id) {
  const F = state.flies, sale = F?.sale;
  const x = sale?.open.find((g) => g.id === id);
  if (!x || sale.unavailable) throw new Error("that individual is not open for adoption");
  if (!state.wallet || !state.chainOk || Number(await ethChainId()) !== Number(state.deployment.chainId)) throw new Error("Connect your wallet on the deployment chain first.");
  if (state.wallet.toLowerCase() === sale.treasury.toLowerCase()) throw new Error("Treasury cannot buy its own inventory.");
  const key = `${sale.address}:${id}`;
  if (pendingAdoptions.has(key)) throw new Error("Adoption is already pending.");
  pendingAdoptions.add(key); x.pending = true; notify();
  try {
    const block = await read("eth_getBlockByNumber", ["latest", false]);
    const deadline = BigInt(block.timestamp) + 600n;
    log(`adopting treasury fly #${id}: existing NFT, BNB proceeds to ${sale.treasury}`);
    const r = await send(sale.address, "buy(uint256,uint256,uint256,uint256)", [id, x.price, x.revision, deadline], x.price);
    if (r.status !== "0x1") throw new Error("Adoption reverted; refresh inventory before retrying.");
    await loadFlies({ minBlock: Number(BigInt(r.blockNumber)) });
  } finally { pendingAdoptions.delete(key); x.pending = false; notify(); }
}
const ethChainId = () => eth().request({ method: "eth_chainId" });
// ---- the royalty: set aside by the market per brain, moved to the fly's owner by `settle`, collected by `withdraw` ----
export async function settle(id) { await send(state.flies.address, "settle(uint256)", [id]); await loadFlies(); }
export async function withdraw() { await send(state.flies.address, "withdraw()"); await loadFlies(); }

export async function hatch(id) { await send(state.flies.address, "hatch(uint256)", [id]); await loadFlies(); }
export async function rearm(id) { await send(state.flies.address, "rearm(uint256)", [id], state.flies.breedFee); await loadFlies(); }

// The escrow is authoritative; the worker's status adds off-chain execution/publication progress.
export async function loadBattery(){
 const F=state.flies;if(!F||F.missing)return;const tokenMode=state.batteryRoute==='token';const address=state.deployment?.addresses?.[tokenMode?'tokenBatteryBudget':'batteryBudget'];
 // every other exit from this function notifies; this one returned without it, so "Refresh battery status" on a
 // deployment with no queue redrew nothing and looked like a dead button.
 if(!address){F.battery={error:"Battery budget is not configured; funded breeding is unavailable.",jobs:{}};notify();return;}
 try {
  if(decodeAddress(await call(address,"collection()")).toLowerCase()!==F.address.toLowerCase())throw Error("Battery collection mismatch");
  const budget=decodeUint(await call(address,"budget()"));const jobs={};
  const paymentToken=tokenMode?decodeAddress(await call(address,"paymentToken()")):null;
  const decimals=tokenMode?Number(decodeUint(await call(paymentToken,"decimals()"))):18;
  if(decimals>36)throw Error("Unsupported token decimals");
  if(tokenMode&&decodeAddress(await call(address,"market()")).toLowerCase()!==state.deployment.addresses.market.toLowerCase())throw Error("Battery market mismatch");
  for(const f of F.all){const job=decodeAddress(await call(address,"jobOf(uint256)",[f.id]));if(BigInt(job)===0n)continue;
   const taskId=await call(job,"taskId()"),artifactHash=await call(job,"artifactHash()");const closed=decodeUint(await call(job,"closed()"))!==0n;
   const expiresAt=decodeUint(await call(job,"expiresAt()"));const payer=decodeAddress(await call(job,"payer()"));
   let status=artifactHash!==ZERO32?"delivered":closed?"closed":taskId!==ZERO32?"task posted / verifying":f.mepId===ZERO32?"waiting for model registration":"funded / queued";
   let artifactUrl=null;const endpoint=tokenMode?state.deployment?.tokenBatteryApi:state.deployment?.batteryApi;
   if(endpoint){try {const response=await fetch(endpoint.replace(/\/$/,"")+"/"+job+".json",{signal:AbortSignal.timeout(3000)});if(response.ok){const r=await response.json();if(!closed)status=r.status;}if(artifactHash!==ZERO32)artifactUrl=endpoint.replace(/\/$/,"")+"/artifacts/"+job+".json";}catch{}}
   const balance=tokenMode?decodeUint(await call(paymentToken,"balanceOf(address)",[job])):BigInt(await read("eth_getBalance",[job,"latest"]));
   const block=await read("eth_getBlockByNumber",["latest",false]);
   jobs[f.id]={job,status,artifactHash,artifactUrl,payer,balance,refund:balance>0n&&(closed||BigInt(block.timestamp)>=expiresAt)&&decodeUint(await call(job,"settledFinal()"))!==0n};
  }
  if(state.flies!==F||(state.batteryRoute==='token')!==tokenMode)return;
  F.battery={address,budget,jobs,tokenMode,paymentToken,decimals,quote:null};
 }catch(e){F.battery={error:e.message,jobs:{}};}notify();
}
export async function selectBatteryRoute(mode){if(!['native','token'].includes(mode))throw Error('Invalid route');state.batteryRoute=mode;state.flies.battery={error:'Loading battery route…',loading:true,jobs:{}};notify();await loadBattery();}
export async function quoteBattery(){
 const b=state.flies?.battery;if(!b?.tokenMode||b.error)throw Error('Select the token route');
 const input=decodeUint(await call(b.address,'quoteNativeInput()'));if(input<=0n)throw Error('No liquidity quote');
 const block=await read('eth_getBlockByNumber',['latest',false]);
 if(state.flies?.battery!==b)throw Error('Route changed; get a new quote');
 b.quote={input,maxInput:(input*10100n+9999n)/10000n,deadline:BigInt(block.timestamp)+600n};notify();
}
export async function fundBattery(id){if(!state.wallet||!state.chainOk||Number(await ethChainId())!==Number(state.deployment.chainId))throw Error("Connect your wallet on the deployment chain first.");const F=state.flies;if(!F.battery?.address)throw Error("Battery not configured");if(F.battery.tokenMode)throw Error("Direct token funding is available through the treasury contract interface.");const r=await send(F.battery.address,"fund(uint256)",[id],F.battery.budget);if(r.status!=="0x1")throw Error("Funding reverted");await loadBattery();}
export async function refundBattery(id){if(!state.wallet||!state.chainOk||Number(await ethChainId())!==Number(state.deployment.chainId))throw Error("Connect your wallet on the deployment chain first.");const q=state.flies?.battery?.jobs[id];if(!q?.refund||q.payer.toLowerCase()!==state.wallet?.toLowerCase())throw Error("Refund unavailable");const r=await send(q.job,"refund()");if(r.status!=="0x1")throw Error("Refund reverted");await loadBattery();}
export { batteryQueue } from "./battery_queue.js";   // a pure decision, in its own file so node can test it
