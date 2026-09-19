// The genesis set is a promise made once: its Merkle root goes into FlyCollection's constructor and nothing can be
// added afterwards. So the published file is checked the way a stranger would check it -- from the file and the pilot's
// results alone, no chain: it is what the generator writes, every individual is one the dataset measured, every proof
// opens to the root under the contract's own rule, and nothing else does.
import fs from "node:fs"; import path from "node:path"; import { fileURLToPath } from "node:url"; import { keccak256 } from "viem";
import { build, leafOf, verify } from "../flybnb/genesis/build_genesis.mjs";
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
let fails = 0; const check = (n, ok) => { console.log((ok ? "  ok   " : "  FAIL ") + n); if (!ok) fails++; };
const onDisk = fs.readFileSync(path.join(root, "flybnb/genesis/genesis-v1.json"), "utf8"); const g = JSON.parse(onDisk);
check("the file is exactly what the generator writes from the pilot's results", JSON.stringify(build(), null, 1) + "\n" === onDisk);
check(`${g.size} individuals, indexed 0..${g.size - 1} with no gaps`, g.individuals.length === g.size && g.individuals.every((x, i) => x.index === i));
check("each deltaHash is keccak256 of the recipe published beside it", g.individuals.every((x) => keccak256(x.recipe) === x.deltaHash));
check("no two individuals share a recipe", new Set(g.individuals.map((x) => x.deltaHash)).size === g.size);
check("every proof opens to the root under FlyCollection._verify's rule", g.individuals.every((x) => verify(x.proof, g.root, leafOf(x.index, x.sex, x.deltaHash))));
const x = g.individuals[57];
check("a different sex, index or delta under a real proof does not", !verify(x.proof, g.root, leafOf(x.index, 1, x.deltaHash)) && !verify(x.proof, g.root, leafOf(x.index + 1, x.sex, x.deltaHash)) && !verify(x.proof, g.root, leafOf(x.index, x.sex, keccak256("0x00"))));
check("every founder is female, as the brains are: breeding waits for the male base", g.sexes.female === g.size && g.sexes.male === 0 && g.individuals.every((i) => i.sex === 0));
const pilot = fs.readFileSync(path.join(root, "flybnb/results/pilot/runs.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
check("and every one of them is an individual the pilot ran", g.individuals.every((i) => { const r = pilot.find((p) => p.ind === i.pilotInd); return r && "0x" + r.geno.recipe_hex === i.recipe && r.rows.length > 0; }));
console.log(fails ? `${fails} FAILURES` : "genesis set: all checks passed"); process.exit(fails ? 1 : 0);
