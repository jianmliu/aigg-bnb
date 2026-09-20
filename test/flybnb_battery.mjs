// The standard battery and its batch form. The battery file is data that every later row of the dataset depends on,
// so what is checked is that it is well formed and that turning it into a batch is order-preserving and total.
import fs from "node:fs";
import { batteryBatch, rowOf, resolvedRuns } from "../flybnb/battery/battery_batch.mjs";
let fails = 0; const check = (n, ok) => { console.log((ok ? "  ok   " : "  FAIL ") + n); if (!ok) fails++; };
const B = JSON.parse(fs.readFileSync(new URL("../flybnb/battery/battery-v1.json", import.meta.url)));
check(`battery v${B.version}: ${B.stimuli.length} stimuli x ${B.seeds.length} seeds, ${B.readout.neuron_index.length} descending neurons read out`, B.stimuli.length >= 10 && B.seeds.length === 3 && B.readout.neuron_index.length === 1303 && B.readout.cell_type.length === 1303);
check("every stimulus is a sorted, duplicate-free set of neurons of this brain, with a root id each and a rule", B.stimuli.every((s) => s.rule && s.n === s.neuron_index.length && s.root_id.length === s.n && s.neuron_index.every((x, i) => Number.isInteger(x) && x >= 0 && x < B.neurons && (i === 0 || x > s.neuron_index[i - 1]))));
check("stimulus names are unique, and every stimulus moved something downstream on the base wiring", new Set(B.stimuli.map((s) => s.name)).size === B.stimuli.length && B.stimuli.every((s) => s.base_wiring.neurons_reached.every((x) => x > 0)));
check("it says which stimuli tip the network into its high-activity state", B.stimuli.every((s) => ["sparse", "ignited"].includes(s.base_wiring.regime)) && B.stimuli.some((s) => s.base_wiring.regime === "ignited"));
const b = batteryBatch(B);
check(`as a batch: ${b.runs.length} runs naming ${Object.keys(b.sets).length} sets, under the battery's steps and stride`, b.runs.length === B.stimuli.length * B.seeds.length && Object.keys(b.sets).length === B.stimuli.length && b.steps === B.steps && b.commitStride === B.commit_stride && b.steps % b.commitStride === 0);
check("run k is stimulus floor(k / seeds) under seed k mod seeds, and rowOf says so", b.runs.every((r, k) => { const w = rowOf(B, k); return r.stimulusSet === w.stimulus && r.stimulusSeed === w.seed; }));
check("the announcement is small because sets are named once", JSON.stringify(b).length < 40000);
const p = batteryBatch(B, { silence: [5, 6, 7] }), rr = resolvedRuns(p);
check("a perturbed battery is the same batch with a silence set on every run", p.runs.length === b.runs.length && p.runs.every((r) => r.silenceSet === "__silence") && rr.every((r) => r.silenceIds.length === 3) && resolvedRuns(b).every((r) => r.silenceIds === null));
// the male battery: the same assay, and the population its individuals are drawn from
{ const M = JSON.parse(fs.readFileSync(new URL("../flybnb/battery/battery-male-v1.json", import.meta.url))), P = M.population, lr = JSON.parse(fs.readFileSync(new URL("../flybnb/results/male/lr_conditional.json", import.meta.url)));
  check(`male battery v${M.version}: ${M.stimuli.length} stimuli x ${M.seeds.length} seeds, ${M.readout.neuron_index.length} descending neurons, same steps, stride, seeds and window as the female one`, M.stimuli.length >= 10 && M.readout.neuron_index.length === 1314 && M.steps === B.steps && M.commit_stride === B.commit_stride && JSON.stringify(M.seeds) === JSON.stringify(B.seeds) && M.readout.window === B.readout.window);
  check("it names its population: the min2 base it was built on, weight unit 7209, mean ratio 0.93, and the dispersion table measured on the male hemispheres", P && P.base_model_id === M.payload_model_id && P.w_unit_q16 === 7209 && P.mean_ratio_q16 === 60948 && P.min_syn === 5 && JSON.stringify(P.r_table_q8) === JSON.stringify(lr.r_table_q8) && P.r_table_q8.length === 10);
  check("the female battery names none, so it keeps the defaults its committed rows were run under", B.population === undefined);
  check("every male stimulus is a sorted set with a body id each, and records its outgoing synapses by side", M.stimuli.every((s) => s.n === s.neuron_index.length && s.body_id.length === s.n && s.neuron_index.every((x, i) => i === 0 || x > s.neuron_index[i - 1]) && Object.values(s.outgoing_synapses_by_side).reduce((a, b) => a + b, 0) > 0));
  const snd = M.stimuli.find((s) => s.name === "sound").outgoing_synapses_by_side;
  check("which is how it shows that the right ear of this reconstruction is nearly disconnected, and why there is no sound_left", snd.R * 20 < snd.L && !M.stimuli.some((s) => s.name === "sound_left"));
  const mb = batteryBatch(M); check(`as a batch: ${mb.runs.length} runs naming ${Object.keys(mb.sets).length} sets`, mb.runs.length === M.stimuli.length * M.seeds.length && Object.keys(mb.sets).length === M.stimuli.length); }
