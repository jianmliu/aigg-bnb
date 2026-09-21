// What a fly's OWNER does, from a terminal.
//
// Adopting, breeding, hatching and collecting royalties existed only in the page. That is fine for a person with a
// browser and wrong for everyone else: an owner automating their colony, an agent acting for one, a machine with no
// display. The alternative they were left with -- raw calldata against a contract nobody reviewed with them -- is
// worse than the gap.
//
//   node js/fly.mjs <command> [args] [--relayer <url> | --env <file>] [--broadcast]
//
//   terms                     what the collection charges and how a fee divides        (free)
//   list [address]            every individual, who holds it, and what it has earned   (free)
//   inventory                 what the treasury has open for adoption, with prices     (free)
//   adopt <id>                buy a founder from the treasury: an EXISTING NFT moves
//   breed <dam> <sire>        pair two of yours; the fee funds the child's battery
//   hatch <id>                turn an egg into an individual
//   rearm <id>                an egg whose seed block aged out; costs another BREED_FEE
//   settle <id>               move what a fly's experiments set aside to its owner
//   withdraw                  collect everything owed to you
//
// EVERY command that writes is a dry run. It prints the exact call, the exact value and who receives it, and sends
// nothing until `--broadcast` -- the rule js/launch_founder_inventory.mjs already sets for this repo, and the right
// one for a tool an agent may drive. The key is read from FLY_KEY (or PORW_DEPLOYER_KEY) and is never printed.
import fs from "node:fs";
import { createPublicClient, createWalletClient, http, parseAbi, formatEther, getAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const argv = process.argv.slice(2);
const flag = (name) => { const i = argv.indexOf(`--${name}`); return i < 0 ? null : argv[i + 1]; };
const has = (name) => argv.includes(`--${name}`);
const args = argv.filter((a, i) => !a.startsWith("--") && !(i > 0 && argv[i - 1].startsWith("--") && ["relayer", "env"].includes(argv[i - 1].slice(2))));
const [cmd, ...rest] = args;
const BROADCAST = has("broadcast");

const USAGE = `usage: node js/fly.mjs <command> [args] [--relayer <url> | --env <file>] [--broadcast]

  terms                     what the collection charges                      (free)
  list [address]            every individual, its holder and its earnings    (free)
  inventory                 what is open for adoption, with prices           (free)
  adopt <id>                buy a founder from the treasury inventory
  breed <dam> <sire>        pair two of yours; funds the child's battery
  hatch <id>                turn an egg into an individual
  rearm <id>                an egg whose seed block aged out (costs BREED_FEE)
  settle <id>               move a fly's set-aside royalties to its owner
  withdraw                  collect everything owed to you

Writing commands print what they would do and send nothing without --broadcast.
The key is read from FLY_KEY (or PORW_DEPLOYER_KEY); it is never printed.`;
if (!cmd || has("help")) { console.log(USAGE); process.exit(cmd ? 0 : 2); }

// ---- the ABIs, spelled out here so this file says exactly what it calls ----
const CollectionAbi = parseAbi([
  "function totalSupply() view returns (uint256)",
  "function ownerOf(uint256 id) view returns (address)",
  "function individuals(uint256 id) view returns (bytes32 baseModelId, bytes32 deltaHash, bytes32 modelId, bytes32 mepId, uint8 sex, uint32 generation, uint64 parentA, uint64 parentB, bytes32 seed, uint64 seedBlock)",
  "function owed(address who) view returns (uint256)",
  "function MARKET() view returns (address)",
  "function BREED_FEE() view returns (uint256)",
  "function HATCH_BOUNTY() view returns (uint256)",
  "function MINT_PRICE() view returns (uint256)",
  "function MINT_BOND() view returns (uint256)",
  "function ROYALTY_BPS() view returns (uint16)",
  "function BASE_SHARE_BPS() view returns (uint16)",
  "function SALE_ROYALTY_BPS() view returns (uint16)",
  "function getApproved(uint256 id) view returns (address)",
  "function isApprovedForAll(address owner, address operator) view returns (bool)",
  "function approve(address to, uint256 id)",
  "function hatch(uint256 id) returns (bytes32)",
  "function rearm(uint256 id)",
  "function settle(uint256 id)",
  "function withdraw()",
]);
const SaleAbi = parseAbi([
  "function collection() view returns (address)",
  "function treasury() view returns (address)",
  "function paused() view returns (bool)",
  "function listings(uint256 id) view returns (uint256 price, uint64 expiresAt, uint256 revision)",
  "function available(uint256 id) view returns (uint256)",
  "function buy(uint256 id, uint256 price, uint256 revision, uint256 deadline) payable",
]);
const BatteryAbi = parseAbi([
  "function collection() view returns (address)",
  "function budget() view returns (uint256)",
  "function breed(uint256 dam, uint256 sire) payable",
]);
const MarketAbi = parseAbi(["function royalties(bytes32 mepId) view returns (uint256)"]);

// ---- where the addresses come from: a relayer an outsider can reach, or an operator's sourced env ----
async function deployment() {
  const relayer = flag("relayer");
  if (relayer) {
    const r = await fetch(relayer.replace(/\/$/, "") + "/deployment", { signal: AbortSignal.timeout(30000) });
    if (!r.ok) throw new Error(`the relayer at ${relayer} answered ${r.status} for /deployment`);
    return await r.json();
  }
  const envFile = flag("env");
  if (envFile) for (const line of fs.readFileSync(envFile, "utf8").split("\n")) {
    const m = line.match(/^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*)$/); if (m) process.env[m[1]] ??= m[2].replace(/^["']|["']$/g, "");
  }
  const { deploymentFromEnv } = await import("../relayer/env.mjs");
  const dep = deploymentFromEnv();
  if (!dep) throw new Error("no deployment: pass --relayer <url>, or --env <file>, or `source .env.<network>` first");
  return dep;
}

const dep = await deployment();
const addresses = dep.addresses || dep;
const COLLECTION = addresses.collection, SALE = addresses.inventorySale, BATTERY = addresses.batteryBudget;
if (!COLLECTION) throw new Error("this deployment has no collection: there are no flies here");
const pub = createPublicClient({ transport: http(dep.rpc) });

const bnb = (wei) => `${formatEther(wei)} BNB`;
// FlyCollection.sol: FEMALE = 0, MALE = 1, UNHATCHED = 2. Getting this backwards does not error -- it produces a
// tool that calmly calls every female an egg, which is how it was caught: by running it against the real chain.
const FEMALE = 0, MALE = 1, UNHATCHED = 2;
const SEX = { [FEMALE]: "female", [MALE]: "male", [UNHATCHED]: "egg (unhatched)" };
// a genesis founder has no seed and never had one; what makes something an egg is its SEX, not a zero seed
const isEgg = (f) => f.sex === UNHATCHED;
// and what can breed is a born individual with a delta of its own (FlyCollection: canBreed in the page)
const canBreed = (f) => !isEgg(f) && BigInt(f.deltaHash) !== 0n;
const read = (address, abi, fn, a = []) => pub.readContract({ address, abi, functionName: fn, args: a });
/** viem puts its summary on one line and the contract's actual reason on the next; a caller needs the reason. */
/** viem nests the contract's own revert string; `shortMessage` puts its summary on line 1 and the reason on line 2,
 *  and `metaMessages` is the call trace, not the reason. What a caller needs is the contract's words. */
const why = (e) => {
  const reason = e.walk?.((x) => x?.reason !== undefined)?.reason ?? e.cause?.reason;
  if (reason) return String(reason);
  const lines = String(e.shortMessage || e.message || e).split("\n").map((l) => l.trim()).filter(Boolean);
  return lines.length > 1 && /reason:?$/.test(lines[0]) ? lines[1] : lines[0] || String(e);
};
/** a clear answer for an id that is simply not there, instead of a raw ownerOf revert */
async function mustExist(id) {
  const n = await read(COLLECTION, CollectionAbi, "totalSupply");
  if (id < 1n || id > n) throw new Error(`there is no fly #${id}: this collection has ${n}`);
}

/** The account, only when a command needs one. Read from the environment, used to sign, never printed:
 *  what is shown is the ADDRESS it derives to, which is public and is the thing a user needs to check. */
function account() {
  const pk = process.env.FLY_KEY || process.env.PORW_DEPLOYER_KEY;
  if (!pk) throw new Error("set FLY_KEY to the key that holds (or will hold) these flies. It is never printed, and this tool sends nothing without --broadcast");
  return privateKeyToAccount(pk.startsWith("0x") ? pk : `0x${pk}`);
}

/** The one place a transaction leaves this file. It prints the whole of what it would do first, and without
 *  --broadcast that is ALL it does: no signature, no nonce taken, nothing to undo. */
async function send({ what, address, abi, fn, args: a = [], value = 0n, to }) {
  const acct = account();
  const chainId = await pub.getChainId();
  if (Number(chainId) !== Number(dep.chainId)) throw new Error(`the RPC is chain ${chainId} but this deployment is chain ${dep.chainId}`);
  const balance = await pub.getBalance({ address: acct.address });
  console.log(`\n${what}`);
  console.log(`  from     ${acct.address}  (holds ${bnb(balance)})`);
  console.log(`  to       ${address}${to ? `  — ${to}` : ""}`);
  console.log(`  call     ${fn}(${a.join(", ")})`);
  console.log(`  value    ${value === 0n ? "nothing" : bnb(value)}`);
  // simulate first: a revert here costs nothing and says why, which is the whole point of doing it before asking
  let request;
  try { ({ request } = await pub.simulateContract({ account: acct, address, abi, functionName: fn, args: a, value })); }
  catch (e) { console.log(`  REFUSED  the chain rejects this call: ${why(e)}`); process.exit(1); }
  if (value > balance) { console.log(`  REFUSED  ${acct.address} holds ${bnb(balance)}, which does not cover ${bnb(value)}`); process.exit(1); }
  if (!BROADCAST) { console.log(`  DRY RUN  nothing was sent. Add --broadcast to send it.`); return null; }
  const wallet = createWalletClient({ account: acct, transport: http(dep.rpc) });
  const hash = await wallet.writeContract(request);
  console.log(`  sent     ${hash}`);
  const rcpt = await pub.waitForTransactionReceipt({ hash });
  console.log(`  ${rcpt.status === "success" ? "MINED   " : "REVERTED"} block ${rcpt.blockNumber}, gas ${rcpt.gasUsed}`);
  if (rcpt.status !== "success") process.exit(1);
  return rcpt;
}

async function terms() {
  const t = {};
  for (const [k, fn] of [["mintPrice", "MINT_PRICE"], ["mintBond", "MINT_BOND"], ["breedFee", "BREED_FEE"], ["bounty", "HATCH_BOUNTY"]])
    t[k] = await read(COLLECTION, CollectionAbi, fn).catch(() => 0n);
  for (const [k, fn] of [["royaltyBps", "ROYALTY_BPS"], ["baseShareBps", "BASE_SHARE_BPS"], ["saleRoyaltyBps", "SALE_ROYALTY_BPS"]])
    t[k] = Number(await read(COLLECTION, CollectionAbi, fn).catch(() => 0));
  return t;
}

/** every individual, once. The collection is small and this is one pass rather than a call per question. */
async function colony() {
  const n = Number(await read(COLLECTION, CollectionAbi, "totalSupply"));
  const market = await read(COLLECTION, CollectionAbi, "MARKET");
  const royaltyBps = Number(await read(COLLECTION, CollectionAbi, "ROYALTY_BPS").catch(() => 0));
  const all = [];
  for (let id = 1n; id <= BigInt(n); id++) {
    const x = await read(COLLECTION, CollectionAbi, "individuals", [id]);
    const owner = await read(COLLECTION, CollectionAbi, "ownerOf", [id]);
    const mepId = x[3], sex = Number(x[4]), deltaHash = x[1];
    const pending = royaltyBps > 0 && BigInt(mepId) !== 0n ? await read(market, MarketAbi, "royalties", [mepId]).catch(() => 0n) : 0n;
    all.push({ id, owner, mepId, sex, deltaHash, generation: Number(x[5]), parentA: x[6], parentB: x[7], seed: x[8], seedBlock: x[9], pending });
  }
  return all;
}

// A stack trace is not an answer. Everything below refuses with one sentence, on stderr, and a non-zero exit --
// which is what a person reads and what an agent can act on.
try {
switch (cmd) {
  case "terms": {
    const t = await terms();
    console.log(`collection ${COLLECTION} on chain ${dep.chainId}`);
    console.log(`  adopt (mint price)   ${bnb(t.mintPrice)}${t.mintBond > 0n ? `, of which ${bnb(t.mintBond)} is the adopter's own bond` : ""}`);
    console.log(`  breed fee            ${bnb(t.breedFee)}`);
    console.log(`  hatch bounty         ${bnb(t.bounty)}  — paid to whoever hatches an egg`);
    console.log(`  owner's royalty      ${t.royaltyBps / 100}% of every experiment run on a fly`);
    console.log(`  base vendor's share  ${t.baseShareBps / 100}% of that royalty`);
    console.log(`  resale royalty       ${t.saleRoyaltyBps / 100}%`);
    break;
  }
  case "list": {
    const who = rest[0] ? getAddress(rest[0]) : (process.env.FLY_KEY || process.env.PORW_DEPLOYER_KEY ? account().address : null);
    const all = await colony();
    console.log(`collection ${COLLECTION}: ${all.length} individual(s)${who ? `, as seen by ${who}` : ""}`);
    for (const f of all) {
      const mine = who && f.owner.toLowerCase() === who.toLowerCase();
      const parents = f.parentA ? `${f.parentA} × ${f.parentB}` : "genesis";
      const egg = isEgg(f) ? `  — waiting to hatch (seed block ${f.seedBlock})` : "";
      console.log(`  #${f.id}  ${SEX[f.sex] ?? "?"}  gen ${f.generation}  ${parents}${egg}${f.pending > 0n ? `  set aside ${bnb(f.pending)}` : ""}${mine ? "   <- yours" : ""}`);
    }
    if (who) console.log(`\nowed to ${who}: ${bnb(await read(COLLECTION, CollectionAbi, "owed", [who]))}  (collect with: withdraw)`);
    break;
  }
  case "inventory": {
    if (!SALE) throw new Error("this deployment has no treasury inventory sale: nothing is open for adoption here");
    const collection = await read(SALE, SaleAbi, "collection");
    if (collection.toLowerCase() !== COLLECTION.toLowerCase()) throw new Error(`the sale at ${SALE} sells a different collection (${collection})`);
    const treasury = await read(SALE, SaleAbi, "treasury");
    const paused = await read(SALE, SaleAbi, "paused").catch(() => false);
    const all = await colony();
    console.log(`treasury inventory ${SALE}${paused ? "  (PAUSED)" : ""}\n  seller ${treasury} — these are existing NFTs; adopting moves one, it does not mint\n`);
    let open = 0;
    for (const f of all) {
      if (f.owner.toLowerCase() !== treasury.toLowerCase()) continue;
      const [price, expiresAt, revision] = await read(SALE, SaleAbi, "listings", [f.id]);
      if (price === 0n || (await read(SALE, SaleAbi, "available", [f.id])) === 0n) continue;
      open++;
      console.log(`  #${f.id}  ${SEX[f.sex] ?? "?"}  gen ${f.generation}  ${bnb(price)}   revision ${revision}${expiresAt > 0n ? `  expires ${new Date(Number(expiresAt) * 1000).toISOString()}` : ""}`);
    }
    console.log(open ? `\n${open} open for adoption.  node js/fly.mjs adopt <id> --broadcast` : "\nnothing is open for adoption right now.");
    break;
  }
  case "adopt": {
    const id = BigInt(rest[0] ?? (() => { throw new Error("which one? node js/fly.mjs adopt <id>"); })());
    await mustExist(id);
    if (!SALE) throw new Error("this deployment has no treasury inventory sale");
    const treasury = await read(SALE, SaleAbi, "treasury");
    if (await read(SALE, SaleAbi, "paused").catch(() => false)) throw new Error("the treasury sale is paused");
    const owner = await read(COLLECTION, CollectionAbi, "ownerOf", [id]);
    if (owner.toLowerCase() !== treasury.toLowerCase()) throw new Error(`fly #${id} is held by ${owner}, not the treasury: it is not the treasury's to sell`);
    const [price, expiresAt, revision] = await read(SALE, SaleAbi, "listings", [id]);
    if (price === 0n) throw new Error(`fly #${id} is not listed`);
    if (!(await read(SALE, SaleAbi, "available", [id]))) throw new Error(`fly #${id} is listed but not available`);
    const block = await pub.getBlock();
    if (expiresAt > 0n && BigInt(block.timestamp) >= expiresAt) throw new Error(`that listing expired at ${new Date(Number(expiresAt) * 1000).toISOString()}`);
    if (account().address.toLowerCase() === treasury.toLowerCase()) throw new Error("the treasury cannot buy its own inventory");
    const deadline = BigInt(block.timestamp) + 600n;
    // price and revision are passed BACK to the contract: if the listing moved between this read and the send, the
    // call reverts rather than paying a price nobody quoted.
    await send({ what: `Adopt fly #${id} — an existing NFT moves from the treasury to you`, address: SALE, abi: SaleAbi,
      fn: "buy", args: [id, price, revision, deadline], value: price, to: `proceeds to the treasury ${treasury}` });
    break;
  }
  case "breed": {
    const dam = BigInt(rest[0] ?? -1), sire = BigInt(rest[1] ?? -1);
    if (dam < 0n || sire < 0n) throw new Error("which two? node js/fly.mjs breed <dam> <sire>   (dam is the female, sire the male)");
    if (!BATTERY) throw new Error("funded breeding is not configured for this deployment (no battery budget)");
    if (addresses.tokenBatteryBudget && !addresses.batteryBudget) throw new Error("this deployment breeds through the token route, which needs a liquidity quote: use the page for now");
    if ((await read(BATTERY, BatteryAbi, "collection")).toLowerCase() !== COLLECTION.toLowerCase()) throw new Error("the battery budget is for a different collection");
    const me = account().address;
    const all = await colony(); const byId = new Map(all.map((f) => [f.id, f]));
    const d = byId.get(dam), s = byId.get(sire);
    for (const [f, id, want] of [[d, dam, FEMALE], [s, sire, MALE]]) {
      if (!f) throw new Error(`there is no fly #${id}`);
      if (f.owner.toLowerCase() !== me.toLowerCase()) throw new Error(`fly #${id} is held by ${f.owner}, not by you`);
      if (isEgg(f)) throw new Error(`fly #${id} is still an egg: hatch it first`);
      if (!canBreed(f)) throw new Error(`fly #${id} has no delta of its own and cannot breed`);
      if (f.sex !== want) throw new Error(`breeding needs a female dam and a male sire; fly #${id} is ${SEX[f.sex] ?? "?"}`);
    }
    const fee = await read(COLLECTION, CollectionAbi, "BREED_FEE");
    const budget = await read(BATTERY, BatteryAbi, "budget");
    // the factory has to be able to move both parents; approving is a separate transaction and is not the breed
    for (const id of [dam, sire]) {
      const approved = await read(COLLECTION, CollectionAbi, "getApproved", [id]);
      const forAll = await read(COLLECTION, CollectionAbi, "isApprovedForAll", [me, BATTERY]);
      if (approved.toLowerCase() === BATTERY.toLowerCase() || forAll) continue;
      await send({ what: `Approve the battery factory to move fly #${id} (required before breeding)`, address: COLLECTION,
        abi: CollectionAbi, fn: "approve", args: [BATTERY, id] });
      if (!BROADCAST) console.log(`  (and breeding itself would follow, for ${bnb(fee + budget)})`);
    }
    if (!BROADCAST) { console.log(`\nBreed #${dam} × #${sire} — ${bnb(fee)} breed fee + ${bnb(budget)} to fund the child's battery = ${bnb(fee + budget)}`);
      console.log(`  DRY RUN  nothing was sent. Add --broadcast to send it.`); break; }
    await send({ what: `Breed #${dam} × #${sire} — the fee funds the child's battery`, address: BATTERY, abi: BatteryAbi,
      fn: "breed", args: [dam, sire], value: fee + budget, to: "the battery budget factory" });
    console.log(`  the child is an EGG: it needs \`hatch\` once its seed block is in`);
    break;
  }
  case "hatch": {
    const id = BigInt(rest[0] ?? (() => { throw new Error("which one? node js/fly.mjs hatch <id>"); })());
    await mustExist(id);
    const x = await read(COLLECTION, CollectionAbi, "individuals", [id]);
    if (Number(x[4]) !== UNHATCHED) throw new Error(`fly #${id} is not an egg: it is already ${SEX[Number(x[4])] ?? "hatched"}`);
    const bounty = await read(COLLECTION, CollectionAbi, "HATCH_BOUNTY").catch(() => 0n);
    await send({ what: `Hatch egg #${id} — fixes what it is, from the seed block's hash${bounty > 0n ? `; pays you ${bnb(bounty)}` : ""}`,
      address: COLLECTION, abi: CollectionAbi, fn: "hatch", args: [id] });
    break;
  }
  case "rearm": {
    const id = BigInt(rest[0] ?? (() => { throw new Error("which one? node js/fly.mjs rearm <id>"); })());
    await mustExist(id);
    const fee = await read(COLLECTION, CollectionAbi, "BREED_FEE");
    await send({ what: `Rearm egg #${id} — its seed block aged out of reach, and a new one costs another breed fee`,
      address: COLLECTION, abi: CollectionAbi, fn: "rearm", args: [id], value: fee });
    break;
  }
  case "settle": {
    const id = BigInt(rest[0] ?? (() => { throw new Error("which one? node js/fly.mjs settle <id>"); })());
    await mustExist(id);
    await send({ what: `Settle fly #${id} — move what its experiments set aside to whoever owns it`,
      address: COLLECTION, abi: CollectionAbi, fn: "settle", args: [id] });
    break;
  }
  case "withdraw": {
    const me = account().address;
    const owed = await read(COLLECTION, CollectionAbi, "owed", [me]);
    if (owed === 0n) { console.log(`nothing is owed to ${me}.\n(royalties reach you through \`settle <id>\` on a fly whose experiments have been paid for)`); break; }
    await send({ what: `Withdraw ${bnb(owed)} owed to you`, address: COLLECTION, abi: CollectionAbi, fn: "withdraw" });
    break;
  }
  default:
    console.log(`unknown command "${cmd}"\n\n${USAGE}`);
    process.exit(2);
}
} catch (e) {
  console.error(`fly ${cmd}: ${why(e)}`);
  process.exit(1);
}
