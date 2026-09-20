// render.yaml is the one tracked file that says which contracts the hosted relayer serves, and the one tracked file
// an operator edits with a key file open in the next window. So it is checked, without a chain and without a YAML
// parser (the file is flat enough to read line by line): no secret has a value, nothing in it looks like a private
// key, and the brains it names are brains this repository knows under the scheme main implements.
import fs from "node:fs"; import path from "node:path"; import { fileURLToPath } from "node:url";
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
let fails = 0; const check = (n, ok, note = "") => { console.log((ok ? "  ok   " : "  FAIL ") + n + (ok || !note ? "" : "  " + note)); if (!ok) fails++; };

const lines = fs.readFileSync(path.join(root, "render.yaml"), "utf8").split("\n").filter((l) => !/^\s*#/.test(l));
// one map per service: the relayer and the gateway both have PORW_* keys, and a flat map would let one hide the other
const services = new Map(); let cur = null; // name -> { vars: Map(key -> { value } | { raw }), lines }
for (let i = 0; i < lines.length; i++) {
  if (/^\s*- type:/.test(lines[i])) { cur = { vars: new Map(), lines: [] }; continue; } if (!cur) continue; cur.lines.push(lines[i]);
  const n = /^\s{4}name:\s*(\S+)\s*$/.exec(lines[i]); if (n) services.set(n[1], cur);
  const k = /^\s*- key:\s*(\S+)\s*$/.exec(lines[i]); if (!k) continue; const next = (lines[i + 1] || "").trim(); const v = /^value:\s*"?(.*?)"?$/.exec(next); cur.vars.set(k[1], v ? { value: v[1] } : { raw: next });
}
const R = services.get("aigg-bnb-relayer-testnet"), GW = services.get("aigg-bnb-gateway-testnet"); const vars = R.vars; // the checks below are the relayer's
const all = [...services.values()].flatMap((x) => [...x.vars]);

const SECRET = ["PORW_RELAYER_KEY", "PORW_DEPLOYER_KEY", "PORW_RPC", "GATEWAY_KEY", "GATEWAY_BEARER"];
for (const [name, sv] of services) for (const k of SECRET) if (sv.vars.has(k)) check(`${name}: ${k} carries no value (sync: false)`, sv.vars.get(k).raw === "sync: false", JSON.stringify(sv.vars.get(k)));
check("the relayer key is declared, so a fresh Blueprint asks for it", vars.has("PORW_RELAYER_KEY"));
check("no key named *_KEY or *_BEARER has a value, in any service", all.every(([k, v]) => !/_(KEY|BEARER)$/.test(k) || v.value === undefined));
// the brains this repository knows: the gate task's profiles, the base the genesis collection's founders are variants of,
// and the male base (another connectome, and the first brain here whose exec kind is not FlyWire's weight unit)
const known = new Map(); const fieldsIn = (dir, pick = () => true) => { for (const f of fs.readdirSync(dir).filter(pick)) { const j = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")); known.set(j.mepId.toLowerCase(), j); } };
fieldsIn(path.join(root, "tasks/flywire-gate/fields")); fieldsIn(path.join(root, "flybnb/genesis"), (f) => /^flywire-.*\.v\d+\.json$/.test(f)); fieldsIn(path.join(root, "flybnb/male"), (f) => /^malecns-.*\.v\d+\.json$/.test(f));
// a 32-byte hex value is a private key unless it is one of the ids this file is allowed to carry
const ids = new Set((vars.get("PORW_MEP_IDS")?.value || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean));
const stray = lines.join("\n").match(/0x[0-9a-fA-F]{64}\b/g)?.filter((h) => !known.has(h.toLowerCase())) || [];
check("every 32-byte hex string in the file is the MEP id of a profile this repository knows", stray.length === 0, stray.map((h) => h.slice(0, 10) + "…").join(" "));

const ADDR = ["PORW_VERIFIER", "PORW_MEP_REGISTRY", "PORW_INSTANCES", "PORW_BEACON", "PORW_CLAIMS", "PORW_MARKET", "PORW_DISPUTES", "PORW_RELAYS"];
check("all eight contract addresses are present and are addresses", ADDR.every((k) => /^0x[0-9a-fA-F]{40}$/.test(vars.get(k)?.value || "")), ADDR.filter((k) => !/^0x[0-9a-fA-F]{40}$/.test(vars.get(k)?.value || "")).join(" "));
check("and are eight different contracts", new Set(ADDR.map((k) => vars.get(k)?.value.toLowerCase())).size === 8);

// the brains: each id it serves is the id of a fields file under the scheme the pinned aigg-porw implements
const mesh = fs.readFileSync(path.join(root, "contracts/lib/aigg-porw/contracts/evm/src/interfaces/PorwMesh.sol"), "utf8");
const schemes = [...mesh.matchAll(/SCHEME_SKETCH_TILE_KECCAK_V(\d+) = (0x[0-9a-f]{64})/g)].sort((a, b) => Number(b[1]) - Number(a[1]));
const current = schemes[0][2];
check(`it serves at least one brain, pinned or through a whitelist`, ids.size > 0 || vars.has("PORW_WHITELIST"));
for (const id of ids) { const j = known.get(id); check(`${id.slice(0, 12)}… is a known profile under the current scheme (v${schemes[0][1]})`, !!j && j.schemeDigest.toLowerCase() === current, j ? `fields file says scheme ${j.schemeDigest.slice(0, 10)}…` : "no fields file has this mepId"); }
// a name may be for a pinned brain, or for one that arrives through the whitelist (a collection's base): either way a known profile
const names = vars.get("PORW_MEP_NAMES")?.value; if (names) check("every name is for a known profile under the current scheme", names.split(",").every((kv) => known.get(kv.split("=")[0].trim().toLowerCase())?.schemeDigest.toLowerCase() === current));
// the whitelist and the collection are contracts of this deployment too: addresses, and none of them the same as another
const MORE = ["PORW_WHITELIST", "PORW_COLLECTION"].filter((k) => vars.has(k));
check(`${MORE.join(" and ") || "no whitelist or collection"}: addresses, distinct from the mesh's`, MORE.every((k) => /^0x[0-9a-fA-F]{40}$/.test(vars.get(k).value || "")) && new Set([...ADDR, ...MORE].map((k) => vars.get(k)?.value.toLowerCase())).size === 8 + MORE.length);
if (vars.has("PORW_COLLECTION")) { const g = JSON.parse(fs.readFileSync(path.join(root, "flybnb/genesis/genesis-v1.json"), "utf8")); const base = [...known.values()].find((j) => j.modelId.toLowerCase() === g.baseModelId.toLowerCase() && j.schemeDigest.toLowerCase() === current);
  check("the genesis set's base brain has a profile here under the current scheme (what BASE_MEP_FEMALE has to be)", !!base, g.baseModelId); }

// a brain is content addressed, so a mirror is trusted for nothing -- but a page on https cannot fetch from http,
// and a mirror that silently never works is worse than none: the storage provider's quota drains behind it
{ const mirrors = (vars.get("PORW_BRAIN_MIRRORS")?.value || "").split(",").map((s) => s.trim()).filter(Boolean);
  if (mirrors.length) check(`every brain mirror is https (${mirrors.length})`, mirrors.every((m) => m.startsWith("https://")), mirrors.join(" "));
  else console.log("         no brain mirrors: every host pulls each base from the storage provider the MEP names"); }

check("never the free plan: a sleeping relayer stalls the mesh", !lines.some((l) => /^\s*plan:\s*free\s*$/.test(l)));

// ---- the gateway ----
check("the task clients are addresses, the project's first", (vars.get("PORW_TASK_CLIENTS")?.value || "").split(",").every((a) => /^0x[0-9a-fA-F]{40}$/.test(a.trim())));
if (GW) {
  const g = GW.vars; const val = (k) => g.get(k)?.value;
  check("the gateway's three secrets are declared, so a fresh service asks for them", ["GATEWAY_KEY", "GATEWAY_BEARER", "PORW_RPC"].every((k) => g.get(k)?.raw === "sync: false"));
  check("its deployment is the relayer's, contract by contract: it refuses to start if the relayer disagrees on the market", [...ADDR, "PORW_CHAIN_ID"].every((k) => (val(k) || "").toLowerCase() === (vars.get(k)?.value || "").toLowerCase() && val(k)));
  const relayerUrl = (vars.get("PORW_PUBLIC_RELAY_URL")?.value || "").replace(/^wss:/, "https:").replace(/\/relay$/, "");
  check(`it talks to that relayer (${relayerUrl})`, val("GATEWAY_RELAYER") === relayerUrl);
  check("it listens on every interface, as a hosted web service must", val("GATEWAY_HOST") === "0.0.0.0");
  const mount = (GW.lines.find((l) => /^\s*mountPath:/.test(l)) || "").split(":")[1]?.trim();
  check(`its calls are on a disk (${mount}): a fee spent at postTask must outlive a redeploy`, !!mount && (val("GATEWAY_STATE") || "").startsWith(mount + "/"));
  const models = (val("GATEWAY_MODELS") || "").split(",").map((kv) => kv.split("=").map((x) => x.trim()));
  check("every model name it offers is a brain this repository knows under the current scheme", models.length > 0 && models.every(([n, id]) => n && known.get((id || "").toLowerCase())?.schemeDigest.toLowerCase() === current));
  check("its named stimulus sets are a file in the repository", !!val("GATEWAY_SETS") && fs.existsSync(path.join(root, val("GATEWAY_SETS"))));
  check("redundancy at least 2: one provider's word is not a result", Number(val("GATEWAY_MIN_REDUNDANCY")) >= 2);
  // Render restarts a service whose health check fails, and a gateway waiting for its relayer is not a service worth
  // restarting -- restarting it does not bring the relayer back. /healthz is liveness and always answers 200;
  // /readyz is the one that refuses. Pointing the platform at /readyz would turn a relayer outage into a crash loop.
  check("the platform health-checks the LIVENESS path, not the readiness one", GW.lines.some((l) => /healthCheckPath:\s*\/healthz\s*$/.test(l)) && !GW.lines.some((l) => /healthCheckPath:\s*\/readyz/.test(l)));

  check("a start command and a health check that exist", GW.lines.some((l) => /startCommand:\s*npm run gateway\s*$/.test(l)) && GW.lines.some((l) => /healthCheckPath:\s*\/healthz\s*$/.test(l)) && /"gateway":/.test(fs.readFileSync(path.join(root, "package.json"), "utf8")));
  check("the relayer sponsors more than the project: the gateway's wallet is a task client too", (vars.get("PORW_TASK_CLIENTS")?.value || "").split(",").length >= 2);
}
console.log(fails ? `${fails} FAILURES` : "render blueprint: all checks passed"); process.exit(fails ? 1 : 0);
