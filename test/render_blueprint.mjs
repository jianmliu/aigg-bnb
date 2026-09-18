// render.yaml is the one tracked file that says which contracts the hosted relayer serves, and the one tracked file
// an operator edits with a key file open in the next window. So it is checked, without a chain and without a YAML
// parser (the file is flat enough to read line by line): no secret has a value, nothing in it looks like a private
// key, and the brains it names are brains this repository knows under the scheme main implements.
import fs from "node:fs"; import path from "node:path"; import { fileURLToPath } from "node:url";
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
let fails = 0; const check = (n, ok, note = "") => { console.log((ok ? "  ok   " : "  FAIL ") + n + (ok || !note ? "" : "  " + note)); if (!ok) fails++; };

const lines = fs.readFileSync(path.join(root, "render.yaml"), "utf8").split("\n").filter((l) => !/^\s*#/.test(l));
const vars = new Map(); // key -> { value } | { sync }
for (let i = 0; i < lines.length; i++) { const k = /^\s*- key:\s*(\S+)\s*$/.exec(lines[i]); if (!k) continue; const next = (lines[i + 1] || "").trim(); const v = /^value:\s*"?(.*?)"?$/.exec(next); vars.set(k[1], v ? { value: v[1] } : { raw: next }); }

const SECRET = ["PORW_RELAYER_KEY", "PORW_DEPLOYER_KEY", "PORW_RPC"];
for (const k of SECRET) if (vars.has(k)) check(`${k} carries no value (sync: false)`, vars.get(k).raw === "sync: false", JSON.stringify(vars.get(k)));
check("the relayer key is declared, so a fresh Blueprint asks for it", vars.has("PORW_RELAYER_KEY"));
check("no key named *_KEY has a value", [...vars].every(([k, v]) => !/_KEY$/.test(k) || v.value === undefined));
// a 32-byte hex value is a private key unless it is one of the ids this file is allowed to carry
const ids = new Set((vars.get("PORW_MEP_IDS")?.value || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean));
const stray = lines.join("\n").match(/0x[0-9a-fA-F]{64}\b/g)?.filter((h) => !ids.has(h.toLowerCase())) || [];
check("every 32-byte hex string in the file is a MEP id it serves", stray.length === 0, stray.map((h) => h.slice(0, 10) + "…").join(" "));

const ADDR = ["PORW_VERIFIER", "PORW_MEP_REGISTRY", "PORW_INSTANCES", "PORW_BEACON", "PORW_CLAIMS", "PORW_MARKET", "PORW_DISPUTES", "PORW_RELAYS"];
check("all eight contract addresses are present and are addresses", ADDR.every((k) => /^0x[0-9a-fA-F]{40}$/.test(vars.get(k)?.value || "")), ADDR.filter((k) => !/^0x[0-9a-fA-F]{40}$/.test(vars.get(k)?.value || "")).join(" "));
check("and are eight different contracts", new Set(ADDR.map((k) => vars.get(k)?.value.toLowerCase())).size === 8);

// the brains: each id it serves is the id of a fields file under the scheme the pinned aigg-porw implements
const mesh = fs.readFileSync(path.join(root, "contracts/lib/aigg-porw/contracts/evm/src/interfaces/PorwMesh.sol"), "utf8");
const schemes = [...mesh.matchAll(/SCHEME_SKETCH_TILE_KECCAK_V(\d+) = (0x[0-9a-f]{64})/g)].sort((a, b) => Number(b[1]) - Number(a[1]));
const current = schemes[0][2];
const dir = path.join(root, "tasks/flywire-gate/fields"); const known = new Map();
for (const f of fs.readdirSync(dir)) { const j = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")); known.set(j.mepId.toLowerCase(), j); }
check(`it serves at least one brain`, ids.size > 0);
for (const id of ids) { const j = known.get(id); check(`${id.slice(0, 12)}… is a known profile under the current scheme (v${schemes[0][1]})`, !!j && j.schemeDigest.toLowerCase() === current, j ? `fields file says scheme ${j.schemeDigest.slice(0, 10)}…` : "no fields file has this mepId"); }
const names = vars.get("PORW_MEP_NAMES")?.value; if (names) check("every name is for a brain it serves", names.split(",").every((kv) => ids.has(kv.split("=")[0].trim().toLowerCase())));

check("never the free plan: a sleeping relayer stalls the mesh", !lines.some((l) => /^\s*plan:\s*free\s*$/.test(l)));
console.log(fails ? `${fails} FAILURES` : "render blueprint: all checks passed"); process.exit(fails ? 1 : 0);
