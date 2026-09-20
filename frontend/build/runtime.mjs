// The runtime the page loads but Vite does not bundle: the aigg-porw browser modules under /porw/ and the two
// noble packages under /vendor/.
//
// They stay unbundled on purpose. `node_worker.js` is a module worker that imports the same /porw/ modules, and a
// worker does not inherit the document's import map -- so the paths the page uses have to be real URLs that
// resolve identically from the document and from the worker. Marking them external in Vite and copying the files
// to those URLs at build time is what makes that true, and it is also exactly the shape Cloudflare Pages wants:
// a directory of static files, no build image, no server rewriting anything on the way out.
//
// The one transformation between the repo and what a browser can load is the bare specifier: `@noble/...` has no
// meaning to a browser, so it is rewritten to the /vendor/ path as the files are copied.
//
// A fixed URL for a file that changes is the whole problem. `/porw/verify.js` means a different thing after every
// submodule bump, and a browser that still holds yesterday's copy runs it against today's bundle: a model_id that
// no longer matches the registry, or an op the worker has never heard of. `_headers` asked for five minutes of
// freshness, and on the deployed domain the zone's four-hour Browser Cache TTL raised it right back -- measured,
// 2026-09-20: `/porw/*` and `/node_worker.js` came back `max-age=14400` on fly.ai.gg and `max-age=300` on
// *.pages.dev. A cache header is a request. So the directory is named after its contents instead, the way Vite
// already names /assets/: `/porw.<id>/`. Then a stale URL cannot exist -- not "expires sooner", cannot exist --
// and the files can be immutable, which no zone setting shortens.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

/** the /vendor/ prefix is inside the files, so it moves with the id */
export const rewriteBareImports = (src, vendorPrefix = "/vendor/") => String(src)
  .replace(/(['"])@noble\/secp256k1\1/g, `"${vendorPrefix}@noble/secp256k1/index.js"`)
  .replace(/(['"])@noble\//g, `"${vendorPrefix}@noble/`);

/** what a browser can actually load out of these directories; everything else (.py, .c, .sh, benches) is repo furniture */
const SERVABLE = new Set([".js", ".mjs", ".wasm", ".json"]);
const REWRITTEN = new Set([".js", ".mjs"]);

/** the source directories, relative to the repo root, and the URL prefix each is served under */
export const runtimeRoots = (repoRoot) => [
  { prefix: "/porw/", dir: path.join(repoRoot, "contracts/lib/aigg-porw/web/porw-browser") },
  { prefix: "/vendor/@noble/hashes/", dir: path.join(repoRoot, "node_modules/@noble/hashes") },
  { prefix: "/vendor/@noble/secp256k1/", dir: path.join(repoRoot, "node_modules/@noble/secp256k1") },
];

/** every servable file under the runtime roots, as { url, file }, in a stable order */
export function runtimeFiles(repoRoot) {
  const out = [];
  for (const { prefix, dir } of runtimeRoots(repoRoot)) {
    if (!fs.existsSync(dir)) throw new Error(`the frontend runtime is missing: ${dir}\n(git submodule update --init --recursive, then npm install)`);
    const walk = (from, url) => {
      for (const entry of fs.readdirSync(from, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
        if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
        const file = path.join(from, entry.name);
        if (entry.isDirectory()) { walk(file, url + entry.name + "/"); continue; }
        if (SERVABLE.has(path.extname(entry.name))) out.push({ url: url + entry.name, file });
      }
    };
    walk(dir, prefix);
  }
  return out.sort((a, b) => (a.url < b.url ? -1 : 1));
}

/** The name of this exact runtime: every servable byte, and every path those bytes are served at.
 *  Source bytes, not rewritten ones -- the rewrite is a pure function of the source and the id, so hashing the
 *  source and then rewriting with the resulting id is well defined, while the other order is circular. */
export function runtimeId(repoRoot, length = 10) {
  const h = crypto.createHash("sha256");
  for (const { url, file } of runtimeFiles(repoRoot)) { h.update(url); h.update("\0"); h.update(fs.readFileSync(file)); h.update("\0"); }
  return h.digest("hex").slice(0, length);
}

/** where a given runtime id is served: what the build rewrites every `/porw/…` and `/vendor/…` specifier to */
export const runtimePrefixes = (id) => ({ "/porw/": `/porw.${id}/`, "/vendor/": `/vendor.${id}/` });

/** apply those prefixes to a piece of JavaScript (a chunk Vite emitted, or the worker) */
export const withRuntimeId = (code, id) => {
  let out = String(code);
  for (const [from, to] of Object.entries(runtimePrefixes(id))) out = out.split(from).join(to);
  return out;
};

/** read one file from the runtime roots for a request path, or null; `null` also covers traversal attempts.
 *  Used by the dev server, which serves the unhashed `/porw/` URLs: there is no CDN in front of it. */
export function readRuntimeFile(repoRoot, urlPath) {
  for (const { prefix, dir } of runtimeRoots(repoRoot)) {
    if (!urlPath.startsWith(prefix)) continue;
    const file = path.join(dir, urlPath.slice(prefix.length));
    if (!file.startsWith(dir) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return null;
    const ext = path.extname(file);
    const body = REWRITTEN.has(ext) ? Buffer.from(rewriteBareImports(fs.readFileSync(file, "utf8"))) : fs.readFileSync(file);
    return { body, ext };
  }
  return null;
}

/** copy the runtime into a built site under its content-named prefixes, so those URLs resolve as static files */
export function copyRuntime(repoRoot, outDir, id) {
  if (!id) throw new Error("copyRuntime needs the runtime id: an unnamed copy is the stale-cache bug this exists to remove");
  const prefixes = runtimePrefixes(id);
  const vendorPrefix = prefixes["/vendor/"];
  let copied = 0;
  for (const { url, file } of runtimeFiles(repoRoot)) {
    const served = url.replace(/^\/(porw|vendor)\//, (m) => prefixes[m]);
    const dst = path.join(outDir, served.replace(/^\//, ""));
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    if (REWRITTEN.has(path.extname(file))) fs.writeFileSync(dst, rewriteBareImports(fs.readFileSync(file, "utf8"), vendorPrefix));
    else fs.copyFileSync(file, dst);
    copied++;
  }
  return copied;
}

/** the worker is a fixed URL too, and the same argument applies: name it after what it says. */
export function workerName(source, id) {
  const code = withRuntimeId(source, id);
  return { code, name: `node_worker.${crypto.createHash("sha256").update(code).digest("hex").slice(0, 10)}.js` };
}
