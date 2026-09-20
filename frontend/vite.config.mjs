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
import { copyRuntime, readRuntimeFile } from "./build/runtime.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(here, "..");
const EXTERNAL = /^\/(porw|vendor)\//;
const GENESIS = path.join(repoRoot, "flybnb/genesis/genesis-v1.json");
const PHENOTYPES = path.join(repoRoot, "flybnb/results/phenotypes/individuals-v1.json");
const MIME = { ".js": "text/javascript", ".mjs": "text/javascript", ".wasm": "application/wasm", ".json": "application/json" };

/** serve /porw/ and /vendor/ in dev, and copy them into the output on build */
const porwRuntime = () => ({
  name: "aigg-porw-runtime",
  enforce: "pre",
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
    const n = copyRuntime(repoRoot, path.join(here, "dist"));
    this.info?.(`copied ${n} runtime files into dist/porw and dist/vendor`);
  },
});

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
