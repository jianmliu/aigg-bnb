// Where an individual stands among the others, phenotype by phenotype.
//
// An individual's "rarity" here is not a trait a generator handed out at mint: it is a measurement, and until its runs
// exist there is nothing to say about it. That is the honest form of the question a breeder asks -- *did I get
// something unusual?* -- and the answer costs a battery (docs/TOKENOMICS.md §9: which is what the breeding fee pays for).
//
// This reads the runs the project has published and writes two files:
//   reference-v1.json    per phenotype, the FOUNDERS' distribution -- mean, sd and 21 quantiles, enough to place a
//                        value without shipping every founder's number
//   individuals-v1.json  per individual, keyed by the deltaHash its token carries: its value and percentile for every
//                        phenotype, and the handful where it stands out
// The page reads the second (frontend/src/core/phenotypes.js) and says "not measured yet" for anything not in it,
// which is the true answer for a fly bred five minutes ago.
//
//   node flybnb/analysis/phenotype_rank.mjs            -> writes both files
//   node flybnb/analysis/phenotype_rank.mjs --check    -> exit 1 if what is on disk is not what this would write
import fs from "node:fs"; import path from "node:path"; import { fileURLToPath } from "node:url";
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "../..");
const rd = (p) => JSON.parse(fs.readFileSync(path.join(root, p), "utf8"));
const lines = (p) => fs.readFileSync(path.join(root, p), "utf8").trim().split("\n").map((l) => JSON.parse(l));
const check = process.argv.includes("--check");

const battery = rd("flybnb/battery/battery-v1.json"); const genesis = rd("flybnb/genesis/genesis-v1.json");
const groups = rd("flybnb/analysis/groups_flywire783.json");
const dn = battery.readout.neuron_index, dpos = new Map(dn.map((i, k) => [i, k])), types = battery.readout.cell_type;

/** A run's readouts, whichever way it was recorded: the pilot stored named groups (phenotype_variance.py), the
 *  battery stores every descending neuron (dn_i, dn_c). Both are late-window spike counts of the same neurons, so the
 *  phenotypes below mean the same thing either way -- and one that only one of them carries is simply absent. */
const NAMED = [["DNge145", "DNge145"], ["giant fibre", "GF"], ["DNp12", "DNp12"]];
function readoutsOf(run) {
  if (run.dn_i) { const v = new Float64Array(dn.length); for (let k = 0; k < run.dn_i.length; k++) v[run.dn_i[k]] += run.dn_c[k];
    const g = {}; for (const [, grp] of NAMED) g[grp] = (groups[grp] || []).map((i) => dpos.get(i)).filter((k) => k !== undefined).reduce((a, k) => a + v[k], 0);
    return { ...g, total: run.total, active: run.active }; }
  const sum = (a) => (a || []).reduce((x, y) => x + y, 0);
  const g = { DNge145: sum(run.DNge145), GF: sum(run.GF), DNp12: sum(run.DNp12), total: run.total, active: run.active, late_total: run.late_total };
  (run.locked38 || []).forEach((c, k) => { g[`locked #${k}`] = c; });
  return g;
}
const STIM = (s) => (s === "joLR" ? "sound" : s === "joLR+gate" ? "sound_gate" : s); // the pilot's names for the battery's

/** the phenotypes of one individual: each readout, averaged over that stimulus's seeds, plus the gate contrast */
function phenotypesOf(runs) {
  const per = new Map(); // stimulus -> { key -> [sum, n] }
  for (const r of runs) { const s = STIM(r.stim); if (!per.has(s)) per.set(s, new Map()); const m = per.get(s);
    for (const [k, v] of Object.entries(readoutsOf(r))) { if (typeof v !== "number") continue; const e = m.get(k) || [0, 0]; m.set(k, [e[0] + v, e[1] + 1]); } }
  const out = {}; const label = { DNge145: "DNge145", GF: "giant fibre", DNp12: "DNp12", total: "spikes, all", active: "neurons reached", late_total: "spikes, late window" };
  for (const [s, m] of per) for (const [k, [sum, n]] of m) out[`${label[k] || k} | ${s}`] = sum / n;
  const a = out["DNge145 | sound"], b = out["DNge145 | sound_gate"];
  if (a !== undefined && b !== undefined) out["gate suppression of DNge145 (sound - sound_gate)"] = a - b;
  return out;
}

