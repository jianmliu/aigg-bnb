// Regenerate the generated blocks of docs/flybnb/paper.md. Prose is never touched; a block is replaced whole.
//
//   node docs/flybnb/build.mjs [--results path/to/variance.json] [--relayer http://host:8788 | --rpc URL --collection 0x…]
//
//   --results     copy an analysis output into docs/flybnb/results/variance.json first (flybnb/results/pilot/variance.json)
//   --relayer     read the holders from a relayer's /flybnb/holders
//   --rpc/--collection   or straight from the chain, with nobody in between
// Without a holders source the acknowledgments block keeps the list it has and says when it was read.
import fs from "node:fs"; import path from "node:path"; import { fileURLToPath } from "node:url";
const here = path.dirname(fileURLToPath(import.meta.url)); const arg = (k) => { const i = process.argv.indexOf(k); return i < 0 ? null : process.argv[i + 1]; };
const PAPER = path.join(here, "paper.md"), RESULTS = path.join(here, "results", "variance.json"), HOLDERS = path.join(here, "results", "holders.json");

export function replaceBlock(text, name, body) {
  const a = `<!-- BEGIN GENERATED: ${name} -->`, b = `<!-- END GENERATED: ${name} -->`; const i = text.indexOf(a), j = text.indexOf(b);
  if (i < 0 || j < i) throw new Error(`paper.md has no generated block "${name}"`);
  return text.slice(0, i + a.length) + "\n" + body.trim() + "\n" + text.slice(j);
}
const f = (x, d = 2) => (x == null ? "" : Number(x).toFixed(d)); const pct = (x) => `${Math.round(x * 100)}%`;

export function pilotBlock(v) {
  const rows = Object.entries(v.phenotypes).map(([name, c]) => `| ${name} | ${f(c.mean)} | ${f(c.base_individual_mean)} | ${f(c.sd_between_individual_means)} | ${f(c.min_ind, 1)} to ${f(c.max_ind, 1)} | ${f(c.icc1)} | ${f(c.icc_mean)} |`);
  const g = v.gate, n = v.genotype; const ph = Object.entries(v.phenotypes); const byIcc = [...ph].sort((a, b) => a[1].icc1 - b[1].icc1);
  const lo = [byIcc[0][0], byIcc[0][1].icc1], hi = [byIcc.at(-1)[0], byIcc.at(-1)[1].icc1]; const strong = ph.filter(([, c]) => c.icc1 >= 0.6).length;
  return [
    `**Design.** ${v.individuals} founders × ${v.seeds} stimulus seeds × 2 stimuli, 5,000 steps each (${v.individuals * v.seeds * 2} runs, plus the base wiring).`,
    "",
    `**Wiring.** A founder keeps ${Math.round(n.records_mean).toLocaleString("en-US")} connections of five synapses or more (base: ${n.records_base.toLocaleString("en-US")}) and ${Math.round(n.synapses_mean).toLocaleString("en-US")} synapses (base: ${n.synapses_base.toLocaleString("en-US")}). About ${Math.round(n.turnover_lost_mean).toLocaleString("en-US")} base connections fall below the threshold and ${Math.round(n.turnover_gained_mean).toLocaleString("en-US")} rise above it: the totals are stationary, the membership is not.`,
    "",
    "| phenotype (spikes in the last 250 ms unless stated) | mean over founders | base wiring | SD between individuals | range of individual means | ICC, one assay | ICC, mean over seeds |",
    "|---|---|---|---|---|---|---|",
    ...rows,
    "",
    `**Reading.** The intraclass correlation of a single half-second assay runs from ${f(lo[1])} (${lo[0]}) to ${f(hi[1])} (${hi[0]}); ${strong} of ${ph.length} phenotypes are at 0.6 or above, and averaged over the seeds every phenotype is at ${f(Math.min(...ph.map(([, c]) => c.icc_mean)))} or above. Where the ICC is high, an individual's phenotype is a property of its wiring that one run measures; the numbers say which readouts that is true of, and it is not true of all of them to the same degree.`,
    "",
    `**The gate.** The published result on the base wiring is that the gate silences DNge145. Across founders the gate reduces DNge145 on average, but complete silencing is not the rule: ${pct(g.runs_fully_silenced)} of runs are fully silenced, ${pct(g.individuals_silenced_in_every_seed)} of individuals are silenced under every seed, and ${pct(g.individuals_never_silenced)} are never fully silenced. The four direct gate connections carry ${g.direct_gate_synapses_base.join(", ")} synapses in the base and sum to ${f(g.direct_gate_synapses_founders_mean_sd[0], 0)} ± ${f(g.direct_gate_synapses_founders_mean_sd[1], 0)} across founders (${f(g.direct_gate_synapses_min_max[0], 0)} to ${f(g.direct_gate_synapses_min_max[1], 0)}); ${g.corr_leak_vs_direct_synapses == null ? "" : `the correlation between that sum and the residual DNge145 activity under the gate is ${f(g.corr_leak_vs_direct_synapses)}, so the direct connections alone do not explain who leaks.`}`,
  ].join("\n");
}
export function ackBlock(h) {
  if (!h) return "_No holders source has been read yet. Run `node docs/flybnb/build.mjs --relayer <url>` or `--rpc <url> --collection <address>` against a deployment._";
  const head = `Collection \`${h.collection}\` on chain ${h.chainId}, read at block ${h.block} (${h.readAt}). ${h.holders.length} holder${h.holders.length === 1 ? "" : "s"}, ${h.totalSupply} individual${h.totalSupply === 1 ? "" : "s"}${h.truncated ? " (list truncated)" : ""}.`;
  return [head, "", "| holder | individuals |", "|---|---|", ...h.holders.map((x) => `| \`${x.address}\` | ${x.tokens.map((t) => "#" + t).join(" ")} |`)].join("\n");
}

