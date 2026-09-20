import fs from "node:fs"; import path from "node:path"; import { fileURLToPath } from "node:url";
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const rd = (p) => fs.readFileSync(path.join(root, p), "utf8");
let fails = 0; const check = (n, ok, note = "") => { console.log((ok ? "  ok   " : "  FAIL ") + n + (ok || !note ? "" : "  " + note)); if (!ok) fails++; };

const design = rd("docs/DESIGN.md");
const s = design.slice(design.indexOf("## 4b."), design.indexOf("## 5. Cost model"));
check("DESIGN has the settlement-assets section", s.length > 500);
check("it names the three assets the design is for", ["BNB", "AIGG", "USDC"].every((a) => s.includes(a)));
check("it keeps the protocol capability and the treasury's policy apart", /governance/i.test(s) && /protocol capability/i.test(s));
check("it distinguishes the optional implementation from production configuration", /Implemented as an optional local deployment/.test(s) && !/Nothing below is built/.test(s));

// ---- the claims about today's code, checked against today's code ----
const coll = rd("contracts/src/FlyCollection.sol");
check("original collection mint remains native: `msg.value == MINT_PRICE`", /require\(msg\.value == MINT_PRICE, "price"\)/.test(coll));
check("and one for breeding", /require\(msg\.value == BREED_FEE, "fee"\)/.test(coll));
check("the collection retains native and token royalty ledgers", /public owed/.test(coll) && /tokenOwed/.test(coll));

const market = rd("contracts/lib/aigg-porw/contracts/evm/src/mesh/TaskMarket.sol");
check("the market still takes the fee as native value", /require\(msg\.value == t\.fee, "fee"\)/.test(market));
check("it pays executors, refunds and royalties in native value", /ex\[i\]\.call\{value: share\}/.test(market) && /st\.client\.call\{value: st\.t\.fee\}/.test(market));
check("royalties are one number per MEP, not one per MEP per asset", /mapping\(bytes32 => uint256\) public royalties/.test(market));

const mesh = rd("contracts/lib/aigg-porw/contracts/evm/src/interfaces/PorwMesh.sol");
const task = /struct Task \{([^}]*)\}/.exec(mesh)?.[1] ?? "";
check("the Task carries no settlement asset", !!task && !/address\s+(asset|token|currency)/i.test(task), task.trim());
check("the legacy task hash remains unchanged upstream",
  /function taskId[\s\S]{0,140}keccak256\(abi\.encode\(t, nonce\)\)/.test(mesh));

// the gateway prices in one unit too, and the blueprint names no asset
check("the gateway's rate is a bare wei figure, with no asset beside it",
  /GATEWAY_WEI_PER_STEP \|\| "\d+"/.test(rd("gateway/gateway.mjs")) && !/GATEWAY_(ASSET|TOKEN|CURRENCY)/.test(rd("render.yaml")));

console.log(fails ? `${fails} FAILURES — DESIGN §4b no longer describes the code` : "settlement assets: optional multi-asset implementation and legacy native path documented");
process.exit(fails ? 1 : 0);