/** the founders' distribution of one phenotype: enough to place a value, not every number */
function distribution(values) {
  const v = values.slice().sort((a, b) => a - b); const n = v.length;
  const mean = v.reduce((a, b) => a + b, 0) / n; const sd = Math.sqrt(v.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, n - 1));
  const q = []; for (let i = 0; i <= 20; i++) { const x = (i / 20) * (n - 1); const lo = Math.floor(x), hi = Math.ceil(x); q.push(round(v[lo] + (v[hi] - v[lo]) * (x - lo))); }
  return { n, mean: round(mean), sd: round(sd), min: round(v[0]), max: round(v[n - 1]), quantiles: q };
}
const round = (x) => Math.round(x * 1e4) / 1e4;
/** where a value falls in that distribution, 0 to 100, by interpolating the quantiles */
export function percentileOf(d, x) {
  const q = d.quantiles; if (x <= q[0]) return 0; if (x >= q[q.length - 1]) return 100;
  for (let i = 1; i < q.length; i++) if (x <= q[i]) { const span = q[i] - q[i - 1]; const f = span === 0 ? 0 : (x - q[i - 1]) / span; return round(((i - 1 + f) / 20) * 100); }
  return 100;
}

// ---- the individuals: the collection's founders (measured in the pilot) and the breeding study's ----
const pilot = new Map(lines("flybnb/results/pilot/runs.jsonl").map((r) => [r.ind, r]));
const byDelta = new Map(); // deltaHash -> { source, id, runs }
for (const g of genesis.individuals) { const p = pilot.get(g.pilotInd); if (p) byDelta.set(g.deltaHash.toLowerCase(), { source: "pilot", id: `genesis #${g.index}`, token: g.index, runs: p.rows }); }
let bred = 0;
try { for (const r of lines("flybnb/results/breeding/rows.jsonl")) { const d = String(r.delta_id || "").toLowerCase();
  if (d && !byDelta.has(d)) { byDelta.set(d, { source: "breeding", id: r.id, kind: r.kind, line: r.line, parents: r.a && r.b ? [r.a, r.b] : null, runs: r.rows }); bred++; } } } catch {}

const pheno = new Map(); for (const [d, x] of byDelta) pheno.set(d, phenotypesOf(x.runs));
// the reference is the COLLECTION's founders: what an adopter can compare against, and what a bred fly is unusual with respect to
const founders = [...byDelta].filter(([, x]) => x.source === "pilot").map(([d]) => d);
const names = [...new Set(founders.flatMap((d) => Object.keys(pheno.get(d))))].sort();
const ref = {};
for (const name of names) {
  const vals = founders.map((d) => pheno.get(d)[name]).filter((v) => v !== undefined);
  if (vals.length < 20) continue; const d = distribution(vals); if (d.sd === 0) continue; // a phenotype every founder shares says nothing
  ref[name] = d;
}

const STANDOUT = 5; // a percentile at or beyond this far from the middle is worth a line on the page
const individuals = {};
for (const [d, x] of byDelta) {
  const p = pheno.get(d); const rows = [];
  for (const [name, dist] of Object.entries(ref)) { const v = p[name]; if (v === undefined) continue; rows.push({ name, value: round(v), percentile: percentileOf(dist, v) }); }
  const standout = rows.filter((r) => r.percentile <= STANDOUT || r.percentile >= 100 - STANDOUT).sort((a, b) => Math.abs(b.percentile - 50) - Math.abs(a.percentile - 50) || a.name.localeCompare(b.name));
  individuals[d] = { id: x.id, source: x.source, ...(x.token !== undefined ? { genesisIndex: x.token } : {}), ...(x.kind ? { kind: x.kind, line: x.line, parents: x.parents } : {}),
    phenotypes: rows.length, standout: standout.slice(0, 8) }; // the page wants what stands out; the whole table is the dataset's
}

const meta = { version: 1, note: "An individual's standing among the collection's hundred founders, phenotype by phenotype. Rarity here is measured, not assigned: a fly with no runs has no entry, which is the true answer until its battery is run.",
  reference: "the genesis founders, as measured in the pilot (flybnb/results/pilot/runs.jsonl)", battery: battery.name + " v" + battery.version, standout_percentile: STANDOUT };
const refFile = { ...meta, phenotypes: Object.keys(ref).length, distributions: ref };
const indFile = { ...meta, individuals: Object.keys(individuals).length, founders: founders.length, bred, byDeltaHash: individuals };

const write = (p, obj) => {
  const full = path.join(root, p), text = JSON.stringify(obj, null, 1) + "\n";
  if (check) { const on = fs.existsSync(full) ? fs.readFileSync(full, "utf8") : ""; if (on !== text) { console.error(`${p} is not what this would write`); process.exitCode = 1; } return; }
  fs.mkdirSync(path.dirname(full), { recursive: true }); fs.writeFileSync(full, text); console.log(`${p}: ${(text.length / 1024).toFixed(0)} kB`);
};
write("flybnb/results/phenotypes/reference-v1.json", refFile);
write("flybnb/results/phenotypes/individuals-v1.json", indFile);
console.log(`${Object.keys(ref).length} phenotypes over ${founders.length} founders${bred ? ` (+ ${bred} from the breeding study)` : ""}` + (check ? "; --check" : ""));
