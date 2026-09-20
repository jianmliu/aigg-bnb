// The three brains are a few numbers each, copied into a dozen files by hand.
//
// `model_id` is not a label -- it is the thing every host checks its bytes against and the thing the chain binds a
// MEP to. A wrong digit in a genesis manifest or an analysis script does not degrade anything: it produces a brain
// nobody can serve, or worse, one that loads and is not the brain the paper measured. The values live in genesis
// manifests, battery definitions, published base profiles, two Python constants, a live-run script, four READMEs and
// a deploy doc, and nothing has been checking that they still agree with each other.
//
// The anchor is not this file's opinion. Both payloads were rebuilt on 2026-09-20 from the public FlyWire v783
// release with nothing of this project's in the path, and each rebuild's mep_id was found already registered on BSC
// testnet against the same model_id. That record is `tasks/live-runs/…rebuild.json`, and this test fails if it and
// the constants below ever drift apart -- so neither can be edited alone.
//
// The male brain (MaleCNS v1.0, >= 2 synapses) landed later and has no rebuild of its own yet. Two other committed
// records stand in its place: `tasks/live-runs/founder-publication-2026-09-20.json`, where the published base was
// fetched back part by part and hashed, so its bytes and sha256 there were measured rather than copied; and
// `flybnb/results/male/live/attestation.json`, the 42-run battery it settled on BSC testnet against its mep_id.
//
// It also carries a number the FlyWire brains do not: weight unit 7209, where int-lif's default is 18022. That is
// not part of the payload's bytes and does not move `model_id`. It is an address all the same -- the unit fixes the
// exec kind, the exec kind is one of the six fields hashed into `mep_id`, and the chain stores the unit against the
// kind (`MEPRegistry.lifWeightUnit` returns 7209 for this one). Copy it wrong and the bytes are still the right
// bytes and the brain answers to nobody, which is the same failure a wrong digit in a hash is. So it is pinned here.
import fs from "node:fs"; import path from "node:path";
const root = path.resolve(import.meta.dirname, "..");
const read = (p) => fs.readFileSync(path.join(root, p), "utf8");
let fails = 0; const check = (n, ok, note = "") => { console.log((ok ? "  ok   " : "  FAIL ") + n + (ok || !note ? "" : "  " + note)); if (!ok) fails++; };

// verified 2026-09-20: rebuilt from Zenodo 10676866 + flywire_annotations, byte for byte, and registered on chain
const BRAINS = {
  min2: { name: "flywire-fafb-v783-min2", bytes: 77074432, neurons: 139255, synapses: 7595967,
    sha256: "10a9e16f08174e4c2421f64d10ee17466d39ff88847ba7ab0c1ef57c1a9022a5",
    modelId: "0x53a7b48e9265bea68fbd3f3640eda751f8dd7742ac76ae6f9c69f1cddc528135",
    mepId: "0x79af9764440ecfefecac3056fccfa3720c1cbb09600eb0d2facad53da4315f50" },
  min5: { name: "flywire-fafb-v783-min5", bytes: 28123136, neurons: 139255, synapses: 2700513,
    sha256: "fd246cc2c0ac74e8928cf5b0012c5d4c48a0a03475595213b301f85f5fe4e1da",
    modelId: "0x9747cc81830375103eae957a93d3800875223c17bdc6399f5783be62a19da93a",
    mepId: "0x312dda12d308ba13796472e6ba444be4a94a5b04ce9e5ef3ada3649034443f8a" },
  // verified 2026-09-20: fetched back from the publication origin and hashed, and `exists`/`claimBinding` on BSC
  // testnet return this model_id for this mep_id, which is also keccak of the six fields of its profile
  male: { name: "malecns-v1.0-min2", bytes: 154169344, neurons: 166700, synapses: 15283237,
    sha256: "38227caa7f35af4913a85d0f59c473c4b870e5f9373bb4e07e143163e7a571ba",
    modelId: "0x7a22e8b8a1eae502ea7528be8ed0699b5c31ce5bf6fd2d4e56aedb46bf17394e",
    mepId: "0xc17357517fa10c848713812c75543a7e74978bb1f4554dab75bcf7315022d214",
    wUnitQ16: 7209 },
};

