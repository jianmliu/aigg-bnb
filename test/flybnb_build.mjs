// docs/flybnb/build.mjs regenerates blocks of a paper that people also write in. The one thing it must never do is
// touch the prose: a block is replaced whole, everything outside the markers comes back byte for byte.
import { replaceBlock, pilotBlock, ackBlock, breedingBlock, associationBlock, atlasBlock, selectionBlock, maleBlock, maleInputs } from "../docs/flybnb/build.mjs";
import fs from "node:fs";
let fails = 0; const check = (n, ok) => { console.log((ok ? "  ok   " : "  FAIL ") + n); if (!ok) fails++; };
const doc = "prose above\n<!-- BEGIN GENERATED: x -->\nold\n<!-- END GENERATED: x -->\nprose below\n<!-- BEGIN GENERATED: y -->\n<!-- END GENERATED: y -->\n";
const out = replaceBlock(doc, "x", "new\nlines");
check("a block is replaced whole", out.includes("<!-- BEGIN GENERATED: x -->\nnew\nlines\n<!-- END GENERATED: x -->") && !out.includes("old"));
check("the prose and the other block are untouched", out.startsWith("prose above\n") && out.includes("\nprose below\n<!-- BEGIN GENERATED: y -->\n<!-- END GENERATED: y -->\n"));
check("regenerating is idempotent", replaceBlock(out, "x", "new\nlines") === out);
let threw = false; try { replaceBlock(doc, "missing", "z"); } catch { threw = true; } check("a missing block is an error, not a silent append", threw);
const h = { collection: "0xC0", chainId: 97, block: 12, readAt: "2026-09-18", totalSupply: 3, truncated: false, holders: [{ address: "0xA", tokens: [1, 3] }, { address: "0xB", tokens: [2] }] };
const a = ackBlock(h); check("the appendix names the collection, the block and every holder with their individuals", /block 12/.test(a) && /`0xA` \| #1 #3/.test(a) && /`0xB` \| #2/.test(a) && /2 holders, 3 individuals/.test(a));
check("with nothing read yet it says so instead of printing an empty table", /No holders source/.test(ackBlock(null)));
const c = { mean: 1, base_individual_mean: 2, sd_between_individual_means: 0.5, min_ind: 0, max_ind: 3, icc1: 0.8, icc_mean: 0.99 };
const p = pilotBlock({ individuals: 100, seeds: 10, phenotypes: { "DNge145": c }, gate: { runs_fully_silenced: 0.5, individuals_silenced_in_every_seed: 0.1, individuals_never_silenced: 0.2, direct_gate_synapses_base: [1, 2, 3, 4], direct_gate_synapses_founders_mean_sd: [100, 20], direct_gate_synapses_min_max: [60, 140], corr_leak_vs_direct_synapses: -0.2 }, genotype: { records_mean: 10, records_base: 11, synapses_mean: 100, synapses_base: 99, turnover_lost_mean: 3, turnover_gained_mean: 2 } });
check("the pilot block carries the design, the table and the gate numbers", /100 founders × 10 stimulus seeds/.test(p) && /\| DNge145 \| 1\.00 \| 2\.00 \|/.test(p) && /50% of runs/.test(p));
{ const b = JSON.parse(fs.readFileSync(new URL("../flybnb/results/breeding/heritability.json", import.meta.url))); const t = breedingBlock(b);
  check("the breeding block carries the design, the heritability distribution, the selection response and what else moved", /randomly mated offspring/.test(t) && /median 0\.\d\d/.test(t) && /Realised heritability 0\.\d\d/.test(t) && /false discovery rate/.test(t) && /\| DNge145 \| sound \|/.test(t));
  const paper = fs.readFileSync(new URL("../docs/flybnb/paper.md", import.meta.url), "utf8"), prop = fs.readFileSync(new URL("../docs/flybnb/proposal.md", import.meta.url), "utf8");
  check("the committed paper and proposal carry exactly the block the committed results generate", paper.includes(t) && prop.includes(t)); }
{ const as = JSON.parse(fs.readFileSync(new URL("../flybnb/results/association/association.json", import.meta.url))), at = JSON.parse(fs.readFileSync(new URL("../flybnb/results/atlas/robustness.json", import.meta.url)));
  const paper = fs.readFileSync(new URL("../docs/flybnb/paper.md", import.meta.url), "utf8");
  check("the association and atlas blocks in the committed paper are exactly what the committed results generate", paper.includes(associationBlock(as)) && paper.includes(atlasBlock(at)) && /median replication 0\.\d\d/.test(atlasBlock(at))); }
{ const u = new URL("../flybnb/results/selection/selection.json", import.meta.url), paper = fs.readFileSync(new URL("../docs/flybnb/paper.md", import.meta.url), "utf8");
  check("the selection block in the committed paper is what the committed results generate (or says it is still running)", fs.existsSync(u) ? paper.includes(selectionBlock(JSON.parse(fs.readFileSync(u)))) : /BEGIN GENERATED: selection -->\n_Running\._/.test(paper)); }
{ const paper = fs.readFileSync(new URL("../docs/flybnb/paper.md", import.meta.url), "utf8"), mi = maleInputs();
  check("the male section in the committed paper is what the committed male results generate, confound checks included", mi && paper.includes(maleBlock(...mi)) && /one ear still removes \d+% of the response/.test(maleBlock(...mi))); }
console.log(fails ? `${fails} FAILURES` : "flybnb build: all checks passed"); process.exit(fails ? 1 : 0);
