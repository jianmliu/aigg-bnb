// The node page is a Vite + React app with one unusual rule: everything under /porw/ and /vendor/ is EXTERNAL.
//
// Those modules are the aigg-porw browser runtime, and `public/node_worker.js` -- a module worker, which does not
// inherit the document's import map -- imports them by the same absolute URLs the page does. Bundling them would
// give the page a copy the worker cannot reach. So Vite leaves the import specifiers alone and `build/runtime.mjs`
// puts real files at those URLs: served from the repo in dev, copied into `dist/` for the build.
import path from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { copyRuntime, readRuntimeFile } from "./build/runtime.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(here, "..");
const EXTERNAL = /^\/(porw|vendor)\//;
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
      if (!EXTERNAL.test(url)) return next();
      const file = readRuntimeFile(repoRoot, url);
      if (!file) { res.statusCode = 404; return res.end(); }
      res.setHeader("content-type", MIME[file.ext] || "application/octet-stream");
      res.end(file.body);
    });
  },
  closeBundle() {
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
