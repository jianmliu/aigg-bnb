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

// The runtime the brains are executed by, and the worker that runs them: both ship at URLs named after their own
// contents, because a fixed URL plus a CDN is a version-skew bug with a timer on it. One was fired on 2026-09-20:
// the zone's four-hour Browser Cache TTL overrode this build's five-minute request on /porw/* and /node_worker.js,
// and a tab ran a stale worker against a fresh bundle and hung silently. What that costs is checked here, because
// a single unhashed reference surviving into the output brings the whole failure back.
const entries = fs.existsSync(dist) ? fs.readdirSync(dist) : [];
const porwDir = entries.find((d) => /^porw\.[0-9a-f]{10}$/.test(d));
const vendorDir = entries.find((d) => /^vendor\.[0-9a-f]{10}$/.test(d));
const workerFile = entries.find((f) => /^node_worker\.[0-9a-f]{10}\.js$/.test(f));
for (const [what, d] of [["porw", porwDir], ["vendor", vendorDir]])
  check(`the ${what} runtime was copied in under a content-addressed name`, !!d && fs.readdirSync(path.join(dist, d)).length > 0, d || `no ${what}.<id>/ in dist`);
check("the worker is content-addressed too", !!workerFile, workerFile || "no node_worker.<id>.js in dist");
check("and the fixed-URL worker is NOT also published", !entries.includes("node_worker.js"));
check("nor a fixed-URL runtime directory", !entries.includes("porw") && !entries.includes("vendor"));

// every JavaScript this build emits, and every reference in it to something this build also emits
const emitted = [...assets.filter((f) => f.endsWith(".js")).map((f) => path.join(dist, "assets", f)), ...(workerFile ? [path.join(dist, workerFile)] : [])];
const allJs = emitted.map((f) => fs.readFileSync(f, "utf8")).join("\n");
check("no unhashed /porw/ or /vendor/ reference survived the build", !/["'(]\/(porw|vendor)\//.test(allJs),
  (allJs.match(/["'(]\/(porw|vendor)\/[^"'`)]*/g) || []).slice(0, 3).join(" "));
check("no unhashed /node_worker.js reference survived either", !allJs.includes("/node_worker.js"));
check("the bundle asks for the worker this build actually emitted", !!workerFile && allJs.includes(`/${workerFile}`), workerFile || "-");
{ // a hashed URL that names nothing is worse than an unhashed one: it 404s on every visitor, forever
  const refs = [...new Set(allJs.match(/\/(?:porw|vendor)\.[0-9a-f]{10}\/[A-Za-z0-9@/._-]+/g) || [])];
  const missing = refs.filter((u) => !fs.existsSync(path.join(dist, u.replace(/^\//, ""))));
  check(`every runtime URL the build references exists in it (${refs.length} checked)`, refs.length > 0 && missing.length === 0, missing.slice(0, 3).join(" ")); }
{ // the copied modules import each other relatively, but their @noble imports were rewritten: those must land too
  const files = vendorDir ? [] : [];
  const sample = porwDir ? fs.readFileSync(path.join(dist, porwDir, "verify.js"), "utf8") : "";
  check("a copied module's @noble imports point at the hashed vendor directory",
    !!vendorDir && sample.includes(`/${vendorDir}/@noble/`) && !sample.includes('"/vendor/@noble/'), files.length ? "" : (sample.match(/"[^"]*@noble[^"]*"/) || ["none"])[0]); }
{ // _headers has to mark them immutable: that is the one lifetime the zone's TTL does not shorten
  const h = fs.existsSync(path.join(dist, "_headers")) ? fs.readFileSync(path.join(dist, "_headers"), "utf8") : "";
  for (const rule of ["/porw.*", "/vendor.*", "/node_worker.*.js", "/assets/*"]) {
    const block = h.split("\n\n").find((b) => b.trim().startsWith(rule));
    check(`_headers makes ${rule} immutable`, !!block && /immutable/.test(block), block ? block.trim().split("\n")[1] : "no rule"); } }
check("the genesis set is served, so adoption can prove its Merkle openings", fs.existsSync(path.join(dist, "genesis")));
check("the phenotype file is served, so a fly's standing among the founders can be shown", fs.existsSync(path.join(dist, "phenotypes/individuals-v1.json")));
// the views a visitor can reach by link: each one's id has to exist in the bundle
for (const [id, what] of [["docsTabPlay", "the docs page"], ["flybnbBanner", "the FlyBnB banner"], ["navDocs", "the Docs nav entry"]]) check(`${what} is in the bundle`, js.includes(id));

console.log(fails ? `${fails} FAILURES — not publishing this` : "deployed build: all checks passed");
process.exit(fails ? 1 : 0);
