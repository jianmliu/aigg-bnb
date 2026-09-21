// The skill is a set of instructions an agent will follow without checking. So it is checked here.
//
// A document that tells an agent to run `node js/host.mjs` is worse than no document: the agent tries it, it is
// not there, and the agent improvises -- against a chain, with somebody's money. The same goes for a price that
// is off by a factor, a field name the gateway rejects, or a stimulus set that does not exist. Prose drifts from
// code silently and nothing notices, which is exactly the failure this repo keeps finding in other forms.
//
// So every file path, every route, every field name and every multiplier in skills/flybnb/SKILL.md is read out
// of the document and held against the thing it describes. Offline: no network, no chain, no key.
import fs from "node:fs"; import path from "node:path";
const root = path.join(import.meta.dirname, "..");
const read = (p) => { try { return fs.readFileSync(path.join(root, p), "utf8"); } catch { return ""; } }; // missing reads as empty: the checks below then FAIL rather than the suite crashing
let fails = 0; const check = (n, ok, note = "") => { console.log((ok ? "  ok   " : "  FAIL ") + n + (ok || !note ? "" : "  " + note)); if (!ok) fails++; };

// every js/ script that is a CLI at all: what "a terminal path exists" is decided from, in both directions below
const scriptsWithArgv = (fs.existsSync(path.join(import.meta.dirname, "../js")) ? fs.readdirSync(path.join(import.meta.dirname, "../js")) : [])
  .filter((f) => /\.(mjs|js)$/.test(f))
  .map((f) => ({ f, src: fs.readFileSync(path.join(import.meta.dirname, "../js", f), "utf8") }))
  .filter((x) => /process\.argv/.test(x.src));
const SKILL = "skills/flybnb/SKILL.md";
check("the skill exists", fs.existsSync(path.join(root, SKILL)));
if (!fs.existsSync(path.join(root, SKILL))) { console.log("1 FAILURES"); process.exit(1); }
const md = read(SKILL);
// prose wraps; an assertion about what the document SAYS must not depend on where a line broke
const prose = md.replace(/\s+/g, " ");

// ---- frontmatter: what makes it loadable at all ----
{ const fm = md.match(/^---\n([\s\S]*?)\n---\n/);
  check("it has frontmatter", !!fm);
  const name = fm?.[1].match(/^name:\s*(\S+)/m)?.[1];
  const desc = fm?.[1].match(/^description:\s*(.+)$/m)?.[1];
  check("named after its directory", name === "flybnb", String(name));
  check("the description says WHEN to use it, which is what it is matched on", !!desc && desc.length > 80 && /when/i.test(desc), desc?.slice(0, 60)); }

