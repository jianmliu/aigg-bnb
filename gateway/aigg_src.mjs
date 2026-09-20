// Register the gateway with ai.gg (aigg-src, a sub2api fork) as an upstream account, and keep it in step (docs/GATEWAY.md §5).
//
// ai.gg needs no code for this: the gateway is an `openai` / `apikey` account whose base_url is the gateway. What it does
// need is four things kept consistent, by hand or by this script:
//   a GROUP    platform openai -- a user's key is bound to a group, and the group's platform picks the protocol handler
//   an ACCOUNT credentials.base_url = the gateway, credentials.api_key = the gateway's bearer, and
//              credentials.model_mapping = every name the gateway answers to (its KEYS are what GET /v1/models lists).
//              extra.openai_passthrough = true, which is not a nicety: without it ai.gg DELETES max_output_tokens (the number
//              of steps), injects instructions, and turns the gateway's 503 model_cold / 504 no_result into a generic 502
//   a CHANNEL  one pricing row for those names, platform "openai" (it defaults to anthropic, and then never matches), in USD
//              per token, with restrict_models on: a model that is served but not priced would otherwise be billed at $0
//   the PRICE  ONE number, because the gateway counts everything in one unit. A token is `wei_per_token` of work: an
//              output token is a step of that brain under that stimulus set (a heavier brain and a stimulus that
//              ignites it cost MORE TOKENS, not a higher rate), an input token is the call's gas in the same unit. So
//              input_price = output_price = wei_per_token / 1e18 x AIGG_USD_PER_BNB x AIGG_MARGIN, for every model.
//              Pricing a model higher here as well would charge its factor twice.
// A newly registered fly is a new model: run this again (or on a timer) and it appears in ai.gg's /v1/models, priced.
//
//   node gateway/aigg_src.mjs plan     what would be sent, secrets redacted. Reads the gateway; reads ai.gg if it can
//   node gateway/aigg_src.mjs apply    create what is missing, update what differs
//
//   AIGG_URL            https://…  ai.gg's backend            AIGG_ADMIN_KEY   its admin API key (x-api-key). Secret
//   GATEWAY_URL         the gateway AS AI.GG REACHES IT (https, unless ai.gg allows insecure upstreams)
//   GATEWAY_BEARER      the gateway's bearer: becomes credentials.api_key. Secret
//   GATEWAY_LOCAL_URL   where THIS script reaches the gateway, if different (default GATEWAY_URL)
//   AIGG_USD_PER_BNB    required        AIGG_MARGIN (1.2)        AIGG_NAME (flybnb): the group's, account's and channel's name
//   AIGG_CONCURRENCY (8)   AIGG_PRIORITY (50)
// Verified against aigg-src's source (routes/admin.go, handler/admin/*, openai_gateway_service.go), and in
// test/aigg_src_sync.mjs against a stand-in built from it -- not against a running ai.gg: read `plan` before the first `apply`.
import crypto from "node:crypto";
const e = process.env; const cmd = process.argv[2] || "plan"; if (!["plan", "apply"].includes(cmd)) { console.log("usage: aigg_src.mjs plan | apply"); process.exit(2); }
const need = (k) => { if (!e[k]) { console.error(`missing ${k}`); process.exit(2); } return e[k]; }; const trim = (u) => u.replace(/\/+$/, "");
const GATEWAY = trim(need("GATEWAY_URL")), BEARER = need("GATEWAY_BEARER"), LOCAL = trim(e.GATEWAY_LOCAL_URL || GATEWAY); const NAME = e.AIGG_NAME || "flybnb";
const usdPerBnb = Number(need("AIGG_USD_PER_BNB")), margin = Number(e.AIGG_MARGIN || 1.2); if (!(usdPerBnb > 0) || !(margin > 0)) { console.error("AIGG_USD_PER_BNB and AIGG_MARGIN are positive numbers"); process.exit(2); }
if (!/^https:\/\//.test(GATEWAY)) console.error(`note: ${GATEWAY} is not https -- ai.gg refuses such an upstream unless security.url_allowlist.allow_insecure_http is set`);

// ---- what the gateway serves ----
const served = await (await fetch(LOCAL + "/v1/models", { headers: { authorization: "Bearer " + BEARER } })).json(); if (!Array.isArray(served.data)) { console.error("the gateway's /v1/models did not answer with a list:", JSON.stringify(served).slice(0, 200)); process.exit(1); }
const names = [...new Set(served.data.flatMap((m) => [m.id, ...(m.aliases || [])]))].sort(); if (!names.length) { console.error("the gateway serves no model: nothing to register"); process.exit(1); }
// What a run costs a host differs -- a heavier export is 1.54x, a stimulus that ignites the brain 9x a sparse one --
// and the gateway puts that difference in the TOKEN COUNT, not in the rate. So ai.gg gets one price for everything.
const usd = (wei) => Number((Number(BigInt(wei)) / 1e18 * usdPerBnb * margin).toPrecision(6));
const units = [...new Set(served.data.map((m) => String(m.wei_per_token)))];
if (units.length !== 1) { console.error(`the gateway reports more than one wei_per_token (${units.join(", ")}): a single price cannot bill them`); process.exit(1); }
const outputPrice = usd(units[0]);

const group = { name: NAME, description: "fly brains on the PoRW mesh, through the flybnb gateway", platform: "openai", rate_multiplier: 1.0, subscription_type: "standard", is_exclusive: false, require_oauth_only: false };
const account = (groupId) => ({ name: NAME + "-gateway", platform: "openai", type: "apikey", group_ids: [groupId], concurrency: Number(e.AIGG_CONCURRENCY || 8), priority: Number(e.AIGG_PRIORITY || 50), rate_multiplier: 1.0,
  // Update REPLACES credentials wholesale, so they are always sent whole. No custom error codes and no temp-unschedulable
  // rules: the gateway's 503 (cold model) and 504 (refunded) are answers, and must never take the account out of rotation.
  credentials: { base_url: GATEWAY, api_key: BEARER, model_mapping: Object.fromEntries(names.map((n) => [n, n])), pool_mode: false, custom_error_codes_enabled: false, temp_unschedulable_enabled: false },
  extra: { openai_passthrough: true } });
const channel = (groupId) => ({ name: NAME, description: "one token is a fixed unit of work: an output token is a step of that brain under that stimulus set, an input token the call's gas in the same unit", group_ids: [groupId], restrict_models: true, billing_model_source: "requested",
  model_pricing: [{ platform: "openai", models: names, billing_mode: "token", input_price: outputPrice, output_price: outputPrice, cache_read_price: 0 }] });
const redact = (o) => JSON.parse(JSON.stringify(o, (k, v) => (k === "api_key" ? "<GATEWAY_BEARER>" : v)));

console.log(`the gateway serves ${served.data.length} brain(s) under ${names.length} name(s); ${units[0]} wei a token x ${usdPerBnb} USD/BNB x ${margin} = ${outputPrice} USD per token, for every model:`);
for (const m of served.data) { const t = (m.tokens_per_step ?? 1) * 5000 * m.min_redundancy;
  console.log(`  ${m.id}  ${m.exec}  ${m.neurons} neurons  providers ${m.providers}${m.available ? "" : "  (cold)"}  ${m.tokens_per_step ?? 1} token(s) a step = ${Math.round(t)} tokens, ${(outputPrice * t).toPrecision(3)} USD for 5,000 steps at redundancy ${m.min_redundancy}`); }
{ const f = Object.entries(served.data[0]?.set_factors || {}); if (f.length) { const lo = f.reduce((a, b) => (a[1] < b[1] ? a : b)), hi = f.reduce((a, b) => (a[1] > b[1] ? a : b));
  console.log(`  and a named stimulus set multiplies the COUNT: ${lo[0]} x${lo[1]} … ${hi[0]} x${hi[1]}, so the same price bills a run that ignites the brain for what it costs`); } }

// ---- ai.gg's admin API: { code: 0, data } ; lists are data.items or data ----
const AIGG = e.AIGG_URL ? trim(e.AIGG_URL) : null; const KEY = e.AIGG_ADMIN_KEY || null;
if (cmd === "apply" && !(AIGG && KEY)) { console.error("apply needs AIGG_URL and AIGG_ADMIN_KEY"); process.exit(2); }
async function admin(method, path, body) {
  const r = await fetch(AIGG + "/api/v1/admin" + path, { method, headers: { "x-api-key": KEY, "content-type": "application/json", ...(method === "GET" ? {} : { "idempotency-key": crypto.randomUUID() }) }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({})); if (!r.ok || j.code !== 0) throw new Error(`${method} ${path}: HTTP ${r.status} ${j.message || ""} ${j.reason || ""}`.trim()); return j.data;
}
const items = (d) => (Array.isArray(d) ? d : d?.items || []);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
if (!(AIGG && KEY)) { console.log("\nno AIGG_URL / AIGG_ADMIN_KEY: this is what `apply` would create.\n"); console.log(JSON.stringify({ group, account: redact(account("<group id>")), channel: channel("<group id>") }, null, 1)); process.exit(0); }

const G = items(await admin("GET", "/groups/all")).find((g) => g.name === NAME && g.platform === "openai");
const A = G ? items(await admin("GET", `/accounts?platform=openai&type=apikey&search=${encodeURIComponent(NAME + "-gateway")}&page_size=100`)).find((a) => a.name === NAME + "-gateway") : null;
const C = items(await admin("GET", "/channels?page_size=100")).find((c) => c.name === NAME);
const wantA = account(G?.id ?? "<group id>"), wantC = channel(G?.id ?? "<group id>");
// what would change: the names served, the price, base_url, the bearer (rotated?), passthrough
const haveNames = A ? Object.keys(A.credentials?.model_mapping || {}).sort() : []; const wantRows = channel("").model_pricing.map((r) => [r.models.slice().sort().join("|"), r.output_price, r.input_price].join(" ")).sort().join(" ; ");
const haveRows = (C?.model_pricing || []).map((r) => [(r.models || []).slice().sort().join("|"), r.output_price, r.input_price].join(" ")).sort().join(" ; "); const haveModels = (C?.model_pricing?.[0]?.models || []).slice().sort();
const todo = { group: !G, account: !A ? "create" : (!same(haveNames, names) || A.credentials?.base_url !== GATEWAY || A.credentials?.api_key !== BEARER || A.extra?.openai_passthrough !== true) ? "update" : null, channel: !C ? "create" : (haveRows !== wantRows || C.restrict_models !== true) ? "update" : null };
console.log(`\nai.gg at ${AIGG}: group ${G ? "#" + G.id : "MISSING"} · account ${A ? "#" + A.id + (todo.account ? " (differs)" : "") : "MISSING"} · channel ${C ? "#" + C.id + (todo.channel ? " (differs)" : "") : "MISSING"}`);
if (A && !same(haveNames, names)) console.log(`  models: + ${names.filter((n) => !haveNames.includes(n)).join(", ") || "-"}   - ${haveNames.filter((n) => !names.includes(n)).join(", ") || "-"}`);
if (C && haveRows !== wantRows) console.log(`  prices: ${haveRows || "(none)"}\n       -> ${wantRows}`);
if (A && A.status && A.status !== "active") console.log(`  WARNING: the account's status is "${A.status}". A 401 from the gateway (a wrong bearer) marks an apikey account as errored for good: fix the bearer, then clear the error in ai.gg.`);
if (cmd === "plan") { if (!todo.group && !todo.account && !todo.channel) console.log("nothing to do."); else console.log("`apply` would: " + [todo.group && "create the group", todo.account && todo.account + " the account", todo.channel && todo.channel + " the channel"].filter(Boolean).join(", ") + "\n" + JSON.stringify({ ...(todo.group ? { group } : {}), ...(todo.account ? { account: redact(wantA) } : {}), ...(todo.channel ? { channel: wantC } : {}) }, null, 1)); process.exit(0); }

const g = G || await admin("POST", "/groups", group); if (!G) console.log(`created group #${g.id}`);
if (todo.account === "create") { const a = await admin("POST", "/accounts", account(g.id)); console.log(`created account #${a.id}`); }
else if (todo.account) { const w = account(g.id); await admin("PUT", `/accounts/${A.id}`, { name: w.name, type: w.type, credentials: w.credentials, extra: { ...(A.extra || {}), ...w.extra }, group_ids: w.group_ids, concurrency: w.concurrency, priority: w.priority }); console.log(`updated account #${A.id}`); }
if (todo.channel === "create") { const c = await admin("POST", "/channels", channel(g.id)); console.log(`created channel #${c.id}`); }
else if (todo.channel) { const w = channel(g.id); await admin("PUT", `/channels/${C.id}`, { name: w.name, group_ids: w.group_ids, model_pricing: w.model_pricing, restrict_models: true, billing_model_source: w.billing_model_source }); console.log(`updated channel #${C.id}`); }
if (!todo.group && !todo.account && !todo.channel) console.log("nothing to do.");
console.log(`\nnext: a user key bound to group #${g.id} (POST /api/v1/keys, the user's own call), then\n  curl ${AIGG}/v1/models -H "authorization: Bearer <that key>"   # lists: ${names.slice(0, 3).join(", ")}${names.length > 3 ? ", …" : ""}`);
