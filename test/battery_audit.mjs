// The sampled audit of archived battery results against a second implementation (battery/audit.mjs).
//
// The comparison is exercised on committed evidence, so CI needs no brain: fly #101's live battery (the network's WASM
// digests, flybnb/results/male/live/fly101.json) against the pilot founder M000's row, which numpy computed for the same
// recipe (flybnb/results/male/pilot/rows.jsonl.gz). Spoiled copies must be named run by run. The substrate and the
// published-wiring runs check the root case in both directions. Then the draw: deterministic, per result, at its rate.
//
// With Python and numpy (FLYBNB_PYTHON, default python3) it also runs the whole path on a synthetic brain: a founder
// recipe applied in place, the battery executed by the WASM kernel into a worker-shaped archive, and audit_reference.py
// rebuilding the payload from base + recipe and running intlif.py. Without numpy that part is reported as SKIPPED.
import fs from "node:fs"; import os from "node:os"; import path from "node:path"; import zlib from "node:zlib"; import { spawnSync } from "node:child_process";
import { keccak256 } from "viem";
import { loadArchive, joinRuns, audit, drawn, selectSample, numpyReferences, DEFAULT_RATE } from "../battery/audit.mjs";
import { rowOf, resolvedRuns, batteryBatch } from "../flybnb/battery/battery_batch.mjs";
import * as H from "./harness.mjs";
let fails = 0; const check = (n, ok) => { console.log((ok ? "  ok   " : "  FAIL ") + n); if (!ok) fails++; };
const read = (p) => JSON.parse(fs.readFileSync(new URL("../" + p, import.meta.url), "utf8"));
const M = read("flybnb/battery/battery-male-v1.json");
const pilot = zlib.gunzipSync(fs.readFileSync(new URL("../flybnb/results/male/pilot/rows.jsonl.gz", import.meta.url))).toString("utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const M000 = pilot.find((r) => r.id === "M000"), BASE_ROW = pilot.find((r) => r.kind === "base");
const fly = loadArchive(read("flybnb/results/male/live/fly101.json"), "fly101.json");
const clone = (x) => JSON.parse(JSON.stringify(x)), ZERO = "0x" + "00".repeat(32);
// a worker.mjs artifact carries rows as {...rowOf(spec, k), execRoot, countsDigest, ...}: no run index of their own
const asWorker = (a, taskId = a.taskId) => ({ taskId, tokenId: "101", modelId: "0x8af16bb92997734b553067a7b9e44aa118578e68a36a3edcd742d19078c55029", rows: a.rows.map((r) => ({ stimulus: r.stimulus, seed: r.seed, execRoot: r.execRoot, countsDigest: r.countsDigest })) });

// ---- the committed evidence joins ----
{ const j = joinRuns(fly, M000, M);
  check(`fly #101's ${j.runs} archived digests join M000's numpy row run by run: ${j.matched}/${j.expected}`, j.ok && j.matched === 42 && j.expected === 42 && !j.mismatches.length);
  const w = joinRuns(asWorker(fly), M000, M);
  check("the same rows in worker.mjs's artifact shape (no run field) join the same way, run k taken from position", w.ok && w.matched === 42); }

// ---- mutations: a spoiled digest is named, with both values, and nothing else is ----
{ const K = 17, bad = clone(asWorker(fly)); const was = bad.rows[K].countsDigest; bad.rows[K].countsDigest = "0x" + (BigInt(was) ^ 1n).toString(16).padStart(64, "0");
  const j = joinRuns(bad, M000, M), m = j.mismatches[0], want = rowOf(M, K);
  check(`a digest spoiled in one bit (run ${K}, ${want.stimulus} seed ${want.seed}) is named: that run, both digests, and no other`,
    !j.ok && j.mismatches.length === 1 && m.run === K && m.stimulus === want.stimulus && m.seed === want.seed && m.archived === bad.rows[K].countsDigest && m.numpy === was.toLowerCase() && j.matched === 41);
  const ref = clone(M000); ref.rows.find((w) => w.stim === "hygro" && w.seed === 9).digest = ZERO; const j2 = joinRuns(fly, ref, M);
  check("a wrong reference is named the same way (hygro seed 9): the join does not trust either side", !j2.ok && j2.mismatches.length === 1 && j2.mismatches[0].stimulus === "hygro" && j2.mismatches[0].seed === 9 && j2.mismatches[0].numpy === ZERO);
  const three = clone(asWorker(fly)); for (const k of [0, 20, 41]) three.rows[k].countsDigest = ZERO; const j3 = joinRuns(three, M000, M);
  check("three spoiled runs are three named runs, not an average", !j3.ok && JSON.stringify(j3.mismatches.map((x) => x.run)) === "[0,20,41]"); }

// ---- what a join over the archive's own rows alone would miss ----
{ const sw = clone(asWorker(fly)); [sw.rows[3], sw.rows[4]] = [sw.rows[4], sw.rows[3]]; const j = joinRuns(sw, M000, M);
  check("two rows swapped: every digest still matches its (stimulus, seed), and the audit still fails on order", !j.ok && j.mismatches.length === 0 && j.misordered.length === 2 && j.misordered[0].row === 3);
  const dup = clone(asWorker(fly)); dup.rows[5] = clone(dup.rows[4]); const j2 = joinRuns(dup, M000, M);
  check("a run archived twice in place of another: 42 rows, all digests equal, the missing run and the duplicate are named",
    !j2.ok && j2.runs === 42 && j2.mismatches.length === 0 && j2.missing.length === 1 && j2.missing[0].stimulus === rowOf(M, 5).stimulus && j2.missing[0].seed === rowOf(M, 5).seed && j2.duplicated.length === 1);
  const short = clone(asWorker(fly)); short.rows.pop(); const j3 = joinRuns(short, M000, M);
  check("a run dropped from the end is missing, not passed", !j3.ok && j3.missing.length === 1 && j3.missing[0].stimulus === "thermo" && j3.missing[0].seed === 9); }

// ---- the root case: a registered base payload is joined as registered, not as the dataset's thresholded base ----
{ const sub = loadArchive(read("flybnb/results/male/live/attestation.json"), "attestation.json"), reg = read("flybnb/results/male/live/registered-base.json"), min5 = loadArchive(read("flybnb/results/male/live/min5.json"), "min5.json");
  const a = joinRuns(sub, reg, M), b = joinRuns(sub, BASE_ROW, M), c = joinRuns(min5, BASE_ROW, M);
  check("the substrate's live battery joins numpy over every record of the registered payload (42/42)", a.ok && a.matched === 42 && /no min_syn threshold/.test(reg.kind));
  check("and against the dataset's thresholded base row every one of its 42 runs is named -- the right answer to the wrong question", !b.ok && b.mismatches.length === 42);
  check("the published wiring (the >= 5 export as its own root) is the one that joins the base row", c.ok && c.matched === 42); }

// ---- the draw ----
{ const ids = Array.from({ length: 4000 }, (_, i) => keccak256("0x" + i.toString(16).padStart(8, "0")));
  const at = (rate, salt) => ids.filter((t) => drawn(t, { rate, salt })).length;
  const n = at(DEFAULT_RATE), sd = Math.sqrt(ids.length * DEFAULT_RATE * (1 - DEFAULT_RATE));
  check(`at the default rate ${DEFAULT_RATE}, ${n} of ${ids.length} results are drawn (expected ${ids.length * DEFAULT_RATE} +/- ${Math.round(4 * sd)})`, Math.abs(n - ids.length * DEFAULT_RATE) < 4 * sd);
  check("rate 0 draws nothing and rate 1 draws everything", at(0) === 0 && at(1) === ids.length);
  const s1 = ids.filter((t) => drawn(t, { rate: 0.2 })), s2 = ids.filter((t) => drawn(t, { rate: 0.2 }));
  check("the same salt draws the same results, every time", JSON.stringify(s1) === JSON.stringify(s2));
  const sub = ids.slice(0, 1000).filter((t) => drawn(t, { rate: 0.2 }));
  check("a result's fate does not depend on the others: a subset's sample is the full sample restricted to it", JSON.stringify(sub) === JSON.stringify(s1.filter((t) => ids.indexOf(t) < 1000)));
  const other = ids.filter((t) => drawn(t, { rate: 0.2, salt: "after-delivery-0xabc" })), both = other.filter((t) => s1.includes(t)).length;
  check(`another salt draws an independent sample (${both} in common of ${other.length}, ~${Math.round(0.2 * other.length)} expected by chance)`, Math.abs(both - 0.2 * other.length) < 4 * Math.sqrt(other.length * 0.16));
  check("a rate outside [0, 1] is refused", (() => { try { drawn(ids[0], { rate: 2 }); return false; } catch { return true; } })()); }

// ---- the report: agree, disagree, cannot rebuild -- and a failure is never averaged into a pass ----
{ const good = asWorker(fly, keccak256("0x01")), spoiled = clone(asWorker(fly, keccak256("0x02"))), orphan = asWorker(fly, keccak256("0x03"));
  spoiled.rows[30].countsDigest = ZERO;
  const refs = new Map([[good.taskId, M000], [spoiled.taskId, M000], [orphan.taskId, { error: "LookupError: base 0x7a22… not found" }]]);
  const r = await audit([good, spoiled, orphan], M, async (a) => refs.get(a.taskId), { all: true });
  const bad = r.results.find((x) => x.taskId === spoiled.taskId), lost = r.results.find((x) => x.taskId === orphan.taskId);
  check(`the report: ${r.agree} agree, ${r.disagree} disagree, ${r.unreconstructable} could not be rebuilt, and it is not ok`, r.sampled === 3 && r.agree === 1 && r.disagree === 1 && r.unreconstructable === 1 && r.ok === false);
  check(`the disagreeing result names run 30 (${rowOf(M, 30).stimulus} seed ${rowOf(M, 30).seed}) and its task`, bad.status === "disagree" && bad.mismatches.length === 1 && bad.mismatches[0].run === 30 && bad.mismatches[0].stimulus === rowOf(M, 30).stimulus && bad.taskId === spoiled.taskId);
  check("a result that cannot be rebuilt is reported with the reason, not skipped", lost.status === "unreconstructable" && /not found/.test(lost.error));
  const r2 = await audit([good], M, async () => M000, { all: true }); check("one result, rebuilt and agreeing: ok", r2.ok && r2.agree === 1);
  const none = await audit([good, spoiled], M, async () => { throw Error("not drawn, not computed"); }, { rate: 0 });
  check("an undrawn result is not computed at all (the draw comes before a numpy battery of a minute or two)", none.sampled === 0 && none.results.length === 0);
  check("a file that is not a battery result is refused on load", (() => { try { loadArchive({ rows: [] }, "x.json"); return false; } catch (e) { return /not a battery result/.test(e.message); } })()); }

// ---- the whole path on a synthetic brain: recipe applied in place, WASM executes, numpy rebuilds and runs ----
const py = process.env.FLYBNB_PYTHON || "python3"; const has = spawnSync(py, ["-c", "import numpy, Crypto, sys; assert sys.version_info >= (3, 10)"], { encoding: "utf8" }).status === 0;
if (!has) console.log(`  SKIPPED the numpy half: ${py} is not Python >= 3.10 with numpy and pycryptodome (set FLYBNB_PYTHON)`);
else {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "battery-audit-test-"));
  try {
    const { synthesizePayloadV2 } = await H.porw("synth.js"), { PorwNode } = await H.porw("node.js"), { loadKernelFromBytes } = await H.porw("porw.js");
    const WUNIT = 7209, STEPS = 200, NEURONS = 3000, NAME = "lif-audit-base";
    const base = synthesizePayloadV2(NAME, NEURONS, 30000), bf = path.join(tmp, NAME + ".bin"), rd = path.join(tmp, "recipes"); fs.mkdirSync(rd); fs.writeFileSync(bf, base);
    // a founder recipe on this base, in place, from the same library the collection's recipes come from
    const mk = spawnSync(py, ["-c", `import sys; sys.path.insert(0, ${JSON.stringify(path.join(H.root, "flybnb/analysis"))}); import intlif as IL; FD = IL.FD
b = open(sys.argv[1], "rb").read(); B = FD.decode_payload(b); mid = FD.model_id(b)
d = FD.encode_delta3(mid, B["n"], FD.fit_name("audit-founder", FD.base_name_length(b)), "", FD.ZERO_ID, FD.ZERO_ID, 4242, min_syn=2, mut_rate_q32=FD.MUT_ALWAYS, mean_ratio_q16=60948, layout=1)
did = "0x" + FD.delta_id(d).hex(); open(sys.argv[2] + "/" + did + ".delta", "wb").write(d); c = FD.apply_any(b, d); open(sys.argv[3], "wb").write(c)
print("0x" + mid.hex(), did, "0x" + FD.model_id(c).hex())`, bf, rd, path.join(tmp, "child.bin")], { encoding: "utf8" });
    check("a founder recipe is applied in place to the synthetic base", mk.status === 0); if (mk.status !== 0) throw Error(mk.stderr);
    const [baseMid, deltaHash, childMid] = mk.stdout.trim().split(/\s+/), child = fs.readFileSync(path.join(tmp, "child.bin"));
    const ids = (from, step, count) => Array.from({ length: count }, (_, j) => from + j * step);
    const battery = { name: "flybnb-battery-audit-test", version: 1, steps: STEPS, commit_stride: 50, seeds: [7, 8, 9], neurons: NEURONS,
      population: { base_model_id: baseMid, min_syn: 2, mean_ratio_q16: 60948, w_unit_q16: WUNIT },
      readout: { neuron_index: ids(0, 10, 300) }, stimuli: [["ears", ids(0, 9, 250)], ["legs", ids(3, 7, 300)], ["nose", ids(1500, 2, 120)]].map(([name, idx]) => ({ name, n: idx.length, neuron_index: idx })) };
    const batf = path.join(tmp, "battery.json"); fs.writeFileSync(batf, JSON.stringify(battery)); const version = keccak256(fs.readFileSync(batf));
    // what worker.mjs archive() does: node.execute on the WASM kernel, run by run, countsDigest = execDigest
    const node = new PorwNode(await loadKernelFromBytes(fs.readFileSync(path.join(H.porwDir, "sketch.wasm"))));
    const st = await node.loadModel("child", new Uint8Array(child), { exec: "lif", maxSteps: STEPS, wUnitQ16: WUNIT }), runs = resolvedRuns(batteryBatch(battery)), rows = [];
    for (let k = 0; k < runs.length; k++) { const r = await node.execute(st.mep.mepId, { steps: STEPS, commitStride: 50, ...runs[k] }); rows.push({ ...rowOf(battery, k), execRoot: H.hex(r.result.execRoot), countsDigest: H.hex(r.result.execDigest) }); }
    const archive = { taskId: keccak256("0xa1"), tokenId: "1", modelId: H.hex(st.mep.modelId), deltaHash, batteryVersion: version, rows };
    check("the WASM kernel's payload is the recipe's child: model_id agrees across the two implementations", archive.modelId === childMid && childMid !== baseMid);
    const spoiled = { ...clone(archive), taskId: keccak256("0xa2") }; spoiled.rows[4].countsDigest = ZERO;
    const noRecipe = { ...clone(archive), taskId: keccak256("0xa3"), deltaHash: keccak256("0xdead") }, otherBattery = { ...clone(archive), taskId: keccak256("0xa4"), batteryVersion: keccak256("0xbeef") };
    const wrongModel = { ...clone(archive), taskId: keccak256("0xa5"), modelId: baseMid.replace(/.$/, (c) => (c === "0" ? "1" : "0")) };
    const all = [archive, spoiled, noRecipe, otherBattery, wrongModel].map((a, i) => loadArchive(a, `synthetic${i}`));
    const refs = numpyReferences(all, { battery: batf, python: py, bases: [bf], recipes: [rd] });
    const rep = await audit(all, battery, async (a) => refs.get(a), { all: true }), by = (t) => rep.results.find((x) => x.taskId === t);
    const good = by(archive.taskId);
    check(`numpy rebuilds base + recipe and agrees with the WASM kernel on all ${good.expected} runs at unit ${WUNIT}`, good.status === "agree" && good.matched === 9 && good.reference.kind === "derived" && good.reference.delta_id === deltaHash && good.reference.w_unit_q16 === WUNIT);
    check("and the spoiled copy is named: run 4 only", by(spoiled.taskId).status === "disagree" && by(spoiled.taskId).mismatches.length === 1 && by(spoiled.taskId).mismatches[0].run === 4);
    check("a recipe nobody has is a failure to rebuild, not a pass", by(noRecipe.taskId).status === "unreconstructable" && /not found/.test(by(noRecipe.taskId).error));
    check("a result run under another battery file is refused before anything is run", by(otherBattery.taskId).status === "unreconstructable" && /battery/.test(by(otherBattery.taskId).error));
    check("a model_id the provided bases and recipes cannot produce is refused", by(wrongModel.taskId).status === "unreconstructable");
    check("the report is not ok while any sampled result disagrees or cannot be rebuilt", rep.ok === false && rep.agree === 1);
    // the unit belongs to the population: the same archive under the default unit must not join
    const b2 = path.join(tmp, "battery-18022.json"); fs.writeFileSync(b2, JSON.stringify({ ...battery, population: { ...battery.population, w_unit_q16: 18022 } }));
    const r18 = numpyReferences([loadArchive({ ...archive, batteryVersion: keccak256(fs.readFileSync(b2)) })], { battery: b2, python: py, bases: [bf], recipes: [rd] });
    const j18 = joinRuns(archive, [...r18.values()][0], battery);
    check("the weight unit is not decoration: rebuilt and run under 18022, the runs are named as disagreeing", !j18.ok && j18.mismatches.length > 0);
  } catch (e) { console.error(String(e.message || e).split("\n").slice(0, 5).join(" | ")); fails++; } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}
console.log(fails ? `${fails} FAILURES` : "battery audit: all checks passed"); process.exit(fails ? 1 : 0);