// ---- every repo file it names must exist ----
{ const cited = [...new Set([...md.matchAll(/(?:^|[\s`(])((?:js|test|flybnb|gateway|relayer|contracts|docs|frontend|battery|tasks)\/[A-Za-z0-9_./-]*\.(?:mjs|json|js|py|md|sol))/g)].map((m) => m[1]))];
  const missing = cited.filter((f) => !fs.existsSync(path.join(root, f.replace(/[.,)]+$/, ""))));
  check(`every repo file the skill names exists (${cited.length} cited)`, missing.length === 0, missing.join(" ")); }

// ---- the commands it tells an agent to run ----
{ // each of these is a real entry point; a script that has stopped taking these args is a trap
  const commands = [
    ["node js/fetch_brain.mjs", "js/fetch_brain.mjs"],
    ["node flybnb/analysis/phenotype_rank.mjs --check", "flybnb/analysis/phenotype_rank.mjs"],
    ["node flybnb/battery/post_battery.mjs", "flybnb/battery/post_battery.mjs"],
    ["node contracts/lib/aigg-porw/web/porw-browser/model_id.mjs", "contracts/lib/aigg-porw/web/porw-browser/model_id.mjs"],
    ["python flybnb/analysis/intlif.py --verify", "flybnb/analysis/intlif.py"],
  ];
  for (const [cmd, file] of commands) {
    check(`it tells the agent to run ${cmd.slice(0, 52)}…`, md.includes(cmd), "not in the skill");
    check(`  and ${file} is there`, fs.existsSync(path.join(root, file))); }
  // the flags it puts in those commands
  check("phenotype_rank really takes --check", /--check/.test(read("flybnb/analysis/phenotype_rank.mjs")));
  check("intlif really takes --verify and --min5", /--verify/.test(read("flybnb/analysis/intlif.py")) && /--min5/.test(read("flybnb/analysis/intlif.py")));
  for (const flag of ["--relayer", "--payload", "--name", "--fee", "--redundancy"])
    check(`post_battery really takes ${flag}`, read("flybnb/battery/post_battery.mjs").includes(flag)); }

// ---- the relayer routes it lists ----
{ const relayer = read("relayer/relayer.mjs");
  const routed = (p) => relayer.includes(`"${p}"`) || relayer.includes(`'${p}'`) || relayer.includes(`=== "${p}"`) || relayer.includes(p);
  for (const r of ["/deployment", "/meps", "/status", "/epoch", "/hosts", "/proof", "/flybnb/holders"]) {
    check(`the skill lists ${r}`, md.includes(r));
    check(`  and the relayer serves it`, routed(r), `${r} not found in relayer.mjs`); } }

// ---- the gateway's request shape: the part an agent cannot guess ----
{ const gw = read("gateway/gateway.mjs");
  for (const f of ["stimulate", "silence", "readout", "seed", "steps", "redundancy"]) {
    check(`the skill documents input.${f}`, new RegExp(`\`${f}\``).test(md));
    check(`  and the gateway reads it`, gw.includes(f)); }
  check("it warns that cell_type is rejected, because the gateway rejects it", /cell_type/.test(md) && /cell_type/.test(gw));
  check("it gives readout's real bounds", md.includes("1…1000") || md.includes("1 … 1000"));
  check("  which is the bound the gateway enforces", /readout\.top is 1 … 1000|top < 1 \|\| x\.readout\.top > 1000/.test(gw));
  check("it says fields inside `input` win over top-level ones", /inside `input`/.test(prose) && /win/.test(prose));
  check("  which is what the gateway does", /x\.steps \?\? body\.max_output_tokens/.test(gw));
  for (const r of ["/v1/responses", "/v1/models", "/v1/tasks/"]) check(`the gateway route ${r} is real`, md.includes(r) && gw.includes(r.replace(/\/$/, ""))); }

// ---- the refusal codes it teaches ----
{ const codes = ["model_cold", "epoch_cold", "gateway_unfunded", "invalid_request_error"];
  const gw = read("gateway/gateway.mjs") + read("gateway/capacity.mjs");
  for (const c of codes) { check(`the skill explains ${c}`, md.includes(c)); check(`  and the gateway can emit it`, gw.includes(c)); } }

// ---- the prices, which are the easiest thing to get wrong and the most expensive ----
{ const pricing = JSON.parse(read("gateway/pricing.json"));
  for (const [model, factor] of Object.entries(pricing.models))
    check(`the skill quotes ${model}'s real factor (${factor})`, new RegExp(`${model}\`? ${factor.toFixed(2)}|${model}\`? ${factor}`).test(md), `expected ${factor}`);
  const sets = Object.keys(pricing.sets);
  // Anchor on the ENUMERATION, not the document: `pheromone` also appears in the worked example, so a name dropped
  // from the list would otherwise be covered by a mention somewhere else and the agent would never learn it exists.
  const after = md.split(/Stimulus sets this deployment knows[^\n]*\n/)[1] || "";
  const enumeration = after.split(/\n\s*\n/).map((b) => b.trim()).find((b) => b.length > 0) || "";
  check("the skill enumerates the stimulus sets in one place", enumeration.length > 20, JSON.stringify(enumeration.slice(0, 40)));
  const listed = sets.filter((s) => new RegExp(`\`${s}\``).test(enumeration));
  check(`and that list is every set the gateway knows (${sets.length})`, listed.length === sets.length, `missing from the list: ${sets.filter((s) => !listed.includes(s)).join(" ")}`);
  const extra = [...enumeration.matchAll(/`([a-z_]+)`/g)].map((m) => m[1]).filter((n) => !sets.includes(n));
  check("and names no set the gateway does not know", extra.length === 0, extra.join(" "));
  const lo = Math.min(...Object.values(pricing.sets)), hi = Math.max(...Object.values(pricing.sets));
  check("and the real range of their multipliers", md.includes(String(lo)) && md.includes(String(hi)), `${lo} … ${hi}`);
  // The worked examples have to be arithmetic, not a vibe -- and the arithmetic has to be the GATEWAY's. It rounds
  // (gateway.mjs:111), and 100 x 2 x 1.00 x 0.55 is 110.00000000000001 in binary floating point: a test that
  // compared floats would fail on a correct document, and a document that wrote the float would be absurd.
  const tokensFor = (steps, redundancy, model, set) => Math.max(1, Math.round(steps * redundancy * model * set));
  const bnb = (t) => String(t * 1e11 / 1e18);
  const comma = (n) => n.toLocaleString("en-US");
  { const t = tokensFor(100, 2, pricing.models["flywire-783-min5"], pricing.sets.sound);
    check("the worked example's token count is the formula's answer", t === 110 && md.includes(`${t} tokens`), `formula gives ${t}`);
    check("and its BNB figure follows from 1e11 wei per token", md.includes(`${bnb(t)} BNB`), `${bnb(t)} BNB`); }
  { const t = tokensFor(5000, 2, pricing.models["flywire-783-min2"], pricing.sets.pheromone);
    check("the battery-scale example too", (md.includes(comma(t)) || md.includes(String(t))) && md.includes(bnb(t)), `${comma(t)} tokens = ${bnb(t)} BNB`); } }

{ // the unit itself: 100 gwei. The label was wrong in the docs once, by three orders of magnitude.
  const env = read("gateway/gateway.mjs");
  check("the skill's wei_per_token matches the gateway's default", md.includes("1e11 wei") && /100000000000/.test(env), "GATEWAY_WEI_PER_STEP");
  check("and it is labelled in the right unit (100 gwei, not 0.1)", md.includes("100 gwei")); }

// ---- the honesty requirements: the reason this skill is trustworthy at all ----
const browserOnly = (md.split(/^## What has no terminal path$/m)[1] || "").split(/^## /m)[0] || "";
{ // Whatever the skill lists as browser-only must BE browser-only, and anything with a command must not be listed
  // there. The four owner operations moved from one side to the other the day js/fly.mjs landed, and this is what
  // made that show up as a failure rather than as a document quietly telling agents the wrong thing.
  const listed = [...browserOnly.matchAll(/\*\*([a-z][a-z ]*?)\*\*/g)].map((m) => m[1].trim());
  check("the browser-only section, if it exists, names what is in it", !/^## What has no terminal path$/m.test(md) || listed.length > 0, JSON.stringify(browserOnly.slice(0, 60)));
  for (const op of listed) {
    const offered = scriptsWithArgv.filter((x) => new RegExp(`case "${op}"`).test(x.src)).map((x) => `js/${x.f}`);
    check(`  "${op}" really has no command`, offered.length === 0, `${offered.join(" ")} offers it`); }
  // if a CLI for any of them ever lands, this test should fail so the skill gets updated rather than going stale
  // A filename proves nothing in either direction: js/breed_recipe.mjs is named for one of these and is a library,
  // and js/fly.mjs is named for none of them and does all four. So this looks for the CAPABILITY -- a script that
  // reads argv and offers the operation as a command -- and the skill must then not still be calling it impossible.
  const scripts = scriptsWithArgv;
  for (const op of ["adopt", "breed", "hatch", "withdraw"]) {
    const offered = scripts.filter((x) => new RegExp(`case "${op}"|"${op}"\\s*:|--${op}\\b`).test(x.src)).map((x) => `js/${x.f}`);
    const impossible = new RegExp(`\\*\\*${op}\\*\\*[^\\n]*`, "i").test(browserOnly);
    check(`${op}: what the skill says matches what exists`, offered.length === 0 ? impossible : !impossible,
      offered.length ? `${offered.join(" ")} offers it, but the skill still lists it as browser-only` : `nothing offers it, and the skill must say so`);
    if (offered.length) check(`  and the skill names the command`, new RegExp(`node ${offered[0].replace("/", "\\/")}`).test(md), `expected \`node ${offered[0]}\` in the skill`); }
  check("it says the headless host is a reference, not a product", /reference implementation, not a product/.test(prose));
  check("  and test/live_bsc.mjs is still what it points at", fs.existsSync(path.join(root, "test/live_bsc.mjs")));
  check("it forbids printing private keys", /[Nn]ever print.*private key/.test(prose));
  check("it requires confirming a spend", /[Cc]onfirm with the user/.test(prose));
  check("it requires quoting the price before spending", /[Qq]uote the price before/.test(prose)); }

console.log(fails ? `${fails} FAILURES` : "flybnb skill: all checks passed");
process.exit(fails ? 1 : 0);
