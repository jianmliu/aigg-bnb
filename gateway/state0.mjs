// state_0 of an int-lif run, and its root -- what a task's `initStateRoot` has to be -- from nothing but the neuron
// count and the id lists. A client does not hold the brain: state_0 is all zeros except the flags (bit0 stimulated,
// bit2 silenced; aigg-porw LifRowCheck / lif_wasm.c porw_lif_state0_*), so the root is a function of (n, seed | ids,
// silence). An executor builds the same thing from the announcement and refuses to sign if its root is another one.
import path from "node:path"; import { fileURLToPath } from "node:url";
const porwDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "../contracts/lib/aigg-porw/web/porw-browser");
const L = await import(path.join(porwDir, "lif.js")); const V = await import(path.join(porwDir, "verify.js"));

/** @param stimulate sorted-or-not neuron ids, or null for the canonical set derived from the seed
 *  @returns { root: Uint8Array(32), stimulated: count } */
export function state0Root(n, seed, stimulate = null, silence = null) {
  const flags = new Uint16Array(n); let stimulated = 0;
  const mark = (ids, bit, what) => { for (const i of ids) { if (!Number.isInteger(i) || i < 0 || i >= n) throw new RangeError(`${what} id ${i} is not a neuron of this brain (0 … ${n - 1})`); flags[i] |= bit; } };
  if (stimulate) { mark(stimulate, 1, "stimulate"); stimulated = new Set(stimulate).size; }
  else for (let i = 0; i < n; i++) if (L.canonicalStim(i, seed >>> 0)) { flags[i] = 1; stimulated++; }
  if (silence) mark(silence, 4, "silence");
  const leaves = new Array(n); for (let i = 0; i < n; i++) leaves[i] = L.stateLeaf(i, { v: 0, g: 0, refr: 0, flags: flags[i], count: 0 });
  return { root: V.merkleRoot(leaves), stimulated };
}
