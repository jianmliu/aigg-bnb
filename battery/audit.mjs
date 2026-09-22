// A sampled audit of settled battery results against a SECOND implementation.
//
// Every production check on a battery runs the same WASM kernel: both hosts of a synchronous task, and the "independent
// replay" in worker.mjs archive(), which calls node.execute on the same PorwNode. That catches a host that lies. It
// cannot catch a bug every copy of the kernel shares -- they all agree on the wrong answer. This takes the artifacts
// worker.mjs archives, draws a sample, rebuilds each sampled payload from content addresses and runs the battery with
// flybnb/analysis/intlif.py (numpy, written separately), then joins the two run by run: every (stimulus, seed) whose
// counts digest differs is named, with both digests. Offline and deterministic; it reads no chain and writes none.
//
//   node battery/audit.mjs --battery flybnb/battery/battery-male-v1.json --archives <BATTERY_STATE>/artifacts \
//        --base malecns-v1.0-min2.bin [--base ...] [--recipes DIR] [--fetch --cache DIR] [--rate 0.1] [--salt S] \
//        [--all] [--workers 4] [--python python3] [--out audit.json]
//
// Sampling is by hash, not by position: a result is drawn iff keccak256(salt || taskId) < rate * 2^256. So a result's
// fate does not depend on which other results are in the directory, a rerun draws the same ones, and a second audit
// with another salt draws an independent sample. Anyone running the kernel does not know an auditor's salt in advance;
// for a sample nobody could have steered, take the salt from something fixed after the results were delivered.
//
// Exit status 0 only when every sampled result was rebuilt and all of its runs agree. A result whose payload cannot
// be rebuilt (missing base or recipe, a model_id that does not match, another battery version) fails the audit: it is
// reported, never skipped.
import fs from "node:fs"; import os from "node:os"; import path from "node:path"; import { spawnSync } from "node:child_process"; import { fileURLToPath } from "node:url";
import { keccak256, concat, toBytes, hexToBytes } from "viem";
import { rowOf } from "../flybnb/battery/battery_batch.mjs";
import { checkAgainstOffline } from "../flybnb/battery/post_battery.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const DEFAULT_RATE = 0.1, DEFAULT_SALT = "flybnb-battery-audit-v1";

/** worker.mjs artifacts as they are; a post_battery.mjs attestation file ({attestation: {rows}}) is read the same way */
export function loadArchive(obj, source = null) {
  const a = obj.attestation && !obj.rows ? { ...obj, ...obj.attestation, rows: obj.attestation.rows } : obj;
  if (!Array.isArray(a.rows) || !a.taskId) throw Error(`${source || "archive"}: not a battery result (no taskId or rows)`);
  return { ...a, source };
}
export function readArchives(paths) {
  const files = paths.flatMap((p) => fs.statSync(p).isDirectory() ? fs.readdirSync(p).filter((f) => f.endsWith(".json")).sort().map((f) => path.join(p, f)) : [p]);
  return files.map((f) => loadArchive(JSON.parse(fs.readFileSync(f, "utf8")), f));
}

/** whether a result is in the sample: a per-result coin that only the salt and its task id decide */
export function drawn(taskId, { rate = DEFAULT_RATE, salt = DEFAULT_SALT } = {}) {
  if (!(rate >= 0 && rate <= 1)) throw Error("rate must be in [0, 1]");
  if (rate === 1) return true;
  const h = BigInt(keccak256(concat([toBytes(salt), hexToBytes(taskId)])));
  return h < (BigInt(Math.floor(rate * 2 ** 32)) << 224n);
}
export const selectSample = (archives, opts = {}) => archives.filter((a) => opts.all || drawn(a.taskId, opts));

/**
 * Join an archived result with the numpy reference, run by run. The digest comparison is post_battery's
 * checkAgainstOffline; on top of it, what an archive could otherwise get past a join that only walks its own rows:
 * a run missing, a run twice, a run the battery does not have, and runs out of the battery's order (a batch's roots are
 * over runs IN ORDER, so row k must be run k).
 */
export function joinRuns(archive, reference, battery) {
  const rows = archive.rows.map((r, k) => ({ ...r, run: r.run ?? k }));
  const j = checkAgainstOffline({ rows }, reference, battery), key = (s, seed) => s + "|" + seed;
  const expected = Array.from({ length: battery.stimuli.length * battery.seeds.length }, (_, k) => rowOf(battery, k));
  const want = new Set(expected.map((w) => key(w.stimulus, w.seed))), seen = new Map();
  for (const r of rows) seen.set(key(r.stimulus, r.seed), (seen.get(key(r.stimulus, r.seed)) || 0) + 1);
  const missing = expected.filter((w) => !seen.has(key(w.stimulus, w.seed)));
  const duplicated = [...seen].filter(([k, n]) => n > 1 && want.has(k)).map(([k, n]) => ({ run: k, times: n }));
  const unexpected = rows.filter((r) => !want.has(key(r.stimulus, r.seed))).map((r) => ({ run: r.run, stimulus: r.stimulus, seed: r.seed }));
  const misordered = rows.flatMap((r, k) => k < expected.length && (r.stimulus !== expected[k].stimulus || r.seed !== expected[k].seed) ? [{ row: k, stimulus: r.stimulus, seed: r.seed, expected: expected[k] }] : []);
  const mismatches = j.mismatches.filter((m) => want.has(key(m.stimulus, m.seed))).map((m) => ({ run: m.run, stimulus: m.stimulus, seed: m.seed, archived: m.network, numpy: m.offline }));
  const ok = mismatches.length === 0 && !missing.length && !duplicated.length && !unexpected.length && !misordered.length && rows.length === expected.length;
  return { runs: rows.length, expected: expected.length, matched: j.matched, mismatches, missing, duplicated, unexpected, misordered, ok };
}

