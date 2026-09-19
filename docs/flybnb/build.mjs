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
const PROPOSAL = path.join(here, "proposal.md"), BREEDING = path.join(here, "..", "..", "flybnb", "results", "breeding", "heritability.json");
const ASSOC = path.join(here, "..", "..", "flybnb", "results", "association", "association.json"), ATLAS = path.join(here, "..", "..", "flybnb", "results", "atlas", "robustness.json");
const SELECTION = path.join(here, "..", "..", "flybnb", "results", "selection", "selection.json");
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

export function breedingBlock(b) {
  const n = b.individuals, d = b.h2_distribution, a = b.against_additive_expectation, s = b.selection, c = b.correlated_responses, P = b.phenotypes;
  const row = (k) => { const v = P[k]; return v ? `| ${k} | ${f(v.founder_mean)} ± ${f(v.founder_sd)} | ${v.h2 == null ? "n/a" : `${f(v.h2)} ± ${f(v.h2_se)}`} | ${f(v.high_line_mean)} | ${f(v.low_line_mean)} | ${v.divergence_in_founder_sd == null ? "n/a" : (v.divergence_in_founder_sd >= 0 ? "+" : "") + f(v.divergence_in_founder_sd)} |` : null; };
  const keys = ["DNge145 | sound", "DNge145 | sound_gate", "gate suppression of DNge145 (sound - sound_gate)", "giant fibre | sound", "DNp12 | sound", ...Object.keys(P).filter((k) => k.startsWith("descending spikes, all"))];
  return [
    `**Design.** ${n.founders} founders, ${n.random} randomly mated offspring, and ${n.high} + ${n.low} offspring of two divergent selection lines; every individual under the full battery (39 runs). ${d.n} phenotypes: named cell types, per-stimulus totals, and every descending cell type that is active in at least half of the founders.`,
    "",
    `**Phenotypes are transmitted.** The midparent regression slope, the narrow-sense heritability under this cross, has median ${f(d.median)} (quartiles ${f(d.q25)} to ${f(d.q75)}); ${Math.round(d["above_0.5"] * 100)}% of phenotypes are above 0.5. Against the additive expectation of 0.875 (slope ± 2 SE): ${a.clearly_below} phenotypes are clearly below it, ${a.consistent} are consistent with it, ${a.clearly_above} clearly above. So for about ${Math.round(100 * a.clearly_below / d.n)}% of phenotypes a measurable part lives in interactions between connections, which recombination breaks up.`,
    "",
    `**Selection works, in one generation.** Selected trait: ${s.trait} (founder mean ${f(s.founder_mean)}). The high line's parents were ${f(s.S_high)} above the mean and their offspring ${f(s.R_high)} above it; the low line's parents ${f(-s.S_low)} below and their offspring ${f(-s.R_low)} below. Realised heritability ${f(s.realised_h2_divergent)} (high ${f(s.realised_h2_high)}, low ${f(s.realised_h2_low)}); the midparent regression gives ${f(s.regression_h2)} ± ${f(P[s.trait].h2_se)}. The two lines end ${f(P[s.trait].divergence_in_founder_sd)} founder standard deviations apart.`,
    "",
    `**What else moved.** Of ${c.tested} phenotypes, ${c["q_below_0.05"]} differ between the two lines at a false discovery rate of 0.05, and ${c.of_which_not_DNge145} of those are not DNge145 phenotypes: ${c.largest_not_DNge145.slice(0, 6).map((x) => `${x.phenotype} (${x.high_minus_low_in_founder_sd >= 0 ? "+" : ""}${f(x.high_minus_low_in_founder_sd)} SD)`).join("; ")}. Selection on one response is mostly specific, and not entirely. The one trade-off that matters here is inside the selected circuit: the line bred for a strong response to sound also leaks more through the gate (DNge145 under \`sound_gate\`: ${f(P["DNge145 | sound_gate"].high_line_mean)} against ${f(P["DNge145 | sound_gate"].low_line_mean)}).`,
    "",
    "| phenotype | founder mean ± SD | h² (midparent slope ± SE) | high line | low line | high − low, in founder SDs |", "|---|---|---|---|---|---|", ...keys.map(row).filter(Boolean),
  ].join("\n");
}

