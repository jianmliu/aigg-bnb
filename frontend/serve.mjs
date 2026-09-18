// Static server for the frontend: this directory, the aigg-porw browser modules under /porw/, and the two noble
// packages under /vendor/.
//
// No COOP/COEP. Those headers exist to unlock SharedArrayBuffer, and nothing here uses shared memory: the node
// runs in a plain worker with the single-memory kernel. Sending them anyway would cost real things -- every
// cross-origin resource would have to be CORS or CORP clean, including a brain fetched from a storage provider --
// in exchange for a capability the page does not use. Putting the multi-threaded kernel back means taking them
// back on, deliberately.
//
// Bare specifiers (`@noble/...`) are rewritten to /vendor/ paths as the modules are served. An import map in the
// document would have covered the page, but a module worker does not inherit the document's import map, and the
// node runs in one. Rewriting covers both, and it is what the Pages build does when it copies these files.
//   node frontend/serve.mjs [--port 8790] [--payload file.bin]   (payload served at /payload.bin for local demos)
import fs from "node:fs"; import http from "node:http"; import path from "node:path"; import { fileURLToPath } from "node:url";
const here = path.dirname(fileURLToPath(import.meta.url)); const root = path.join(here, "..");
const a = Object.fromEntries(process.argv.slice(2).reduce((acc, v, i, arr) => { if (v.startsWith("--")) acc.push([v.slice(2), arr[i + 1]]); return acc; }, []));
const MIME = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".wasm": "application/wasm", ".json": "application/json", ".bin": "application/octet-stream" };
const ISO = {};
const roots = [["/porw/", path.join(root, "contracts/lib/aigg-porw/web/porw-browser")], ["/vendor/", path.join(root, "node_modules")], ["/", here]];
/** the one transformation between the repo and what a browser can load */
export const rewriteBareImports = (src) => String(src)
  .replace(/(['"])@noble\/secp256k1\1/g, '"/vendor/@noble/secp256k1/index.js"')
  .replace(/(['"])@noble\//g, '"/vendor/@noble/');
export function startFrontend(port = Number(a.port || 0), { payload = a.payload ? fs.readFileSync(a.payload) : null, payloads = {} } = {}) {
  if (payload) payloads["/payload.bin"] = payload;
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, "http://x"); let p = decodeURIComponent(u.pathname); if (p === "/") p = "/index.html";
    if (payloads[p]) { res.writeHead(200, { ...ISO, "content-type": "application/octet-stream" }); return res.end(Buffer.from(payloads[p])); }
    if (p === "/favicon.ico") { res.writeHead(204); return res.end(); }
    for (const [prefix, dir] of roots) { if (!p.startsWith(prefix)) continue; const f = path.join(dir, p.slice(prefix.length)); if (!f.startsWith(dir) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) break;
      const type = MIME[path.extname(f)] || "application/octet-stream";
      const body = type === "text/javascript" ? Buffer.from(rewriteBareImports(fs.readFileSync(f, "utf8"))) : fs.readFileSync(f);
      res.writeHead(200, { ...ISO, "content-type": type }); return res.end(body); }
    res.writeHead(404); res.end();
  });
  return new Promise((r) => server.listen(port, "127.0.0.1", () => r({ server, port: server.address().port, url: `http://127.0.0.1:${server.address().port}` })));
}
if (import.meta.url === `file://${process.argv[1]}`) { const s = await startFrontend(); console.log(`frontend at ${s.url}`); }
