// The fee rate, stated in one unit and checked against the one the gateway actually charges.
//
// This test exists because the documentation said "0.1 gwei per step per provider" while the deployed rate was a
// thousand times that, and the arithmetic beside it (195,000 x 2 x 10^-10 = 0.039 BNB) did not hold in either
// reading. The value 0.039 was right; the unit was not. It is an easy mistake to make here because there IS a real
// 0.1 gwei in this project -- the measured GAS price on BSC testnet -- and the two are different quantities.
//
// So: whatever the blueprint charges, the documents must say the same number, and the worked examples must multiply.
import fs from "node:fs"; import path from "node:path"; import { fileURLToPath } from "node:url";
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const rd = (p) => fs.readFileSync(path.join(root, p), "utf8");
let fails = 0; const check = (n, ok, note = "") => { console.log((ok ? "  ok   " : "  FAIL ") + n + (ok || !note ? "" : "  " + note)); if (!ok) fails++; };

// what the deployment actually charges
const yaml = rd("render.yaml");
const wei = BigInt(/GATEWAY_WEI_PER_STEP\s*\n\s*value:\s*"?(\d+)"?/.exec(yaml)?.[1] ?? /- key: GATEWAY_WEI_PER_STEP[\s\S]{0,80}?value:\s*"(\d+)"/.exec(yaml)?.[1] ?? "0");
check("render.yaml sets a wei-per-step", wei > 0n);
const gwei = Number(wei) / 1e9, bnb = Number(wei) / 1e18;
console.log(`         the blueprint charges ${wei} wei = ${gwei} gwei = ${bnb} BNB per step per provider`);

// and the gateway's own default, which a bare `npm run gateway` would use
const gw = rd("gateway/gateway.mjs");
const dflt = BigInt(/GATEWAY_WEI_PER_STEP \|\| "(\d+)"/.exec(gw)?.[1] ?? "0");
check("the gateway's default rate is the blueprint's", dflt === wei, `${dflt} vs ${wei}`);

// every document that names the rate names THIS rate
for (const f of ["docs/TOKENOMICS.md", "docs/GATEWAY.md"]) {
  const s = rd(f);
  const stated = [...s.matchAll(/([\d.]+)\s*gwei\s*(?:\(10⁻[⁰¹²³⁴⁵⁶⁷⁸⁹]+ BNB\)\s*)?(?:per step|\/step)/g)].map((m) => Number(m[1]));
  for (const g of stated) check(`${f}: "${g} gwei per step" is the rate the gateway charges`, g === gwei, `blueprint says ${gwei} gwei`);
  if (!stated.length) console.log(`         ${f}: names no per-step rate`);
}

// the worked example must multiply: 195,000 steps x 2 providers at the rate = the BNB it claims
const tok = rd("docs/TOKENOMICS.md");
const row = /\|\s*its fee at [^|]*\|\s*([\d,]+) steps × (\d+) × 10⁻([⁰¹²³⁴⁵⁶⁷⁸⁹]+) = \*\*([\d.]+) BNB\*\*\s*\|/.exec(tok);
check("TOKENOMICS §9 still shows the battery's fee as a worked multiplication", !!row, "the row's shape changed");
if (row) {
  const sup = { "⁰": 0, "¹": 1, "²": 2, "³": 3, "⁴": 4, "⁵": 5, "⁶": 6, "⁷": 7, "⁸": 8, "⁹": 9 };
  const steps = Number(row[1].replace(/,/g, "")), red = Number(row[2]);
  const exp = [...row[3]].reduce((a, c) => a * 10 + sup[c], 0), claimed = Number(row[4]);
  const product = steps * red * 10 ** -exp;
  check(`  ${row[1]} × ${red} × 10⁻${exp} really is ${claimed} BNB`, Math.abs(product - claimed) < claimed * 1e-9, `it is ${product}`);
  check("  and 10⁻" + exp + " BNB is the rate the gateway charges", Math.abs(10 ** -exp - bnb) < bnb * 1e-9, `the gateway charges ${bnb} BNB`);
  check("  a battery is 39 runs × 5,000 steps", steps === 39 * 5000);
}
// the invariant §9 rests on: a mint must cover one battery at this rate
const mint = /`MINT_PRICE − MINT_BOND` = \*\*([\d.]+) BNB\*\*/.exec(tok);
if (mint && row) check(`a mint (${mint[1]}) still covers one battery (${row[4]}) — the invariant §9 argues from`, Number(mint[1]) >= Number(row[4]));

console.log(fails ? `${fails} FAILURES` : "fee rate units: all checks passed");
process.exit(fails ? 1 : 0);
