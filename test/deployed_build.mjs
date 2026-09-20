// What is about to be published is the page the visitors get, so this is the last gate before `wrangler pages deploy`
// (npm run deploy:frontend runs it between the build and the upload). It reads frontend/dist and nothing else.
//
// The failure it exists for is silent and total: `vite build` with no VITE_RELAYER_URL produces a perfectly good
// bundle that knows no relayer. Deployed, that page shows the developer's Mesh capsule, connects to nothing, and
// looks broken to everyone -- and nothing about the build says so. The deploy script now bakes the URL; this checks
// that the bytes really carry it, because an env var that did not reach vite fails exactly the same way.
import fs from "node:fs"; import path from "node:path"; import { fileURLToPath } from "node:url";
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(root, "frontend/dist");
let fails = 0; const check = (n, ok, note = "") => { console.log((ok ? "  ok   " : "  FAIL ") + n + (ok || !note ? "" : "  " + note)); if (!ok) fails++; };

const html = fs.existsSync(path.join(dist, "index.html")) ? fs.readFileSync(path.join(dist, "index.html"), "utf8") : "";
check("there is a build to publish", !!html);
const assets = fs.existsSync(path.join(dist, "assets")) ? fs.readdirSync(path.join(dist, "assets")) : [];
const entry = assets.find((f) => /^index-.*\.js$/.test(f));
check("its entry bundle is the one index.html loads", !!entry && html.includes(`assets/${entry}`), entry || "no index-*.js");
const js = entry ? fs.readFileSync(path.join(dist, "assets", entry), "utf8") : "";

// the relayer: baked in, https, and the only one -- a page that knows no relayer connects to nothing
const urls = [...new Set((js.match(/https?:\/\/[a-z0-9.-]+(?::\d+)?(?=[`"'])/gi) || []).filter((u) => /relayer|onrender|localhost|127\.0\.0\.1/i.test(u)))];
// `relayer.example.org` is the input's placeholder and is in every build, baked or not: it proves nothing
const real = urls.filter((u) => u.startsWith("https://") && !/example\.org/.test(u));
check("a relayer is baked in, so the page connects on open instead of asking the visitor for one", real.length > 0, urls.join(" ") || "none found");
check("it is https (a page on https cannot call a plaintext relayer)", urls.every((u) => u.startsWith("https://")), urls.join(" "));
check("no localhost survived the build", !urls.some((u) => /localhost|127\.0\.0\.1/.test(u)), urls.join(" "));
if (urls.length) console.log(`         relayer: ${urls.join(", ")}`);

// the runtime the brains are executed by, and the files the page reads at runtime: present, or the page half-works
for (const p of ["porw", "vendor"]) check(`the ${p} runtime was copied into the build`, fs.existsSync(path.join(dist, p)) && fs.readdirSync(path.join(dist, p)).length > 0);
check("the genesis set is served, so adoption can prove its Merkle openings", fs.existsSync(path.join(dist, "genesis")));
check("the phenotype file is served, so a fly's standing among the founders can be shown", fs.existsSync(path.join(dist, "phenotypes/individuals-v1.json")));
// the views a visitor can reach by link: each one's id has to exist in the bundle
for (const [id, what] of [["docsTabPlay", "the docs page"], ["flybnbBanner", "the FlyBnB banner"], ["navDocs", "the Docs nav entry"]]) check(`${what} is in the bundle`, js.includes(id));

console.log(fails ? `${fails} FAILURES — not publishing this` : "deployed build: all checks passed");
process.exit(fails ? 1 : 0);