/** audit already-computed references: `reference(archive)` -> the numpy row ({rows: [{stim, seed, digest}]}) or {error} */
export async function audit(archives, battery, reference, opts = {}) {
  const sample = selectSample(archives, opts), results = [];
  for (const a of sample) {
    const id = { source: a.source, taskId: a.taskId, tokenId: a.tokenId ?? null, job: a.job ?? null, modelId: a.modelId ?? null };
    const ref = await reference(a);
    if (!ref || ref.error) { results.push({ ...id, status: "unreconstructable", error: ref?.error || "no reference" }); continue; }
    const j = joinRuns(a, ref, battery);
    results.push({ ...id, status: j.ok ? "agree" : "disagree", ...j,
      reference: { kind: ref.kind, model_id: ref.model_id, base_model_id: ref.base_model_id, delta_id: ref.delta_id, w_unit_q16: ref.w_unit_q16, records: ref.records, t_rebuild_s: ref.t_rebuild_s, t_battery_s: ref.t_battery_s } });
  }
  const n = (s) => results.filter((r) => r.status === s).length;
  return { battery: battery.name, version: battery.version, archives: archives.length, sampled: sample.length, rate: opts.all ? 1 : opts.rate ?? DEFAULT_RATE, salt: opts.all ? null : opts.salt ?? DEFAULT_SALT,
    agree: n("agree"), disagree: n("disagree"), unreconstructable: n("unreconstructable"), ok: results.every((r) => r.status === "agree"), results };
}

/** the numpy references for a sample, in one Python process (a base is read and hashed once for all of them) */
export function numpyReferences(archives, { battery, python = process.env.FLYBNB_PYTHON || "python3", bases = [], recipes = [], cache = null, fetch = false, workers = 1 }) {
  if (!archives.length) return new Map();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "battery-audit-")), out = path.join(tmp, "refs.jsonl");
  const files = archives.map((a, i) => { const f = path.join(tmp, `archive${i}.json`); fs.writeFileSync(f, JSON.stringify(a)); return f; });   // as loaded: one shape for Python
  const args = [path.join(root, "flybnb/analysis/audit_reference.py"), "--battery", battery, "--archive", ...files, "--out", out, "--workers", String(workers),
    ...bases.flatMap((b) => ["--base", b]), ...recipes.flatMap((r) => ["--recipes", r]), ...(cache ? ["--cache", cache] : []), ...(fetch ? ["--fetch"] : [])];
  const r = spawnSync(python, args, { stdio: ["ignore", "inherit", "inherit"] });
  if (r.status !== 0) throw Error(`audit_reference.py exited ${r.status ?? r.signal}`);
  const lines = fs.readFileSync(out, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)); fs.rmSync(tmp, { recursive: true, force: true });
  return new Map(archives.map((a, i) => [a, lines[i]]));
}

// ---- CLI ----
if (import.meta.url === `file://${process.argv[1]}`) {
  const argv = process.argv.slice(2), many = (k) => argv.flatMap((x, i) => (x === "--" + k ? [argv[i + 1]] : [])), arg = (k, d = null) => many(k).at(-1) ?? d, flag = (k) => argv.includes("--" + k);
  if (!arg("battery") || !many("archives").length) { console.error("node battery/audit.mjs --battery F --archives DIR|FILE [...] [--base F ...] [--recipes DIR ...] [--fetch --cache DIR] [--rate R | --all] [--salt S] [--workers N] [--python P] [--out F]"); process.exit(2); }
  const battery = JSON.parse(fs.readFileSync(arg("battery"), "utf8")), archives = readArchives(many("archives"));
  const opts = { rate: Number(arg("rate", DEFAULT_RATE)), salt: arg("salt", DEFAULT_SALT), all: flag("all") }, sample = selectSample(archives, opts);
  console.error(`${archives.length} archived result(s), ${sample.length} drawn (${opts.all ? "all" : `rate ${opts.rate}, salt ${JSON.stringify(opts.salt)}`})`);
  const refs = numpyReferences(sample, { battery: arg("battery"), python: arg("python", process.env.FLYBNB_PYTHON || "python3"), bases: many("base"), recipes: many("recipes"), cache: arg("cache"), fetch: flag("fetch"), workers: Number(arg("workers", 1)) });
  const report = await audit(archives, battery, async (a) => refs.get(a), opts);
  for (const r of report.results) {
    console.log(`${r.status.padEnd(17)} task ${r.taskId}${r.tokenId != null ? ` token ${r.tokenId}` : ""}  ${r.error || `${r.matched}/${r.expected} runs agree`}`);
    for (const m of r.mismatches || []) console.log(`    run ${m.run} ${m.stimulus} seed ${m.seed}: archived ${m.archived}, numpy ${m.numpy}`);
    for (const k of ["missing", "duplicated", "unexpected", "misordered"]) if (r[k]?.length) console.log(`    ${k}: ${JSON.stringify(r[k])}`);
  }
  console.log(`audit: ${report.agree}/${report.sampled} sampled results agree with numpy; ${report.disagree} disagree, ${report.unreconstructable} could not be rebuilt`);
  if (arg("out")) fs.writeFileSync(arg("out"), JSON.stringify(report, null, 1) + "\n");
  process.exit(report.ok ? 0 : 1);
}