async function holdersFromChain(rpc, collection) {
  const { createPublicClient, http, parseAbi } = await import("viem");
  const abi = parseAbi(["function totalSupply() view returns (uint256)", "function ownerOf(uint256) view returns (address)"]);
  const pub = createPublicClient({ transport: http(rpc) }); const [block, chainId] = await Promise.all([pub.getBlockNumber(), pub.getChainId()]);
  const n = Number(await pub.readContract({ address: collection, abi, functionName: "totalSupply", blockNumber: block })); const by = new Map();
  for (let id = 1; id <= n; id++) { const o = await pub.readContract({ address: collection, abi, functionName: "ownerOf", args: [BigInt(id)], blockNumber: block }); if (!by.has(o)) by.set(o, []); by.get(o).push(id); }
  const holders = [...by].map(([address, tokens]) => ({ address, tokens })).sort((a, b) => b.tokens.length - a.tokens.length || a.tokens[0] - b.tokens[0]);
  return { collection, chainId, block: Number(block), totalSupply: n, truncated: false, holders };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  if (arg("--results")) { fs.mkdirSync(path.dirname(RESULTS), { recursive: true }); fs.copyFileSync(arg("--results"), RESULTS); }
  let h = fs.existsSync(HOLDERS) ? JSON.parse(fs.readFileSync(HOLDERS, "utf8")) : null;
  const fresh = arg("--relayer") ? await (await fetch(arg("--relayer").replace(/\/$/, "") + "/flybnb/holders")).json() : arg("--rpc") ? await holdersFromChain(arg("--rpc"), arg("--collection")) : null;
  if (fresh) { if (fresh.error) throw new Error(fresh.error); const { tokens, ...keep } = fresh; h = { ...keep, readAt: new Date().toISOString().slice(0, 10) }; fs.writeFileSync(HOLDERS, JSON.stringify(h, null, 1) + "\n"); }
  const v = fs.existsSync(RESULTS) ? JSON.parse(fs.readFileSync(RESULTS, "utf8")) : null;
  let text = fs.readFileSync(PAPER, "utf8");
  text = replaceBlock(text, "pilot", v ? pilotBlock(v) : "_The pilot has not been analysed yet._");
  text = replaceBlock(text, "acknowledgments", ackBlock(h));
  text = replaceBlock(text, "status", ["| part | state |", "|---|---|", `| pilot (Section 3) | ${v ? `${v.individuals} founders × ${v.seeds} seeds, analysed` : "pending"} |`, "| silencing and activation atlas | planned |", "| dataset on the Hugging Face Hub | prepared, not public |", `| acknowledgments (Appendix A) | ${h ? `${h.holders.length} holder(s) at block ${h.block} on chain ${h.chainId}` : "no deployment read yet"} |`].join("\n"));
  fs.writeFileSync(PAPER, text); console.log(`paper.md regenerated: pilot ${v ? "yes" : "no"}, holders ${h ? h.holders.length : "none"}`);
}
