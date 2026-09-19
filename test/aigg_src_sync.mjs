// gateway/aigg_src.mjs against a stand-in for ai.gg's admin API, built from aigg-src's source (routes/admin.go, the
// handlers' DTOs, response.Success's { code, message, data } envelope, x-api-key auth, Idempotency-Key on writes) and a
// stand-in gateway. No chain. What is pinned here is what goes wrong silently if it drifts:
//   - openai_passthrough is on (without it ai.gg deletes max_output_tokens and flattens 503/504 into 502)
//   - the pricing row says platform "openai" (the default, anthropic, never matches) and restrict_models is on (else: $0)
//   - the price is wei_per_step x USD/BNB x margin, per token = per step per provider
//   - model_mapping's keys are every name the gateway answers to; a newly registered fly shows up on the next run
//   - an update sends the credentials WHOLE (ai.gg replaces them), and neither secret is ever printed
import http from "node:http"; import { spawn } from "node:child_process"; import path from "node:path"; import { fileURLToPath } from "node:url";
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), ".."); let fails = 0; const check = (n, ok, note = "") => { console.log((ok ? "  ok   " : "  FAIL ") + n + (ok || !note ? "" : "  " + note)); if (!ok) fails++; };
const ADMIN_KEY = "admin-" + "k".repeat(24), BEARER = "bearer-" + "b".repeat(24);
const listen = (handler) => new Promise((res) => { const s = http.createServer(handler).listen(0, "127.0.0.1", () => res({ s, url: "http://127.0.0.1:" + s.address().port })); });
const body = (req) => new Promise((res) => { let t = ""; req.on("data", (d) => (t += d)); req.on("end", () => res(t ? JSON.parse(t) : null)); });

// ---- the gateway ----
const models = [{ id: "flywire-783-min5", aliases: ["mep:0x31"], exec: "int-lif", neurons: 139255, providers: 3, available: true, min_redundancy: 2, wei_per_step: "100000000000" },
  { id: "flywire-783-min2", aliases: ["mep:0x79"], exec: "int-lif", neurons: 139255, providers: 0, available: false, min_redundancy: 2, wei_per_step: "100000000000" }];
const gw = await listen((req, res) => { if (req.headers.authorization !== "Bearer " + BEARER) { res.writeHead(401); return res.end("{}"); } res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ object: "list", data: models })); });

// ---- ai.gg's admin API ----
const db = { groups: [], accounts: [], channels: [] }; const writes = []; let nextId = 1;
const aigg = await listen(async (req, res) => {
  const send = (status, data, message = "success") => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(status < 300 ? { code: 0, message, data } : { code: status, message })); };
  if (req.headers["x-api-key"] !== ADMIN_KEY) return send(401, null, "unauthorized"); const u = new URL(req.url, "http://x"); const p = u.pathname.replace("/api/v1/admin", ""); const b = await body(req);
  if (req.method !== "GET") { if (!req.headers["idempotency-key"]) return send(400, null, "idempotency key required"); writes.push({ method: req.method, path: p, body: b }); }
  if (req.method === "GET" && p === "/groups/all") return send(200, db.groups);
  if (req.method === "GET" && p === "/accounts") return send(200, { items: db.accounts.filter((a) => a.name.includes(u.searchParams.get("search") || "")), total: db.accounts.length, page: 1, page_size: 100, pages: 1 });
  if (req.method === "GET" && p === "/channels") return send(200, { items: db.channels, total: db.channels.length, page: 1, page_size: 100, pages: 1 });
  const m = /^\/(groups|accounts|channels)(?:\/(\d+))?$/.exec(p); if (!m) return send(404, null, "not found");
  if (req.method === "POST") { if (m[1] === "channels" && b.model_pricing.some((r) => !r.platform)) b.model_pricing.forEach((r) => (r.platform ||= "anthropic")); const row = { id: nextId++, status: "active", ...b }; db[m[1]].push(row); return send(201, row); }
  if (req.method === "PUT") { const row = db[m[1]].find((x) => x.id === Number(m[2])); if (!row) return send(404, null, "not found"); Object.assign(row, b); return send(200, row); } // `credentials` is REPLACED, as in aigg-src
  send(405, null, "method");
});

// asynchronously: the stand-ins live in THIS process, and a spawnSync would stop them answering the script it is waiting for
const run = (cmd, env = {}) => new Promise((res) => { const c = spawn(process.execPath, [path.join(root, "gateway/aigg_src.mjs"), cmd], { env: { PATH: process.env.PATH, GATEWAY_URL: "https://gateway.example", GATEWAY_LOCAL_URL: gw.url, GATEWAY_BEARER: BEARER, AIGG_USD_PER_BNB: "600", AIGG_MARGIN: "1.25", ...env } });
  let out = ""; c.stdout.on("data", (d) => (out += d)); c.stderr.on("data", (d) => (out += d)); c.on("exit", (code) => res({ code, out })); });
