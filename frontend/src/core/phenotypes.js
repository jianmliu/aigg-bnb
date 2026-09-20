// What is unusual about an individual, and the honest answer when nothing is known yet.
//
// A fly's "rarity" is not a trait a generator handed it: it is where its measured phenotypes fall among the hundred
// founders (flybnb/analysis/phenotype_rank.mjs). A fly bred a minute ago has no measurements, and the page says so --
// running its battery is what turns a recipe into a phenotype, and that is what the breeding fee pays for.
const URL = "/phenotypes/individuals-v1.json";
let loaded = null; // { byDeltaHash, founders, bred, standout_percentile, reference }

export async function loadPhenotypes() {
  if (loaded) return loaded;
  try { const r = await fetch(URL); if (!r.ok) throw new Error(String(r.status)); const j = await r.json();
    loaded = j && j.byDeltaHash ? j : null; } catch { loaded = null; }
  return loaded;
}
/** { standout: [{ name, value, percentile }], phenotypes, id } for a fly, or null if nothing has measured it */
export function phenotypesOf(deltaHash) {
  const d = loaded && deltaHash ? loaded.byDeltaHash[String(deltaHash).toLowerCase()] : null;
  return d || null;
}
/** "the top 2% of founders" / "the bottom 1%" -- a percentile said the way a reader thinks about it */
export function standing(percentile) {
  const p = Number(percentile);
  if (p >= 50) return { text: `top ${fmt(100 - p)}%`, high: true };
  return { text: `bottom ${fmt(p)}%`, high: false };
}
const fmt = (x) => (x < 1 ? x.toFixed(1).replace(/\.0$/, "") : String(Math.round(x)));
