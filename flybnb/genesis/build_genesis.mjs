// The genesis set of the collection: the pilot's founders, as the Merkle tree FlyCollection commits to at deployment.
//
// A genesis individual is (index, sex, deltaHash). `deltaHash` is keccak256 of its recipe -- the FLYDELTAv3 bytes the
// pilot ran it from (flybnb/results/pilot/runs.jsonl), 231 bytes that rebuild the whole brain from the base -- so the
// individuals that can be adopted are exactly the individuals the dataset has measured, and anybody can check that
// from this file alone. The leaf is keccak256(abi.encode(uint32 index, uint8 sex, bytes32 deltaHash)) and the tree
// hashes SORTED pairs, which is what FlyCollection._verify recomputes; an odd node is carried up unchanged.
//
// Sex is what the brain is, not a label to make breeding work: every founder is a variant of the FlyWire FEMALE base,
// so every founder is female. Breeding needs one of each sex and waits for individuals of the male base.
//
//   node flybnb/genesis/build_genesis.mjs            -> flybnb/genesis/genesis-v1.json
//   node flybnb/genesis/build_genesis.mjs --check    -> exit 1 if the file on disk is not what this would write
import fs from "node:fs"; import path from "node:path"; import { fileURLToPath } from "node:url";
import { keccak256, encodeAbiParameters, encodePacked } from "viem";
const here = path.dirname(fileURLToPath(import.meta.url)); const root = path.join(here, "../..");
const { decodeDelta3, isDelta3 } = await import(path.join(root, "contracts/lib/aigg-porw/web/porw-browser/delta.js"));
const hex = (b) => "0x" + Buffer.from(b).toString("hex"); const FEMALE = 0;

export const leafOf = (index, sex, deltaHash) => keccak256(encodeAbiParameters([{ type: "uint32" }, { type: "uint8" }, { type: "bytes32" }], [index, sex, deltaHash]));
const pair = (a, b) => keccak256(encodePacked(["bytes32", "bytes32"], BigInt(a) < BigInt(b) ? [a, b] : [b, a]));
/** levels[0] = leaves ... levels[n] = [root]; an odd node goes up as it is */
export function tree(leaves) { const levels = [leaves]; while (levels.at(-1).length > 1) { const cur = levels.at(-1), up = []; for (let i = 0; i < cur.length; i += 2) up.push(i + 1 < cur.length ? pair(cur[i], cur[i + 1]) : cur[i]); levels.push(up); } return levels; }
export function proofFor(levels, i) { const p = []; for (let l = 0; l < levels.length - 1; l++) { const sib = i ^ 1; if (sib < levels[l].length) p.push(levels[l][sib]); i >>= 1; } return p; }
/** FlyCollection._verify, in JS */
export const verify = (proof, rootHash, leaf) => proof.reduce((h, p) => pair(h, p), leaf) === rootHash;

export function build() {
  const rows = fs.readFileSync(path.join(root, "flybnb/results/pilot/runs.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const founders = rows.filter((r) => r.ind !== 0).sort((a, b) => a.ind - b.ind); // ind 0 is the published base itself
  const entries = founders.map((r, index) => {
    if (!r.geno || !/^[0-9a-f]+$/.test(r.geno.recipe_hex || "")) throw new Error(`individual ${r.ind}: no recipe`); const recipeHex = "0x" + r.geno.recipe_hex;
    const bytes = Buffer.from(recipeHex.slice(2), "hex"); if (!isDelta3(bytes)) throw new Error(`individual ${r.ind}: not a FLYDELTAv3 recipe`);
    const d = decodeDelta3(bytes);
    return { index, pilotInd: r.ind, sex: FEMALE, deltaHash: keccak256(recipeHex), baseModelId: hex(d.baseModelId), recipe: recipeHex };
  });
  const bases = new Set(entries.map((e) => e.baseModelId)); if (bases.size !== 1) throw new Error("the founders do not share one base: " + [...bases].join(", "));
  if (new Set(entries.map((e) => e.deltaHash)).size !== entries.length) throw new Error("two founders share a recipe");
  const levels = tree(entries.map((e) => leafOf(e.index, e.sex, e.deltaHash)));
  return { version: 1, note: "FlyCollection genesis set: the FlyBnB pilot's founders. leaf = keccak256(abi.encode(uint32 index, uint8 sex, bytes32 deltaHash)); sorted-pair Merkle tree; sex 0 = female.",
    source: "flybnb/results/pilot/runs.jsonl", size: entries.length, root: levels.at(-1)[0], baseModelId: [...bases][0], sexes: { female: entries.length, male: 0 },
    individuals: entries.map((e, i) => ({ index: e.index, pilotInd: e.pilotInd, sex: e.sex, deltaHash: e.deltaHash, recipe: e.recipe, proof: proofFor(levels, i) })) };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const out = path.join(here, "genesis-v1.json"); const text = JSON.stringify(build(), null, 1) + "\n";
  if (process.argv.includes("--check")) { const same = fs.existsSync(out) && fs.readFileSync(out, "utf8") === text; console.log(same ? "genesis-v1.json is up to date" : "genesis-v1.json is STALE"); process.exit(same ? 0 : 1); }
  fs.writeFileSync(out, text); const g = JSON.parse(text); console.log(`wrote ${path.relative(root, out)}: ${g.size} individuals, root ${g.root}, base ${g.baseModelId}`);
}
