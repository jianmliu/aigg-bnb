// Where an individual stands among the founders: the files flybnb/analysis/phenotype_rank.mjs writes, and the claims
// the page makes from them. No chain, no browser.
//   - the files on disk are what the tool would write now (so a run of the pilot or the breeding study cannot drift
//     away from what the page shows)
//   - the reference is the collection's hundred founders, and its DNge145 mean is the one the published breeding
//     design states -- the same quantity, computed here from the runs rather than copied
//   - every genesis individual has an entry: a founder is measured, which is what makes it a reference
//   - percentiles behave: inside 0..100, the extremes are where the standouts are, and a value below the founders'
//     minimum is the bottom of the distribution
//   - a delta hash nobody has run has no entry, which is what the page says "not measured yet" about
import fs from "node:fs"; import path from "node:path"; import { spawnSync } from "node:child_process"; import { fileURLToPath } from "node:url";
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const rd = (p) => JSON.parse(fs.readFileSync(path.join(root, p), "utf8"));
let fails = 0; const check = (n, ok, note = "") => { console.log((ok ? "  ok   " : "  FAIL ") + n + (ok || !note ? "" : "  " + note)); if (!ok) fails++; };

const r = spawnSync(process.execPath, [path.join(root, "flybnb/analysis/phenotype_rank.mjs"), "--check"], { encoding: "utf8" });
check("the published files are what phenotype_rank.mjs would write from the runs", r.status === 0, (r.stderr || r.stdout || "").trim().slice(0, 160));

const ref = rd("flybnb/results/phenotypes/reference-v1.json"), ind = rd("flybnb/results/phenotypes/individuals-v1.json");
const genesis = rd("flybnb/genesis/genesis-v1.json"), design = rd("flybnb/results/breeding/design.json");
const D = ref.distributions, I = ind.byDeltaHash;

check(`the reference is the ${ind.founders} founders of the collection, over ${ref.phenotypes} phenotypes`, ind.founders === genesis.size && ref.phenotypes > 50 && D["DNge145 | sound"]?.n === genesis.size);
{ const mine = D["DNge145 | sound"].mean, published = design.founder_mean;
  check(`and its DNge145 | sound mean is the published one (${mine} vs ${published})`, Math.abs(mine - published) < 0.01, design.trait); }
check("every genesis individual is in it: a founder is a measured thing", genesis.individuals.every((g) => I[g.deltaHash.toLowerCase()]?.source === "pilot"));
check(`bred individuals are there too, from the breeding study (${ind.bred})`, ind.bred > 100 && Object.values(I).some((x) => x.kind === "cross" && x.parents?.length === 2));

{ const all = Object.values(I).flatMap((x) => x.standout);
  check(`every percentile is a percentile, and every standout is at an end of the distribution (${all.length} of them)`,
    all.every((s) => s.percentile >= 0 && s.percentile <= 100) && all.every((s) => s.percentile <= ind.standout_percentile || s.percentile >= 100 - ind.standout_percentile));
  const some = Object.values(I).filter((x) => x.standout.length === 0);
  check(`and an individual that is nothing special has none (${some.length} of ${ind.individuals} are)`, some.length > 0 && some.length < ind.individuals); }

{ // the page's lookup: by the delta hash a token carries, and nothing for one nobody has run
  const g = genesis.individuals[0]; const mine = I[g.deltaHash.toLowerCase()];
  check(`a fly is found by the delta hash its token carries (${g.deltaHash.slice(0, 12)}… -> ${mine.id})`, mine.genesisIndex === g.index && mine.phenotypes > 50);
  check("a delta hash nobody has run has no entry -- which is what the page says 'not measured yet' about", !I["0x" + "ab".repeat(32)]); }

{ // the standing a reader is shown
  const { standing } = await import(path.join(root, "frontend/src/core/phenotypes.js"));
  check("a high percentile reads as the top of the founders, a low one as the bottom", standing(99).text === "top 1%" && standing(99).high === true && standing(0.8).text === "bottom 0.8%" && standing(2).high === false); }
console.log(fails ? `${fails} FAILURES` : "phenotypes: all checks passed"); process.exit(fails ? 1 : 0);