// the male base's registered profile: the battery, the profile file and the pinned int-lif implementation must agree,
// because the chain computes the kind digest itself and a brain registered under the wrong one is a different brain
{ const L = await import("../contracts/lib/aigg-porw/web/porw-browser/lif.js");
  const hex = (b) => "0x" + Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  const M = JSON.parse(fs.readFileSync(new URL("../flybnb/battery/battery-male-v1.json", import.meta.url)));
  const f = JSON.parse(fs.readFileSync(new URL("../flybnb/male/malecns-v1.0-min2.v3.json", import.meta.url)));
  const f5 = JSON.parse(fs.readFileSync(new URL("../flybnb/male/malecns-v1.0-min5.v3.json", import.meta.url), "utf8"));
  check("both male brains are profiled under the same kind and differ only as substrate and published wiring", f5.execKind === f.execKind && f5.wUnitQ16 === f.wUnitQ16 && f5.neurons === f.neurons && f5.synapses < f.synapses && f5.mepId !== f.mepId && f5.modelId !== f.modelId);
  check(`the male profile's exec kind is what this aigg-porw computes for unit ${f.wUnitQ16}, and it is not the default kind`,
    f.execKind.toLowerCase() === hex(L.lifExecKind(f.wUnitQ16)).toLowerCase() && f.execKind.toLowerCase() !== hex(L.lifExecKind()).toLowerCase());
  check("and it is the brain the male battery's population names, at the battery's unit",
    f.modelId.toLowerCase() === M.population.base_model_id.toLowerCase() && f.wUnitQ16 === M.population.w_unit_q16 && f.neurons === M.neurons); }
// the live run on BSC testnet: the network's digests against numpy's, for the payload that is registered
{ const att = JSON.parse(fs.readFileSync(new URL("../flybnb/results/male/live/attestation.json", import.meta.url))), ref = JSON.parse(fs.readFileSync(new URL("../flybnb/results/male/live/registered-base.json", import.meta.url)));
  const a = att.attestation, M = JSON.parse(fs.readFileSync(new URL("../flybnb/battery/battery-male-v1.json", import.meta.url)));
  const V = await import("../contracts/lib/aigg-porw/web/porw-browser/verify.js"), Bt = await import("../contracts/lib/aigg-porw/web/porw-browser/batch.js");
  const unhex = (x) => Uint8Array.from(x.slice(2).match(/../g).map((h) => parseInt(h, 16)));
  const root = "0x" + Array.from(V.merkleRoot(a.rows.map((r, k) => Bt.runResultLeaf(k, unhex(r.execRoot)))), (x) => x.toString(16).padStart(2, "0")).join("");
  check(`the live male battery settled ${a.rows.length} runs as one task on chain ${a.chainId}, and its rows hash to the root the chain paid for`,
    a.rows.length === M.stimuli.length * M.seeds.length && a.complete === true && a.rows.every((r) => r.agree) && att.settled.matches === true && root === a.batchRoot && att.settled.onChain.every((r) => r === a.batchRoot));
  check(`and all ${att.offline.expected} counts digests equal what numpy computes for the registered payload (unit ${ref.w_unit_q16})`, att.offline.ok === true && att.offline.matched === att.offline.expected && ref.model_id.toLowerCase() === M.population.base_model_id.toLowerCase());
  check("the reference is the payload as registered, not the dataset's thresholded base", ref.records > M.population.min_syn * 0 && ref.records === 15283237 && /no min_syn threshold/.test(ref.kind)); }
console.log(fails ? `${fails} FAILURES` : "flybnb battery: all checks passed"); process.exit(fails ? 1 : 0);
