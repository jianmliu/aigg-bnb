// A URL that cannot go stale.
//
// The page loads three kinds of thing the bundler does not own: the aigg-porw modules under /porw/, two noble
// packages under /vendor/, and the module worker itself. All three shipped at fixed URLs, and a fixed URL for a
// file that changes is a version-skew bug waiting for a cache to fire it. `_headers` asked for five minutes of
// freshness; on the deployed domain the zone's Browser Cache TTL raised that to four hours (measured 2026-09-20:
// `max-age=14400` on fly.ai.gg, `max-age=300` on *.pages.dev), and a real tab then ran a four-hour-old worker
// against a minutes-old bundle and hung with no error.
//
// The fix is not a shorter lifetime, it is a name: the directory is called after everything in it. What this test
// pins is the property that makes that work -- the id is a function of the bytes AND of the paths they are served
// at, it is stable when nothing changes, and it moves when anything does. If any of that stops being true, the
// stale URL becomes possible again.
import fs from "node:fs"; import path from "node:path"; import os from "node:os";
import { runtimeId, runtimeFiles, runtimePrefixes, withRuntimeId, workerName, rewriteBareImports } from "../frontend/build/runtime.mjs";
let fails = 0; const check = (n, ok, note = "") => { console.log((ok ? "  ok   " : "  FAIL ") + n + (ok || !note ? "" : "  " + note)); if (!ok) fails++; };

const repo = path.join(import.meta.dirname, "..");

// ---- the id, over the real runtime ----
const id = runtimeId(repo);
check("the runtime has a name", /^[0-9a-f]{10}$/.test(id), id);
check("computing it twice gives the same name", runtimeId(repo) === id);
check("it covers every servable file", runtimeFiles(repo).length >= 80, `${runtimeFiles(repo).length} files`);
check("and only files a browser can load", runtimeFiles(repo).every((f) => /\.(js|mjs|wasm|json)$/.test(f.url)));

// ---- it moves when anything moves ----
// a copy of the runtime we can edit: same shape, so the same functions apply
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-id-"));
const mirror = (from, to) => { for (const e of fs.readdirSync(from, { withFileTypes: true })) {
  if (e.name === "node_modules" || e.name.startsWith(".")) continue;
  const s = path.join(from, e.name), d = path.join(to, e.name);
  if (e.isDirectory()) { fs.mkdirSync(d, { recursive: true }); mirror(s, d); } else { fs.mkdirSync(to, { recursive: true }); fs.copyFileSync(s, d); } } };
for (const sub of ["contracts/lib/aigg-porw/web/porw-browser", "node_modules/@noble/hashes", "node_modules/@noble/secp256k1"]) {
  fs.mkdirSync(path.join(tmp, sub), { recursive: true }); mirror(path.join(repo, sub), path.join(tmp, sub));
}
const base = runtimeId(tmp);
check("the copy has the same name as what it copied", base === id, `${base} vs ${id}`);

const victim = path.join(tmp, "contracts/lib/aigg-porw/web/porw-browser/verify.js");
const original = fs.readFileSync(victim);
{ fs.writeFileSync(victim, Buffer.concat([original, Buffer.from("\n// one byte of drift\n")]));
  check("ONE changed byte in one module renames the whole runtime", runtimeId(tmp) !== base, runtimeId(tmp));
  fs.writeFileSync(victim, original);
  check("and putting it back restores the old name", runtimeId(tmp) === base); }

{ // a file that moves is a different runtime even though every byte is the same
  const moved = path.join(tmp, "contracts/lib/aigg-porw/web/porw-browser/verify2.js");
  fs.renameSync(victim, moved);
  check("a file served at a different path renames it too", runtimeId(tmp) !== base);
  fs.renameSync(moved, victim); }

{ // the wasm kernel is not JavaScript and is the one file whose staleness would be silent
  const wasm = path.join(tmp, "contracts/lib/aigg-porw/web/porw-browser/sketch.wasm");
  const before = fs.readFileSync(wasm); const b = Buffer.from(before); b[b.length - 1] ^= 1;
  fs.writeFileSync(wasm, b);
  check("a changed kernel renames it: the wasm counts, not just the .js", runtimeId(tmp) !== base);
  fs.writeFileSync(wasm, before); }

{ // a file the browser cannot load is repo furniture and must not churn the name on every commit
  fs.writeFileSync(path.join(tmp, "contracts/lib/aigg-porw/web/porw-browser/notes.md"), "# not servable\n");
  check("a non-servable file does not rename it", runtimeId(tmp) === base); }
fs.rmSync(tmp, { recursive: true, force: true });

// ---- what the id is used for ----
{ const p = runtimePrefixes(id);
  check("the prefixes carry the id", p["/porw/"] === `/porw.${id}/` && p["/vendor/"] === `/vendor.${id}/`);
  const code = 'import x from "/porw/verify.js"; const w = "/vendor/@noble/hashes/sha3.js";';
  const out = withRuntimeId(code, id);
  check("rewriting a chunk leaves no unhashed prefix", !/["'/]\/porw\/|["'/]\/vendor\//.test(out) && out.includes(`/porw.${id}/verify.js`), out);
  check("rewriting is idempotent", withRuntimeId(out, id) === out); }

{ // the bare specifier rewrite has to land on the SAME vendor directory the files were copied to
  const src = 'import { sha3 } from "@noble/hashes/sha3.js"; import * as s from "@noble/secp256k1";';
  const out = rewriteBareImports(src, `/vendor.${id}/`);
  check("@noble specifiers are rewritten to the hashed vendor prefix",
    out.includes(`/vendor.${id}/@noble/hashes/sha3.js`) && out.includes(`/vendor.${id}/@noble/secp256k1/index.js`), out);
  check("and none is left bare", !/["']@noble\//.test(out), out); }

{ // the worker is named after what it says, which includes which runtime it talks to
  const src = fs.readFileSync(path.join(repo, "frontend/public/node_worker.js"), "utf8");
  const a = workerName(src, id), b = workerName(src, "0000000000");
  check("the worker's name is stable for the same input", workerName(src, id).name === a.name);
  check("a different runtime gives the worker a different name", a.name !== b.name, `${a.name} vs ${b.name}`);
  check("its code points at this runtime and nowhere else", a.code.includes(`/porw.${id}/`) && !a.code.includes('"/porw/'));
  check("the name is the hashed form", /^node_worker\.[0-9a-f]{10}\.js$/.test(a.name), a.name); }

console.log(fails ? `${fails} FAILURES` : "runtime id: all checks passed");
process.exit(fails ? 1 : 0);