export function associationBlock(x) {
  const s = x.summary, P = x.phenotypes, d = P.find((p) => p.readout === "DNge145" && p.stimulus === "sound"), g = P.find((p) => p.readout === "DNge145" && p.stimulus === "sound_gate");
  const ign = x.ignition.filter((i) => i.base_regime === "sparse" && i.ignites_on_average > 0).sort((a, b) => b.ignites_on_average - a.ignites_on_average);
  return [
    `**Design.** ${x.individuals} unrelated founders under the battery. Predictors are an individual's counts on a stimulus's candidate connections: base records whose two ends are both active under it. ${s.phenotypes} phenotypes (a descending cell type under a stimulus), for the stimuli under which nobody ignites.`,
    "",
    `**A phenotype in the sparse regime is its readout's direct inputs.** Cross-validated R² from the connections *into* the readout cells: median ${f(s.median_r2_direct)}${d ? ` (DNge145 under sound: ${f(d.r2_direct)})` : ""}. From the rest of the active network *without* them: median ${f(s.median_r2_without_direct)}, i.e. nothing. A model over all candidates (the 200 most correlated, chosen inside each training fold) does not beat the direct inputs alone (median ${f(s.median_r2_all)}). ${Math.round(100 * s.share_of_significant_that_are_direct)}% of the connections significant at FDR 0.05 are direct inputs of the readout.`,
    "",
    g ? `**The gate, revisited.** The variance pilot found that the four direct gate connections do not explain who leaks (r = −0.27). Those were four of DNge145's direct inputs. All of them together, the auditory excitation and the gate's inhibition, give R² ${f(g.r2_direct)} for DNge145 under the gate: what decides the leak is the balance of one cell's inputs, not the network.` : "",
    "",
    `**Ignition is an individual phenotype.** Under stimuli that leave the base wiring sparse, some individuals tip into the high-activity state: ${ign.map((i) => `${i.stimulus} ${Math.round(100 * i.ignites_on_average)}%`).join(", ")}. For those stimuli the candidate set is the whole ignited network and a connection-level question is the wrong one; they are reported here and not analysed.`,
  ].join("\n");
}
export function atlasBlock(x) {
  const c = x.replication_central, w = x.what_predicts_replication || {}, top = x.effects.filter((e) => !e.silenced_is_stimulated).slice(0, 8);
  return [
    `**Design.** Stimulus \`sound\`; the base wiring and ${x.individuals} founders; for every individual and seed, the unperturbed run and one run per cell type with an active neuron, silenced. A study of one brain *detects* an effect when ${x.detection_rule}. The rule is applied to the base wiring, and then unchanged to every individual: an effect's **replication rate** is the fraction of individuals in which the same study would have reported it.`,
    "",
    `**Most effects found on one brain are not found on another.** ${x.effects_detected_on_base} effects are detected on the base wiring, ${x.of_which_silencing_part_of_the_stimulus} of them by silencing part of the stimulus. Of the other ${c.n}: median replication ${f(c.median)}; ${Math.round(100 * c["at_least_0.8"])}% replicate in at least 80% of individuals and ${Math.round(100 * c["at_most_0.2"])}% in at most 20%. ${x.missed_by_the_base.n} effects are detected in at least half of the individuals and *not* on the base.`,
    "",
    ...(x.any_individual_as_the_brain_studied ? [((q) => `**The base wiring has no special place in this.** Take any individual as the one brain studied instead: it shows ${Math.round(q.effects_per_individual_median)} central effects (range ${q.effects_per_individual_range[0]}–${q.effects_per_individual_range[1]}), and an effect found in one individual is found in another with probability ${f(q.replication_in_another_individual.mean)} (${Math.round(100 * q.replication_in_another_individual["at_most_0.2"])}% of effects in at most 20% of the others). Part of any such shortfall is selection, since an effect is chosen for having been detected on the brain studied; that is the situation of every single-brain study, and it is what the number measures.`)(x.any_individual_as_the_brain_studied), ""] : []),
    "| size of the effect on the base (spikes) | effects | median replication | median same sign | replicate in ≥ 80% |", "|---|---|---|---|---|",
    ...x.replication_by_base_effect.map((b) => `| ${b.abs_effect} | ${b.n} | ${f(b.median_replication)} | ${f(b.median_same_sign)} | ${Math.round(100 * b.replicate_in_80pct)}% |`),
    "",
    `**What predicts replication.** The size of the effect on the base (Spearman ${f(w.abs_base_effect)}) and the synapses of a direct connection from the silenced type to the readout (${f(w.direct_synapses)}). Effects with a direct connection replicate at ${f(w.replication_with_direct)} on average, those without at ${f(w.replication_without_direct)}.`,
    "",
    "| silenced | readout | effect on the base | replication | same sign | mean ± SD over individuals |", "|---|---|---|---|---|---|",
    ...top.map((e) => `| ${e.silenced} | ${e.readout} | ${e.base_effect >= 0 ? "+" : ""}${f(e.base_effect, 1)} | ${f(e.replication)} | ${f(e.same_sign)} | ${e.individual_mean >= 0 ? "+" : ""}${f(e.individual_mean, 1)} ± ${f(e.individual_sd, 1)} |`),
  ].join("\n");
}

