// js/fly.mjs, against a real chain, as a user would run it.
//
// This is a tool that spends money on behalf of whoever runs it -- possibly an agent. Two properties matter more
// than the features: a dry run must send NOTHING (not a signature, not a nonce), and the key must never appear in
// anything it prints. Both are asserted here against a key whose value the test knows, on an anvil where the whole
// chain can be inspected before and after.
//
// The rest is the four operations that had no terminal path at all before this file existed: adopt, breed, hatch
// and withdraw.
import fs from "node:fs"; import path from "node:path"; import { execFile } from "node:child_process";
import { parseEther } from "viem";
import * as H from "./harness.mjs";
let fails = 0; const check = (n, ok, note = "") => { console.log((ok ? "  ok   " : "  FAIL ") + n + (ok || !note ? "" : "  " + note)); if (!ok) fails++; };

const G = JSON.parse(fs.readFileSync(path.join(H.root, "flybnb/genesis/genesis-v1.json"), "utf8"));
H.forgeBuild();
const anvil = await H.startAnvil(8568); const stop = [];
/** run the CLI exactly as a person would, and capture everything it says */
const fly = (args, env = {}) => new Promise((res) => {
  execFile(process.execPath, [path.join(H.root, "js/fly.mjs"), ...args], { cwd: H.root, env: { ...process.env, ...env } },
    (err, stdout, stderr) => res({ code: err?.code ?? 0, out: String(stdout), err: String(stderr), all: String(stdout) + String(stderr) }));
});

