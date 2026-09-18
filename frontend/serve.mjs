// Serves the BUILT page -- `frontend/dist` -- over plain HTTP. Nothing is transformed on the way out: the build
// already put the aigg-porw runtime at /porw/ and the noble packages at /vendor/ with their bare specifiers
// rewritten (frontend/build/runtime.mjs). That is deliberate. This server and Cloudflare Pages now serve byte for
// byte the same directory, so "it worked locally" means something, and the end-to-end test exercises the artifact
// that ships rather than a dev-only assembly of it.
//
// No COOP/COEP. Those headers exist to unlock SharedArrayBuffer, and nothing here uses shared memory: the node
// runs in a plain worker with the single-memory kernel. Sending them anyway would cost real things -- every
// cross-origin resource would have to be CORS or CORP clean, including a brain fetched from a storage provider --
// in exchange for a capability the page does not use. Putting the multi-threaded kernel back means taking them
// back on, deliberately.
//
//   npm run build:frontend                                     (produce frontend/dist)
//   node frontend/serve.mjs [--port 8790] [--payload file.bin]  (payload served at /payload.bin for local demos)
//
// For development with hot reload, `npm run frontend` runs Vite against the sources instead.
import fs from "node:fs"; import http from "node:http"; import path from "node:path"; import { fileURLToPath } from "node:url";
export { rewriteBareImports } from "./build/runtime.mjs";
const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(here, "dist");
const a = Object.fromEntries(process.argv.slice(2).reduce((acc, v, i, arr) => { if (v.startsWith("--")) acc.push([v.slice(2), arr[i + 1]]); return acc; }, []));
const MIME = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".wasm": "application/wasm", ".json": "application/json", ".bin": "application/octet-stream", ".svg": "image/svg+xml", ".map": "application/json" };
const ISO = {};
export function startFrontend(port = Number(a.port || 0), { payload = a.payload ? fs.readFileSync(a.payload) : null, payloads = {} } = {}) {
  if (payload) payloads["/payload.bin"] = payload;
  if (!fs.existsSync(path.join(dist, "index.html"))) throw new Error(`frontend/dist is not built — run \`npm run build:frontend\` first (looked in ${dist})`);
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, "http://x"); let p = decodeURIComponent(u.pathname); if (p === "/") p = "/index.html";
    if (payloads[p]) { res.writeHead(200, { ...ISO, "content-type": "application/octet-stream" }); return res.end(Buffer.from(payloads[p])); }
    if (p === "/favicon.ico") { res.writeHead(204); return res.end(); }
    const f = path.join(dist, p);
    if (f.startsWith(dist) && fs.existsSync(f) && !fs.statSync(f).isDirectory()) {
      res.writeHead(200, { ...ISO, "content-type": MIME[path.extname(f)] || "application/octet-stream" });
      return res.end(fs.readFileSync(f));
    }
    res.writeHead(404); res.end();
  });
  return new Promise((r) => server.listen(port, "127.0.0.1", () => r({ server, port: server.address().port, url: `http://127.0.0.1:${server.address().port}` })));
}
if (import.meta.url === `file://${process.argv[1]}`) { const s = await startFrontend(); console.log(`frontend at ${s.url}`); }