const online = { AIGG_URL: aigg.url, AIGG_ADMIN_KEY: ADMIN_KEY }; const PRICE = 1e11 / 1e18 * 600 * 1.25; // 7.5e-5 USD per step per provider

{ const r = await run("plan"); check("plan with no ai.gg to talk to prints what apply would create, and exits 0", r.code === 0 && /"openai_passthrough": true/.test(r.out) && /"platform": "openai"/.test(r.out) && /7\.5e-05|0\.000075/.test(r.out));
  check("with the bearer redacted", !r.out.includes(BEARER) && /<GATEWAY_BEARER>/.test(r.out)); }
{ const r = await run("plan", online); check("plan against an empty ai.gg: everything is MISSING, and nothing is written", r.code === 0 && /group MISSING · account MISSING · channel MISSING/.test(r.out) && writes.length === 0); }
{ const r = await run("apply", online); const [g] = db.groups, [a] = db.accounts, [c] = db.channels;
  check("apply creates the group (openai), the account and the channel", r.code === 0 && db.groups.length === 1 && db.accounts.length === 1 && db.channels.length === 1 && g.platform === "openai" && g.require_oauth_only === false, r.out.slice(-300));
  check("the account is an openai/apikey upstream at the gateway's PUBLIC url, holding the bearer, in the group", a.platform === "openai" && a.type === "apikey" && a.credentials.base_url === "https://gateway.example" && a.credentials.api_key === BEARER && a.group_ids[0] === g.id);
  check("passthrough is ON, and no rule can take the account out of rotation for a 503 or a 504", a.extra.openai_passthrough === true && a.credentials.custom_error_codes_enabled === false && a.credentials.temp_unschedulable_enabled === false && a.credentials.pool_mode === false);
  check("model_mapping's keys are every name the gateway answers to: that is what ai.gg's /v1/models lists", JSON.stringify(Object.keys(a.credentials.model_mapping)) === JSON.stringify(["flywire-783-min2", "flywire-783-min5", "mep:0x31", "mep:0x79"]) && Object.entries(a.credentials.model_mapping).every(([k, v]) => k === v));
  const row = c.model_pricing[0];
  check(`the pricing row is platform "openai", token mode, ${PRICE} USD per output token, input free`, c.model_pricing.length === 1 && row.platform === "openai" && row.billing_mode === "token" && Math.abs(row.output_price - PRICE) < 1e-12 && row.input_price === 0 && row.models.length === 4);
  check("restrict_models is on: a served model with no price would be billed at $0", c.restrict_models === true && c.group_ids[0] === g.id);
  check("every write carried an Idempotency-Key, and neither secret reached the output", writes.length === 3 && !r.out.includes(BEARER) && !r.out.includes(ADMIN_KEY)); }
{ const n = writes.length; const r = await run("apply", online); check("a second apply has nothing to do", r.code === 0 && /nothing to do/.test(r.out) && writes.length === n); }
{ models.push({ id: "fly-17", aliases: ["mep:0xf1"], exec: "int-lif", neurons: 139255, providers: 1, available: false, min_redundancy: 2, wei_per_step: "100000000000" }); const n = writes.length;
  const p = await run("plan", online); check("a newly registered fly: plan names it and writes nothing", /\+ fly-17, mep:0xf1/.test(p.out) && writes.length === n);
  const r = await run("apply", { ...online, AIGG_USD_PER_BNB: "700" }); const a = db.accounts[0], c = db.channels[0];
  check("apply updates the account -- credentials sent WHOLE, because ai.gg replaces them -- and the channel, at the new price", r.code === 0 && writes.length === n + 2 && writes.at(-2).method === "PUT" && a.credentials.api_key === BEARER && a.credentials.base_url === "https://gateway.example" && "fly-17" in a.credentials.model_mapping && c.model_pricing[0].models.includes("fly-17") && Math.abs(c.model_pricing[0].output_price - 1e-7 * 700 * 1.25) < 1e-12 && a.extra.openai_passthrough === true); }
{ db.accounts[0].status = "error"; const r = await run("plan", online); check("an account ai.gg has marked errored (a 401: a wrong bearer) is called out", /status is "error"/.test(r.out)); }
{ const r = await run("apply", { ...online, AIGG_ADMIN_KEY: "wrong" }); check("a wrong admin key fails loudly and writes nothing", r.code !== 0 && /HTTP 401/.test(r.out)); }
gw.s.close(); aigg.s.close(); console.log(fails ? `${fails} FAILURES` : "aigg-src sync: all checks passed"); process.exit(fails ? 1 : 0);