try {
  const dep = await H.deployMesh(anvil.rpc);
  const base = await H.registerSyntheticMep(dep, H.KEYS[0], { name: "fly-cli-base" });
  const T = H.clientsFor(dep, H.KEYS[0]);        // the treasury, which holds the inventory
  const BUYER_KEY = H.KEYS[1], B = H.clientsFor(dep, BUYER_KEY);
  const PRICE = parseEther("0.0404");
  const C = await H.deployCollection(dep, 0n, H.KEYS[0], { genesis: G });
  for (const g of G.individuals.slice(0, 3)) await H.sendTo(T, C, "FlyCollection", "mint", [g.index, g.sex, g.deltaHash, g.proof], H.FLY_PRICE);
  const S = await H.create(T, "TreasuryInventorySale", [C, T.account.address]);
  await H.sendTo(T, C, "FlyCollection", "approve", [S, 1n]);
  const expiry = (await T.pub.getBlock()).timestamp + 3600n;
  await H.sendTo(T, S, "TreasuryInventorySale", "list", [1n, PRICE, expiry]);
  const R = await H.startRelayer(dep, H.KEYS[3], [base.mepId],
    { env: { PORW_BEACON_LAZY: "1", PORW_COLLECTION: C, PORW_INVENTORY_SALE: S, PORW_KEEPER: "0" } });
  stop.push(() => R.stop());
  const rel = ["--relayer", R.apiBase];

  // ---- free, and without a key at all: what a stranger can see ----
  const noKey = { FLY_KEY: "", PORW_DEPLOYER_KEY: "" };
  { const r = await fly(["terms", ...rel], noKey);
    check("terms works with no key at all", r.code === 0 && /breed fee/.test(r.out), r.all.slice(0, 120)); }
  { const r = await fly(["inventory", ...rel], noKey);
    check("inventory lists what the treasury has open, with its price", r.code === 0 && r.out.includes("#1") && /0\.0404 BNB/.test(r.out), r.all.slice(0, 200));
    check("  and says adoption moves an existing NFT rather than minting", /existing NFTs/.test(r.out)); }
  { const r = await fly(["list", ...rel], noKey);
    check("list names every individual and its sex", r.code === 0 && /#1\s+female/.test(r.out) && /3 individual/.test(r.out), r.out.slice(0, 200)); }

  // ---- the two properties that matter ----
  const buyer = B.account.address;
  const before = { nonce: await B.pub.getTransactionCount({ address: buyer }), balance: await B.pub.getBalance({ address: buyer }), block: await B.pub.getBlockNumber() };
  const dry = await fly(["adopt", "1", ...rel], { FLY_KEY: BUYER_KEY });
  const after = { nonce: await B.pub.getTransactionCount({ address: buyer }), balance: await B.pub.getBalance({ address: buyer }), block: await B.pub.getBlockNumber() };
  check("a dry run exits 0 and says so", dry.code === 0 && /DRY RUN/.test(dry.out), dry.all.slice(-200));
  check("  it shows the exact call, value and who is paid", /buy\(1, 40400000000000000, /.test(dry.out) && /0\.0404 BNB/.test(dry.out) && /proceeds to the treasury/.test(dry.out), dry.out.slice(-300));
  check("  AND IT SENDS NOTHING: no nonce taken, no balance moved, no block mined",
    after.nonce === before.nonce && after.balance === before.balance && after.block === before.block,
    `nonce ${before.nonce}->${after.nonce}, block ${before.block}->${after.block}`);
  check("the key never appears in anything it printed", !dry.all.includes(BUYER_KEY) && !dry.all.includes(BUYER_KEY.slice(2)), "THE KEY WAS PRINTED");
  check("  what it shows instead is the address that key derives to", dry.out.includes(buyer));

  // ---- and then, for real ----
  const owner0 = await H.readFrom(T, C, "FlyCollection", "ownerOf", [1n]);
  const live = await fly(["adopt", "1", ...rel, "--broadcast"], { FLY_KEY: BUYER_KEY });
  check("--broadcast mines it", live.code === 0 && /MINED/.test(live.out), live.all.slice(-300));
  const owner1 = await H.readFrom(T, C, "FlyCollection", "ownerOf", [1n]);
  check("the fly really changed hands", owner0.toLowerCase() === T.account.address.toLowerCase() && owner1.toLowerCase() === buyer.toLowerCase(), `${owner0} -> ${owner1}`);
  check("exactly one transaction was sent", (await B.pub.getTransactionCount({ address: buyer })) === before.nonce + 1);
  check("the key is not in the broadcast output either", !live.all.includes(BUYER_KEY));
  { const r = await fly(["list", ...rel], { FLY_KEY: BUYER_KEY });
    check("and `list` now marks it as the buyer's", /#1\s+female.*<- yours/.test(r.out), (r.out.match(/#1[^\n]*/) || [""])[0]); }
  { const r = await fly(["adopt", "1", ...rel], { FLY_KEY: BUYER_KEY });
    check("adopting it again is refused: the treasury no longer holds it", r.code !== 0 && /not the treasury/.test(r.all), r.all.slice(0, 160)); }

  // ---- the guards, each of which is a way to lose money ----
  { const r = await fly(["adopt", "99", ...rel], { FLY_KEY: BUYER_KEY });
    check("an id that does not exist is named, not reverted at", r.code !== 0 && /there is no fly #99/.test(r.all), r.all.slice(0, 140)); }
  { const r = await fly(["hatch", "2", ...rel], { FLY_KEY: BUYER_KEY });
    check("hatching something already born is refused before it costs gas", r.code !== 0 && /not an egg/.test(r.all), r.all.slice(0, 140)); }
  { const r = await fly(["breed", "1", "2", ...rel], { FLY_KEY: BUYER_KEY });
    check("breeding without a battery budget says so plainly", r.code !== 0 && /not configured|battery/.test(r.all), r.all.slice(0, 160)); }
  { const r = await fly(["withdraw", ...rel], { FLY_KEY: BUYER_KEY });
    check("withdrawing nothing is not an error, and says where royalties come from", r.code === 0 && /nothing is owed/.test(r.out) && /settle/.test(r.out), r.out.slice(0, 160)); }
  { const r = await fly(["withdraw", ...rel], noKey);
    check("a writing command with no key refuses and explains", r.code !== 0 && /FLY_KEY/.test(r.all), r.all.slice(0, 140));
    check("  and even that message does not leak one", !r.all.includes(BUYER_KEY)); }
  { const r = await fly(["nonsense", ...rel], noKey);
    check("an unknown command prints the usage", r.code === 2 && /usage: node js\/fly\.mjs/.test(r.out)); }
  { const r = await fly(["terms"], { ...noKey, PORW_RPC: "", PORW_COLLECTION: "" });
    check("with no deployment at all it says which flag to pass", r.code !== 0 && /--relayer|--env|source \.env/.test(r.all), r.all.slice(0, 160)); }

} catch (e) { console.error(e); fails++; } finally { for (const s of stop) { try { await s(); } catch {} } anvil.stop(); }
console.log(fails ? `${fails} FAILURES` : "fly cli: all checks passed");
process.exit(fails ? 1 : 0);
