// DESIGN §4b describes multi-currency settlement, and says plainly that none of it is built. A design note that says
// "not built" is the first thing to go stale, and the way it goes stale is silent: somebody adds the asset, and the
// document keeps telling readers it is a proposal. So the claim is checked against the code it is a claim about.
//
// When multi-currency IS built, this test fails -- and what it asks for then is not a code change but an honest
// document. Every failure below names the sentence that has stopped being true.
import fs from "node:fs"; import path from "node:path"; import { fileURLToPath } from "node:url";
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const rd = (p) => fs.readFileSync(path.join(root, p), "utf8");
let fails = 0; const check = (n, ok, note = "") => { console.log((ok ? "  ok   " : "  FAIL ") + n + (ok || !note ? "" : "  " + note)); if (!ok) fails++; };

const design = rd("docs/DESIGN.md");
const s = design.slice(design.indexOf("## 4b."), design.indexOf("## 5. Cost model"));
check("DESIGN has the settlement-assets section", s.length > 500);
check("it names the three assets the design is for", ["BNB", "AIGG", "USDC"].every((a) => s.includes(a)));
check("it keeps the protocol capability and the treasury's policy apart", /governance/i.test(s) && /protocol capability/i.test(s));
check("it states that none of it is built", /Nothing below is built/.test(s));

// ---- the claims about today's code, checked against today's code ----
const coll = rd("contracts/src/FlyCollection.sol");
check("the collection still takes one currency: `msg.value == MINT_PRICE`", /require\(msg\.value == MINT_PRICE, "price"\)/.test(coll));
check("and one for breeding", /require\(msg\.value == BREED_FEE, "fee"\)/.test(coll));
check("its credit ledger is still a single balance (`owed`), not a balance per asset",
  /mapping\(address => uint256\) public owed/.test(coll) && !/owed\[[^\]]*\]\[/.test(coll));

const market = rd("contracts/lib/aigg-porw/contracts/evm/src/mesh/TaskMarket.sol");
check("the market still takes the fee as native value", /require\(msg\.value == t\.fee, "fee"\)/.test(market));
check("it pays executors, refunds and royalties in native value", /ex\[i\]\.call\{value: share\}/.test(market) && /st\.client\.call\{value: st\.t\.fee\}/.test(market));
check("royalties are one number per MEP, not one per MEP per asset", /mapping\(bytes32 => uint256\) public royalties/.test(market));

const mesh = rd("contracts/lib/aigg-porw/contracts/evm/src/interfaces/PorwMesh.sol");
const task = /struct Task \{([^}]*)\}/.exec(mesh)?.[1] ?? "";
check("the Task carries no settlement asset", !!task && !/address\s+(asset|token|currency)/i.test(task), task.trim());
check("and the task id is the hash of the whole Task, so adding one is a breaking change upstream",
  /function taskId[\s\S]{0,140}keccak256\(abi\.encode\(t, nonce\)\)/.test(mesh) && /breaking protocol change/i.test(s));

// the gateway prices in one unit too, and the blueprint names no asset
check("the gateway's rate is a bare wei figure, with no asset beside it",
  /GATEWAY_WEI_PER_STEP \|\| "\d+"/.test(rd("gateway/gateway.mjs")) && !/GATEWAY_(ASSET|TOKEN|CURRENCY)/.test(rd("render.yaml")));

console.log(fails ? `${fails} FAILURES — DESIGN §4b no longer describes the code` : "settlement assets: the design and the code agree (nothing is built, and it says so)");
process.exit(fails ? 1 : 0);