// 1. the record of the rebuild, and what it says about itself
const REC = "tasks/live-runs/live-gateway-2026-09-20T07-55-00Z.rebuild.json";
const rec = JSON.parse(read(REC));
for (const r of rec.rebuilt) {
  const b = Object.values(BRAINS).find((x) => x.name === r.name);
  check(`${r.name}: the record is in this test`, !!b, r.name);
  if (!b) continue;
  check(`${r.name}: what was rebuilt is what was published`,
    r.bytes === r.published_bytes && r.sha256 === r.published_sha256 && r.modelId === r.published_modelId);
  check(`${r.name}: the record and this test agree`,
    r.bytes === b.bytes && r.sha256 === b.sha256 && r.modelId === b.modelId && r.mepId === b.mepId
    && r.neurons === b.neurons && r.synapses === b.synapses);
  const oc = rec.onchain[r.name.endsWith("min2") ? "min2" : "min5"];
  check(`${r.name}: the chain has it, bound to the same model_id`, oc.exists === true && oc.modelId === b.modelId && oc.equals_rebuilt === true);
}
check("the record names its public inputs with their own hashes",
  rec.inputs.files.length === 3 && rec.inputs.files.every((f) => /^[0-9a-f]{64}$/.test(f.sha256) && f.bytes > 0));

// 1b. the male brain's two records, in place of a rebuild
{ const M = BRAINS.male;
  const pub = JSON.parse(read("tasks/live-runs/founder-publication-2026-09-20.json"));
  const base = pub.bases.find((b) => b.modelId === M.modelId);
  check("the published male base was fetched back and hashed, and this test has what came back",
    pub.result === "PASS" && !!base && base.bytes === M.bytes && base.sha256 === M.sha256, JSON.stringify(base));
  const att = JSON.parse(read("flybnb/results/male/live/attestation.json"));
  check("and the battery it settled on chain 97 was posted against this mep_id, at this weight unit",
    att.chainId === 97 && att.mepId === M.mepId && att.wUnitQ16 === M.wUnitQ16 && att.settled.matches === true); }

// 2. every place that pins one of these values by hand
const pins = [
  ["flybnb/genesis/genesis-v1.json",          (s) => JSON.parse(s).baseModelId,      BRAINS.min2.modelId, "baseModelId"],
  ["flybnb/genesis/flywire-783-min2.v3.json", (s) => JSON.parse(s).modelId,          BRAINS.min2.modelId, "modelId"],
  ["flybnb/genesis/flywire-783-min2.v3.json", (s) => JSON.parse(s).sha256,           BRAINS.min2.sha256,  "sha256"],
  ["flybnb/battery/battery-v1.json",          (s) => JSON.parse(s).payload_model_id, BRAINS.min5.modelId, "payload_model_id"],
  ["flybnb/battery/battery-v1.json",          (s) => JSON.parse(s).neurons,          BRAINS.min5.neurons, "neurons"],
  ["flybnb/analysis/run_battery.py",          (s) => s.match(/BASE_MODEL_ID\s*=\s*"(0x[0-9a-f]{64})"/)?.[1], BRAINS.min2.modelId, "BASE_MODEL_ID"],
  ["flybnb/analysis/phenotype_variance.py",   (s) => s.match(/BASE_MODEL_ID\s*=\s*"(0x[0-9a-f]{64})"/)?.[1], BRAINS.min2.modelId, "BASE_MODEL_ID"],
  // the male brain. render.yaml pins its mep_id too, but test/render_blueprint.mjs already refuses any 32-byte hex
  // there that is not a known profile's, so it is covered by that file and not repeated here.
  ["flybnb/genesis/genesis-v2.json",           (s) => JSON.parse(s).baseMale,              BRAINS.male.modelId,  "baseMale"],
  ["flybnb/genesis/genesis-v2.json",           (s) => JSON.parse(s).weightUnits.male,      BRAINS.male.wUnitQ16, "weightUnits.male"],
  ["flybnb/male/malecns-v1.0-min2.v3.json",    (s) => JSON.parse(s).modelId,               BRAINS.male.modelId,  "modelId"],
  ["flybnb/male/malecns-v1.0-min2.v3.json",    (s) => JSON.parse(s).sha256,                BRAINS.male.sha256,   "sha256"],
  ["flybnb/male/malecns-v1.0-min2.v3.json",    (s) => JSON.parse(s).mepId,                 BRAINS.male.mepId,    "mepId"],
  ["flybnb/male/malecns-v1.0-min2.v3.json",    (s) => JSON.parse(s).wUnitQ16,              BRAINS.male.wUnitQ16, "wUnitQ16"],
  ["flybnb/battery/battery-male-v1.json",      (s) => JSON.parse(s).payload_model_id,      BRAINS.male.modelId,  "payload_model_id"],
  ["flybnb/battery/battery-male-v1.json",      (s) => JSON.parse(s).neurons,               BRAINS.male.neurons,  "neurons"],
  ["flybnb/battery/battery-male-v1.json",      (s) => JSON.parse(s).population.w_unit_q16, BRAINS.male.wUnitQ16, "population.w_unit_q16"],
  ["flybnb/genesis/founder-profiles-v2.json",  (s) => JSON.parse(s).bases.find((b) => b.sex === 1)?.sha256, BRAINS.male.sha256, "sha256 for the male base"],
  ["flybnb/genesis/founder-profiles-v2.json",  (s) => JSON.parse(s).bases.find((b) => b.sex === 1)?.mepId,  BRAINS.male.mepId,  "mepId for the male base"],
  ["test/live_male_battery.mjs",               (s) => s.match(/const MALE = "(0x[0-9a-f]{64})"/)?.[1], BRAINS.male.mepId, "MALE"],
];
for (const [file, get, want, field] of pins) {
  let got; try { got = get(read(file)); } catch (e) { got = `unreadable: ${e.message}`; }
  check(`${file} pins the right ${field}`, got === want, `got ${got}`);
}

