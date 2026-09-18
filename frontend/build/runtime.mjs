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
import fs from "node:fs";
import path from "node:path";

export const rewriteBareImports = (src) => String(src)
  .replace(/(['"])@noble\/secp256k1\1/g, '"/vendor/@noble/secp256k1/index.js"')
  .replace(/(['"])@noble\//g, '"/vendor/@noble/');

/** what a browser can actually load out of these directories; everything else (.py, .c, .sh, benches) is repo furniture */
const SERVABLE = new Set([".js", ".mjs", ".wasm", ".json"]);
const REWRITTEN = new Set([".js", ".mjs"]);

/** the source directories, relative to the repo root, and the URL prefix each is served under */
export const runtimeRoots = (repoRoot) => [
  { prefix: "/porw/", dir: path.join(repoRoot, "contracts/lib/aigg-porw/web/porw-browser") },
  { prefix: "/vendor/@noble/hashes/", dir: path.join(repoRoot, "node_modules/@noble/hashes") },
  { prefix: "/vendor/@noble/secp256k1/", dir: path.join(repoRoot, "node_modules/@noble/secp256k1") },
];

/** read one file from the runtime roots for a request path, or null; `null` also covers traversal attempts */
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

/** copy the runtime into a built site so the /porw/ and /vendor/ URLs resolve as static files */
export function copyRuntime(repoRoot, outDir) {
  let copied = 0;
  for (const { prefix, dir } of runtimeRoots(repoRoot)) {
    if (!fs.existsSync(dir)) throw new Error(`the frontend runtime is missing: ${dir}\n(git submodule update --init --recursive, then npm install)`);
    const target = path.join(outDir, prefix.replace(/^\//, ""));
    const walk = (from, to) => {
      for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
        if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
        const src = path.join(from, entry.name), dst = path.join(to, entry.name);
        if (entry.isDirectory()) { walk(src, dst); continue; }
        const ext = path.extname(entry.name);
        if (!SERVABLE.has(ext)) continue;
        fs.mkdirSync(to, { recursive: true });
        if (REWRITTEN.has(ext)) fs.writeFileSync(dst, rewriteBareImports(fs.readFileSync(src, "utf8")));
        else fs.copyFileSync(src, dst);
        copied++;
      }
    };
    walk(dir, target);
  }
  return copied;
}
