// Static server for the frontend: serves this directory, the aigg-porw browser modules under /porw/, and
// node_modules (noble) — with COOP/COEP so the node's shared-memory workers are available.
//   node frontend/serve.mjs [--port 8790] [--payload file.bin]   (payload served at /payload.bin for local demos)
import fs from "node:fs"; import http from "node:http"; import path from "node:path"; import { fileURLToPath } from "node:url";
const here = path.dirname(fileURLToPath(import.meta.url)); const root = path.join(here, "..");
const a = Object.fromEntries(process.argv.slice(2).reduce((acc, v, i, arr) => { if (v.startsWith("--")) acc.push([v.slice(2), arr[i + 1]]); return acc; }, []));
const MIME = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".wasm": "application/wasm", ".json": "application/json", ".bin": "application/octet-stream" };
const ISO = { "cross-origin-opener-policy": "same-origin", "cross-origin-embedder-policy": "require-corp" };
const roots = [["/porw/", path.join(root, "contracts/lib/aigg-porw/web/porw-browser")], ["/node_modules/", path.join(root, "node_modules")], ["/", here]];
export function startFrontend(port = Number(a.port || 0), { payload = a.payload ? fs.readFileSync(a.payload) : null, payloads = {} } = {}) {
  if (payload) payloads["/payload.bin"] = payload;
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, "http://x"); let p = decodeURIComponent(u.pathname); if (p === "/") p = "/index.html";
    if (payloads[p]) { res.writeHead(200, { ...ISO, "content-type": "application/octet-stream" }); return res.end(Buffer.from(payloads[p])); }
    if (p === "/favicon.ico") { res.writeHead(204); return res.end(); }
    for (const [prefix, dir] of roots) { if (!p.startsWith(prefix)) continue; const f = path.join(dir, p.slice(prefix.length)); if (!f.startsWith(dir) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) break;
      res.writeHead(200, { ...ISO, "content-type": MIME[path.extname(f)] || "application/octet-stream" }); return res.end(fs.readFileSync(f)); }
    res.writeHead(404); res.end();
  });
  return new Promise((r) => server.listen(port, "127.0.0.1", () => r({ server, port: server.address().port, url: `http://127.0.0.1:${server.address().port}` })));
}
if (import.meta.url === `file://${process.argv[1]}`) { const s = await startFrontend(); console.log(`frontend at ${s.url}`); }
