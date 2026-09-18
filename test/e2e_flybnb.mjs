// The FlyBnB acknowledgments follow the chain. /flybnb/holders is what the page renders and what the paper's
// appendix is generated from: whoever holds an individual is on it, a mint adds an address, a transfer moves a
// token from one address to another, and an address that holds nothing is gone.
import { parseEther } from "viem";
import * as H from "./harness.mjs";
let fails = 0; const check = (n, ok) => { console.log((ok ? "  ok   " : "  FAIL ") + n); if (!ok) fails++; };
const low = (a) => a.toLowerCase();

H.forgeBuild();
const anvil = await H.startAnvil(8563);
let R = null;
try {
  const dep = await H.deployMesh(anvil.rpc); const { mepId } = await H.registerSyntheticMep(dep, H.KEYS[0]);
  const A = H.clientsFor(dep, H.KEYS[1]), B = H.clientsFor(dep, H.KEYS[2]); const a = low(A.account.address), b = low(B.account.address);
  const C = await H.deployCollection(dep, parseEther("0.002")); await H.adoptBoth(A, C); // A mints the two genesis flies
  R = await H.startRelayer(dep, H.KEYS[3], [mepId], { env: { PORW_BEACON_LAZY: "1", PORW_COLLECTION: C, PORW_KEEPER: "0" } });
  const fresh = async () => { await anvil.mine(12); return R.api("/flybnb/holders"); }; // past the cache's 10 blocks

  let h = await R.api("/flybnb/holders");
  check("the minter holds both genesis individuals", h.holders.length === 1 && low(h.holders[0].address) === a && String(h.holders[0].tokens) === "1,2" && h.totalSupply === 2);
  check("it names the collection, the chain and the block it was read at", low(h.collection) === low(C) && h.chainId === 31337 && h.block > 0 && !h.truncated);
  check("each token carries what the appendix prints", h.tokens.length === 2 && h.tokens[0].id === 1 && low(h.tokens[0].owner) === a && h.tokens[0].generation === 0);

  await H.sendTo(A, C, "FlyCollection", "transferFrom", [A.account.address, B.account.address, 2n]);
  check("inside the cache window the old list is served, with its block", (await R.api("/flybnb/holders")).block === h.block);
  h = await fresh();
  check("a transfer moves the token to the new holder", h.holders.length === 2 && h.holders.some((x) => low(x.address) === a && String(x.tokens) === "1") && h.holders.some((x) => low(x.address) === b && String(x.tokens) === "2"));

  await H.sendTo(B, C, "FlyCollection", "approve", [A.account.address, 2n]);
  await H.sendTo(A, C, "FlyCollection", "breed", [1n, 2n], H.FLY_BREED_FEE);
  h = await fresh();
  check("a new individual adds to its breeder's line, and the larger holder is listed first", h.totalSupply === 3 && low(h.holders[0].address) === a && String(h.holders[0].tokens) === "1,3" && h.tokens[2].generation === 1);

  await H.sendTo(A, C, "FlyCollection", "transferFrom", [A.account.address, B.account.address, 1n]);
  await H.sendTo(A, C, "FlyCollection", "transferFrom", [A.account.address, B.account.address, 3n]);
  h = await fresh();
  check("an address that holds nothing is not acknowledged", h.holders.length === 1 && low(h.holders[0].address) === b && String(h.holders[0].tokens) === "1,2,3");
} catch (e) { console.error(e); fails++; }
finally { if (R) R.stop(); anvil.stop(); }
console.log(fails ? `${fails} FAILURES` : "flybnb holders: all checks passed"); process.exit(fails ? 1 : 0);
