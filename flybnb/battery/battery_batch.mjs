// The standard battery as ONE batched task: what a client announces to the executors of an individual's brain.
//
//   import { batteryBatch, rowOf } from "./battery_batch.mjs";
//   const { steps, commitStride, sets, runs } = batteryBatch(battery);   // battery = battery-v1.json
//
// `sets` names each stimulus set once and `runs` refers to them, which is what keeps a 39-run announcement small
// (NodeService "batch-announce"). Run k is stimulus floor(k / seeds) under seed k mod seeds, in the battery's own order:
// the order is part of the battery, because a batch's input root and result root are over runs IN ORDER. A perturbed
// battery (the atlas) is the same batch with a silence set on every run.
export function batteryBatch(battery, { silence = null } = {}) {
  const sets = Object.fromEntries(battery.stimuli.map((s) => [s.name, s.neuron_index])); if (silence) sets.__silence = silence;
  const runs = []; for (const s of battery.stimuli) for (const seed of battery.seeds) runs.push({ stimulusSeed: seed, stimulusSet: s.name, ...(silence ? { silenceSet: "__silence" } : {}) });
  return { steps: battery.steps, commitStride: battery.commit_stride, sets, runs };
}
/** which (stimulus, seed) run k of the battery is */
export const rowOf = (battery, k) => ({ stimulus: battery.stimuli[Math.floor(k / battery.seeds.length)].name, seed: battery.seeds[k % battery.seeds.length] });
/** the announcement's runs with the ids inlined: what PorwNode.executeBatch / batchRunsRoot take */
export const resolvedRuns = (b) => b.runs.map((r) => ({ stimulusSeed: r.stimulusSeed, stimulusIds: Uint32Array.from(b.sets[r.stimulusSet]), silenceIds: r.silenceSet ? Uint32Array.from(b.sets[r.silenceSet]) : null }));