// 3. the table in the paper's README: the row a reader would copy
{ const md = read("flybnb/README.md");
  for (const b of Object.values(BRAINS)) {
    const short = b.name.replace("fafb-v783", "783").replace("flywire-783", "flywire-783"); // `flywire-783-min5.bin`
    const row = md.split("\n").find((l) => l.startsWith("|") && l.includes(short.replace("flywire-fafb-v783", "flywire-783") + ".bin"));
    check(`README table has a row for ${b.name}`, !!row);
    if (!row) continue;
    check(`  its bytes, sha256 and model_id are the verified ones`,
      row.includes(b.bytes.toLocaleString("en-US")) && row.includes(b.sha256) && row.includes(b.modelId),
      row.slice(0, 90) + "…");
  } }

// 4. abbreviations. `fd246cc2…e1da` is the form a human reads, and a typo in one is invisible to every other check.
{ const files = ["README.md", "flybnb/README.md", "flybnb/battery/README.md", "docs/DEPLOY-MAINNET.md", "docs/TOKENOMICS.md", "docs/DESIGN.md"]
    .filter((f) => fs.existsSync(path.join(root, f)));
  const full = Object.values(BRAINS).flatMap((b) => [b.sha256, b.modelId, b.mepId]).map((h) => h.replace(/^0x/, "").toLowerCase());
  let bad = [];
  for (const f of files) for (const line of read(f).split("\n")) {
    // `abcd1234…` or `abcd1234…wxyz`: a prefix of at least 8 hex, an ellipsis, an optional suffix
    for (const m of line.matchAll(/(?<![0-9a-fA-Fx])(?:0x)?([0-9a-f]{8,})…([0-9a-f]{0,8})(?![0-9a-f])/g)) {
      const [, pre, suf] = m;
      const known = full.filter((h) => h.startsWith(pre));
      if (!known.length) continue;                       // not one of ours; other hashes abbreviate here too
      if (!known.some((h) => h.endsWith(suf))) bad.push(`${f}: ${m[0]}`);
    }
  }
  check("no abbreviation of a brain's hash has a wrong tail", bad.length === 0, bad.join("; ")); }

console.log(fails ? `${fails} FAILURES` : "brain addresses: all checks passed");
process.exit(fails ? 1 : 0);