export function selectionBlock(x) {
  const G = x.generations, F = x.founders, by = (g, line) => x.by_generation.filter((r) => r.gen === g && r.line === line), mean = (rows, k) => rows.reduce((a, r) => a + r[k], 0) / rows.length, lg = x.last_generation;
  const row = (g) => { const h = by(g, "high"), l = by(g, "low"), c = by(g, "control"); return `| ${g} | ${h.map((r) => sgn(r.trait_in_founder_sd)).join(", ")} | ${l.map((r) => sgn(r.trait_in_founder_sd)).join(", ")} | ${c.map((r) => sgn(r.trait_in_founder_sd)).join(", ")} | ${f(mean(h, "leak_mean"), 1)} | ${f(mean(l, "leak_mean"), 1)} | ${f(mean(c, "leak_mean"), 1)} | ${Math.round(100 * mean(l, "silenced_fraction"))}% |`; };
  const sgn = (v) => (v >= 0 ? "+" : "") + f(v), gens = Array.from({ length: G }, (_, i) => i + 1), hi = (g) => mean(by(g, "high"), "trait_in_founder_sd"), lo = (g) => mean(by(g, "low"), "trait_in_founder_sd"), ct = (g) => mean(by(g, "control"), "trait_in_founder_sd");
  const half = Math.max(1, Math.floor(G / 2)), dHi1 = hi(half), dHi2 = hi(G) - hi(half), dLo1 = -lo(half), dLo2 = -(lo(G) - lo(half)), floor = -F.trait_mean / F.trait_sd, ctlMax = Math.max(...x.by_generation.filter((r) => r.line === "control").map((r) => Math.abs(r.trait_in_founder_sd)));
  return [
    `**Design.** Trait: DNge145 spikes under \`sound\` (founders ${f(F.trait_mean, 1)} ± ${f(F.trait_sd, 1)}). Six lines from the same 100 founders: two selected up, two down, two controls with parents drawn at random; ${G} generations of 40 offspring from 10 parents, every individual under the full battery.`,
    "",
    "| generation | high lines (founder SD) | low lines | control lines | gate leak, high | low | control | low lines fully silenced by the gate |", "|---|---|---|---|---|---|---|---|", ...gens.map(row),
    "",
    `**The response.** After ${G} generations the high lines are at ${sgn(hi(G))} founder SD and the low lines at ${sgn(lo(G))}, ${f(hi(G) - lo(G), 1)} SD apart; the control lines never left ±${f(ctlMax)}. Upwards the response ${dHi2 > 0.5 * dHi1 ? "continues" : "slows"}: ${sgn(dHi1)} SD in generations 1–${half}, ${sgn(dHi2)} in generations ${half + 1}–${G}. Downwards it ${dLo2 < 0.34 * dLo1 ? "stops" : "continues"}: ${f(dLo1)} then ${f(dLo2)}${lo(G) - floor < 0.5 ? `, and the reason is arithmetic before it is genetics: a spike count cannot go below zero, which for this trait is ${f(floor)} founder SD, and the low lines are ${f(lo(G) - floor)} SD above it` : ` (the floor of the trait, zero spikes, is at ${f(floor)} founder SD)`}.`,
    "",
    `**The cost inside the circuit${mean(by(G, "high"), "leak_mean") > 1.15 * mean(by(half, "high"), "leak_mean") ? " accumulates" : ""}.** The high lines' response with the gate neurons driven went from the founders' ${f(F.leak_mean, 1)} spikes to ${f(mean(by(G, "high"), "leak_mean"), 1)}; the low lines' to ${f(mean(by(G, "low"), "leak_mean"), 1)}, with ${Math.round(100 * mean(by(G, "low"), "silenced_fraction"))}% of their individuals fully silenced by the gate against ${Math.round(100 * mean(by(G, "control"), "silenced_fraction"))}% in the controls. What the gate takes away grows much less than the response does: ${f(mean(by(1, "high"), "suppression_mean"), 1)} spikes of ${f(mean(by(1, "high"), "trait_mean"), 1)} in the high lines at generation 1 (${Math.round(100 * mean(by(1, "high"), "suppression_mean") / mean(by(1, "high"), "trait_mean"))}%), ${f(mean(by(G, "high"), "suppression_mean"), 1)} of ${f(mean(by(G, "high"), "trait_mean"), 1)} at generation ${G} (${Math.round(100 * mean(by(G, "high"), "suppression_mean") / mean(by(G, "high"), "trait_mean"))}%). The gate behaves more like a subtraction than like a division, so selection on the response to sound alone outgrows it.`,
    "",
    `**Other phenotypes, and how not to count them.** Tested individual by individual, ${lg.moved_by_selection_q05} of ${lg.phenotypes} battery phenotypes differ between high and low lines at FDR 0.05. That test treats relatives as independent, and the control lines show what that is worth: by the same test ${lg.moved_in_controls_q05} phenotypes differ between the unselected control lines and the founders. With the line as the unit — both high lines on one side of both low lines, and a gap larger than the 99th percentile (${f(lg.replicate_gap_p99_sd)} SD) of the gap between two lines of the *same* treatment — ${lg.moved_at_line_level} remain, ${lg.moved_at_line_level_not_DNge145} of them not DNge145${lg.line_level_not_DNge145.length ? ": " + lg.line_level_not_DNge145.slice(0, 5).map((r) => `${r.phenotype.replace(" | ", " under ")} (${r.course_high_minus_low_sd.map(sgn).join(", ")} by generation)`).join("; ") : ""}. Both replicates of a treatment start from the same ten founders, so a gap that is present at generation 1 and does not grow is what those founders carried; one that grows with the trait is a correlated response.`,
  ].join("\n");
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
  const br = fs.existsSync(BREEDING) ? JSON.parse(fs.readFileSync(BREEDING, "utf8")) : null; const brText = br ? breedingBlock(br) : "_The breeding pilot has not been analysed yet._";
  let text = fs.readFileSync(PAPER, "utf8");
  text = replaceBlock(text, "pilot", v ? pilotBlock(v) : "_The pilot has not been analysed yet._");
  text = replaceBlock(text, "acknowledgments", ackBlock(h));
  const as = fs.existsSync(ASSOC) ? JSON.parse(fs.readFileSync(ASSOC, "utf8")) : null, at = fs.existsSync(ATLAS) ? JSON.parse(fs.readFileSync(ATLAS, "utf8")) : null;
  const sel = fs.existsSync(SELECTION) ? JSON.parse(fs.readFileSync(SELECTION, "utf8")) : null;
  text = replaceBlock(text, "status", ["| part | state |", "|---|---|", `| pilot (Section 3) | ${v ? `${v.individuals} founders × ${v.seeds} seeds, analysed` : "pending"} |`, `| breeding pilot (Section 3a) | ${br ? `${br.individuals.founders} founders, ${br.individuals.random + br.individuals.high + br.individuals.low} offspring, ${br.h2_distribution.n} phenotypes` : "pending"} |`, "| standard battery | v1: 13 stimuli × 3 seeds, 1,303 descending neurons read out |", `| association analysis (Section 3b) | ${as ? `${as.individuals} unrelated founders, ${as.summary.phenotypes} phenotypes` : "pending"} |`, `| atlas, first slice (Section 3c) | ${at ? `silencing under sound, ${at.individuals} individuals, ${at.effects_detected_on_base} effects on the base` : "pending"} |`, `| multi-generation selection (Section 3d) | ${sel ? `${sel.generations} generations, six lines` : "running"} |`, "| the rest of the silencing atlas, the activation atlas, the male brain | planned |", "| dataset on the Hugging Face Hub | prepared, not public |", `| acknowledgments (Appendix A) | ${h ? `${h.holders.length} holder(s) at block ${h.block} on chain ${h.chainId}` : "no deployment read yet"} |`].join("\n"));
  text = replaceBlock(text, "breeding", brText);
  text = replaceBlock(text, "selection", sel ? selectionBlock(sel) : "_Running._");
  text = replaceBlock(text, "association", as ? associationBlock(as) : "_Not analysed yet._"); text = replaceBlock(text, "atlas", at ? atlasBlock(at) : "_Not run yet._");
  if (fs.existsSync(PROPOSAL)) fs.writeFileSync(PROPOSAL, replaceBlock(fs.readFileSync(PROPOSAL, "utf8"), "breeding", brText)); // the proposal carries the same block
  fs.writeFileSync(PAPER, text); console.log(`paper.md regenerated: pilot ${v ? "yes" : "no"}, holders ${h ? h.holders.length : "none"}`);
}
