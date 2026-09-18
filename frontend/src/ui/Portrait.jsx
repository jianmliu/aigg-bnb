// A listing needs a photograph, and a brain has none. So each one gets a portrait drawn from its own id: a fly's
// head seen from the front -- two red compound eyes and, between them, a brain whose neurons and commissures are
// placed by a generator seeded with the hash. The same id always draws the same picture; a different id, a
// different one. It is an identicon and nothing more. In particular the eyes are always wild-type red and nothing
// here varies with "rarity": what a brain is gets measured by experiments against it (docs/BREEDING.md §3), and a
// picture that hinted otherwise would be the one dishonest thing on the page.
import { useId, useMemo } from "react";

/** mulberry32: small, fast, and good enough to scatter forty dots */
function prng(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const seedOf = (hex) => { const h = String(hex || "").replace(/^0x/, ""); return (parseInt(h.slice(0, 8) || "0", 16) ^ parseInt(h.slice(8, 16) || "0", 16)) >>> 0; };

// paper, gold, blush, sage: backgrounds a photograph of a small thing on a table might have
const GROUNDS = [["#fff4cc", "#fde8eb"], ["#faf5e9", "#ffe9a8"], ["#e9f3ee", "#fff4cc"], ["#fde8eb", "#faf5e9"], ["#f3ecdc", "#e9f3ee"], ["#ffe9a8", "#fffdf8"]];

function draw(hex) {
  const r = prng(seedOf(hex)); const ground = GROUNDS[Math.floor(r() * GROUNDS.length)]; const tilt = Math.round(r() * 360);
  // neurons: points in the LEFT half of the brain, mirrored -- a fly brain is bilateral, and so is every portrait
  const pts = [];
  for (let i = 0; i < 22; i++) { const t = r() * Math.PI * 2, k = Math.sqrt(r()); pts.push({ x: 100 - 5 - k * 31 * Math.abs(Math.cos(t)), y: 96 + k * 36 * Math.sin(t), s: 1.3 + r() * 2.1 }); }
  const edges = [];
  pts.forEach((p, i) => { const near = pts.map((q, j) => ({ j, d: (p.x - q.x) ** 2 + (p.y - q.y) ** 2 })).filter((e) => e.j !== i).sort((a, b) => a.d - b.d); for (let n = 0; n < 1 + Math.floor(r() * 2); n++) edges.push([i, near[n].j]); });
  const commissures = []; for (let i = 0; i < 4; i++) { const p = pts[Math.floor(r() * pts.length)]; commissures.push({ x: p.x, y: p.y, lift: 8 + r() * 22 }); }
  // ommatidia: a hex grid over each eye, a generator-chosen scatter of them catching the light
  const facets = []; for (let row = 0; row < 13; row++) for (let col = 0; col < 9; col++) facets.push({ x: 8 + col * 8 + (row % 2) * 4, y: 52 + row * 7.4, lit: r() < 0.22 });
  return { ground, tilt, pts, edges, commissures, facets };
}

export function Portrait({ seed, egg = false, label }) {
  // unique per instance, not per seed: the same brain is drawn in two views, one of them hidden, and a gradient
  // referenced by id resolves to the first in the document -- which, inside a display:none subtree, paints nothing
  const id = "p" + useId().replace(/[^a-zA-Z0-9]/g, "");
  const d = useMemo(() => draw(seed), [seed]);
  const mirror = (x) => 200 - x;
  return (
    <svg className="portrait" viewBox="0 0 200 190" role="img" aria-label={label || "portrait drawn from this brain's id"} preserveAspectRatio="xMidYMid slice">
      <defs>
        <linearGradient id={id + "g"} gradientTransform={`rotate(${d.tilt} .5 .5)`}><stop offset="0" stopColor={d.ground[0]} /><stop offset="1" stopColor={d.ground[1]} /></linearGradient>
        <radialGradient id={id + "e"} cx="0.38" cy="0.32" r="0.8"><stop offset="0" stopColor="#ff6b7d" /><stop offset="0.55" stopColor="#d7263d" /><stop offset="1" stopColor="#8f1024" /></radialGradient>
        <radialGradient id={id + "b"} cx="0.5" cy="0.35" r="0.75"><stop offset="0" stopColor="#ffd85e" /><stop offset="1" stopColor="#f0b90b" /></radialGradient>
        <clipPath id={id + "l"}><ellipse cx="36" cy="96" rx="27" ry="42" /></clipPath>
        <clipPath id={id + "r"}><ellipse cx="164" cy="96" rx="27" ry="42" /></clipPath>
      </defs>
      <rect width="200" height="190" fill={`url(#${id}g)`} />
      {egg ? (
        <g>
          <ellipse cx="100" cy="168" rx="40" ry="6" fill="#1b1a17" opacity="0.08" />
          <ellipse cx="100" cy="100" rx="42" ry="58" fill="#fff6dc" stroke="#1b1a17" strokeOpacity="0.28" strokeWidth="1.5" />
          {d.pts.map((p, i) => <circle key={i} cx={p.x + 22} cy={p.y + 2} r={p.s * 1.25} fill="#d9a400" opacity="0.7" />)}
          <ellipse cx="86" cy="76" rx="9" ry="15" fill="#ffffff" opacity="0.8" transform="rotate(-18 86 76)" />
        </g>
      ) : (
        <g>
          <ellipse cx="100" cy="172" rx="70" ry="6" fill="#1b1a17" opacity="0.07" />
          {/* the head capsule, then the brain inside it */}
          <ellipse cx="100" cy="98" rx="66" ry="54" fill="#fffdf8" stroke="#1b1a17" strokeOpacity="0.1" />
          <path d="M100 54 C66 54 54 78 56 100 C58 126 78 140 100 140 C122 140 142 126 144 100 C146 78 134 54 100 54 Z" fill={`url(#${id}b)`} />
          <path d="M100 56 L100 138" stroke="#1b1a17" strokeOpacity="0.18" strokeWidth="1" />
          <g stroke="#1b1a17" strokeOpacity="0.32" strokeWidth="0.8" fill="none">
            {d.edges.map(([a, b], i) => <g key={i}><line x1={d.pts[a].x} y1={d.pts[a].y} x2={d.pts[b].x} y2={d.pts[b].y} /><line x1={mirror(d.pts[a].x)} y1={d.pts[a].y} x2={mirror(d.pts[b].x)} y2={d.pts[b].y} /></g>)}
            {d.commissures.map((c, i) => <path key={i} d={`M${c.x} ${c.y} Q100 ${c.y - c.lift} ${mirror(c.x)} ${c.y}`} strokeOpacity="0.5" />)}
          </g>
          <g fill="#1b1a17">
            {d.pts.map((p, i) => <g key={i}><circle cx={p.x} cy={p.y} r={p.s} /><circle cx={mirror(p.x)} cy={p.y} r={p.s} /></g>)}
          </g>
          {/* the eyes go on last: they are what makes it a fly */}
          {[["l", 0], ["r", 128]].map(([side, dx]) => (
            <g key={side}>
              <ellipse cx={36 + dx} cy="96" rx="27" ry="42" fill={`url(#${id}e)`} />
              <g clipPath={`url(#${id}${side})`}>
                {d.facets.map((f, i) => <circle key={i} cx={(side === "l" ? f.x : 200 - f.x)} cy={f.y} r="2.6" fill={f.lit ? "#ffc2ca" : "#7a0d1e"} opacity={f.lit ? 0.75 : 0.35} />)}
              </g>
              <ellipse cx={(side === "l" ? 28 : 172)} cy="74" rx="6" ry="11" fill="#fff" opacity="0.35" transform={`rotate(${side === "l" ? -20 : 20} ${side === "l" ? 28 : 172} 74)`} />
            </g>
          ))}
        </g>
      )}
    </svg>
  );
}
