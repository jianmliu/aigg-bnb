// Pack a brain for a static host that will not take it whole.
//
// A brain is tens of megabytes and Cloudflare Pages refuses any file over 25 MiB, so a mirror there has to be
// chunked. Nothing about that weakens anything: the page concatenates the parts and recomputes model_id over the
// result, and the chain says what model_id must be. A wrong part, a missing part, a hostile part -- all of them
// fail the same check that a wrong whole file fails. The manifest is a convenience, not a claim: it is not signed,
// and nothing trusts it beyond "where to look next".
//
//   node js/mirror_pack.mjs <payload.bin> <out-dir>/<bucket>/<object> [partMiB=20]
//
// writes  <object>.parts.json   { parts, size, part }
//         <object>.part0 … .partN
//
// The page tries <object> first and falls back to <object>.parts.json, so a mirror that CAN hold the whole file
// just holds it, and this is only for the ones that cannot.
import fs from "node:fs"; import path from "node:path";
const [src, out, mib = "20"] = process.argv.slice(2);
if (!src || !out) { console.log("usage: mirror_pack.mjs <payload.bin> <out-dir>/<bucket>/<object> [partMiB]"); process.exit(2); }
const part = Math.round(Number(mib) * 1024 * 1024);
if (!(part > 0 && part <= 24 * 1024 * 1024)) { console.error("partMiB must be 1 … 24 (Cloudflare Pages refuses 25 MiB and over)"); process.exit(2); }

const bytes = fs.readFileSync(src);
fs.mkdirSync(path.dirname(out), { recursive: true });
const parts = Math.ceil(bytes.length / part);
for (let i = 0; i < parts; i++) fs.writeFileSync(`${out}.part${i}`, bytes.subarray(i * part, Math.min((i + 1) * part, bytes.length)));
fs.writeFileSync(`${out}.parts.json`, JSON.stringify({ parts, size: bytes.length, part }) + "\n");

const MB = (n) => (n / 1024 ** 2).toFixed(1);
console.log(`${path.basename(src)}: ${MB(bytes.length)} MB -> ${parts} part(s) of at most ${MB(part)} MB`);
for (let i = 0; i < parts; i++) console.log(`  ${path.basename(out)}.part${i}  ${MB(fs.statSync(`${out}.part${i}`).size)} MB`);
console.log(`  ${path.basename(out)}.parts.json`);
// a mirror is only useful if it reassembles to the same bytes; say so here rather than finding out in a browser
const back = Buffer.concat(Array.from({ length: parts }, (_, i) => fs.readFileSync(`${out}.part${i}`)));
if (!back.equals(bytes)) { console.error("the parts do not reassemble to the payload"); process.exit(1); }
console.log(`reassembles to the same ${bytes.length} bytes`);
