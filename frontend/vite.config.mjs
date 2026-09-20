// The node page is a Vite + React app with one unusual rule: everything under /porw/ and /vendor/ is EXTERNAL.
//
// Those modules are the aigg-porw browser runtime, and `public/node_worker.js` -- a module worker, which does not
// inherit the document's import map -- imports them by the same absolute URLs the page does. Bundling them would
// give the page a copy the worker cannot reach. So Vite leaves the import specifiers alone and `build/runtime.mjs`
// puts real files at those URLs: served from the repo in dev, copied into `dist/` for the build.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { copyRuntime, readRuntimeFile, runtimeId, withRuntimeId, workerName } from "./build/runtime.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(here, "..");
const EXTERNAL = /^\/(porw|vendor)\//;
const GENESIS = path.join(repoRoot, "flybnb/genesis/genesis-v1.json");
const PHENOTYPES = path.join(repoRoot, "flybnb/results/phenotypes/individuals-v1.json");
const MIME = { ".js": "text/javascript", ".mjs": "text/javascript", ".wasm": "application/wasm", ".json": "application/json" };

/** serve /porw/ and /vendor/ in dev, and copy them into the output on build -- there, under a name made of their
 *  own contents, so that a browser holding an old copy cannot be holding it at the URL a new build asks for. */
const porwRuntime = () => {
  // Rolldown hands every hook its own context object, so this cannot live on `this`: the id is computed once per
  // build and closed over by the hooks that have to agree with it.
  let id = null, worker = null;
  return {
  name: "aigg-porw-runtime",
  enforce: "pre",
  // computed before anything is emitted: the chunks and the worker are rewritten to agree with it
  buildStart() {
    id = runtimeId(repoRoot);
    worker = workerName(fs.readFileSync(path.join(here, "public/node_worker.js"), "utf8"), id);
  },
  // `/porw/claim.js` in the page's own source and `/node_worker.js` in the controller are plain strings Vite leaves
  // alone (they are external, and a Worker URL is not a module specifier). This is where they learn the id.
  renderChunk(code) {
    if (!id) return null;
    const out = withRuntimeId(code, id).split("/node_worker.js").join(`/${worker.name}`);
    return out === code ? null : { code: out, map: null };
  },
  // Vite's own resolver would try to find these on disk and fail before Rollup ever consults `external`, so say
  // it here as well: these ids are URLs the browser resolves, not modules this build owns.
  resolveId(id) { return EXTERNAL.test(id) ? { id, external: true } : null; },
  configureServer(server) {
    server.middlewares.use((req, res, next) => {
      const url = decodeURIComponent(new URL(req.url, "http://x").pathname);
      if (url === "/genesis/genesis-v1.json") { res.setHeader("content-type", "application/json"); return res.end(fs.readFileSync(GENESIS)); }
      if (url === "/phenotypes/individuals-v1.json") { res.setHeader("content-type", "application/json"); return res.end(fs.readFileSync(PHENOTYPES)); }
      if (!EXTERNAL.test(url)) return next();
      const file = readRuntimeFile(repoRoot, url);
      if (!file) { res.statusCode = 404; return res.end(); }
      res.setHeader("content-type", MIME[file.ext] || "application/octet-stream");
      res.end(file.body);
    });
  },
  closeBundle() {
    // the collection's genesis set (flybnb/genesis): what can be adopted, with the proof `mint` takes. The page checks
    // its root against the collection's GENESIS_ROOT before it offers anything from it.
    fs.mkdirSync(path.join(here, "dist/genesis"), { recursive: true }); fs.copyFileSync(GENESIS, path.join(here, "dist/genesis/genesis-v1.json"));
    // where each measured individual stands among the founders (flybnb/analysis/phenotype_rank.mjs): what the page
    // shows instead of a made-up rarity, and what it cannot show for a fly whose battery has not been run
    fs.mkdirSync(path.join(here, "dist/phenotypes"), { recursive: true }); fs.copyFileSync(PHENOTYPES, path.join(here, "dist/phenotypes/individuals-v1.json"));
    const dist = path.join(here, "dist");
    const n = copyRuntime(repoRoot, dist, id);
    // Vite copies public/ verbatim, so the unhashed worker is sitting in dist right now. Publishing both would put
    // a fixed URL back on the CDN for the file whose staleness caused this; the hashed one is the only one.
    fs.rmSync(path.join(dist, "node_worker.js"), { force: true });
    fs.writeFileSync(path.join(dist, worker.name), worker.code);
    this.info?.(`copied ${n} runtime files into dist/porw.${id} and dist/vendor.${id}, worker ${worker.name}`);
  },
  };
};

export default {
  root: here,
  base: "/",
  publicDir: path.join(here, "public"),
  plugins: [react(), porwRuntime()],
  server: { host: "127.0.0.1", port: 8790, strictPort: false },
  build: {
    outDir: path.join(here, "dist"),
    emptyOutDir: true,
    target: "es2022",
    rollupOptions: { external: EXTERNAL },
  },
};
