// The two brains are one pair of numbers each, copied into a dozen files by hand.
//
// `model_id` is not a label -- it is the thing every host checks its bytes against and the thing the chain binds a
// MEP to. A wrong digit in a genesis manifest or an analysis script does not degrade anything: it produces a brain
// nobody can serve, or worse, one that loads and is not the brain the paper measured. The values live in genesis
// manifests, battery definitions, two Python constants, three READMEs and a deploy doc, and nothing has been
// checking that they still agree with each other.
//
// The anchor is not this file's opinion. Both payloads were rebuilt on 2026-09-20 from the public FlyWire v783
// release with nothing of this project's in the path, and each rebuild's mep_id was found already registered on BSC
// testnet against the same model_id. That record is `tasks/live-runs/…rebuild.json`, and this test fails if it and
// the constants below ever drift apart -- so neither can be edited alone.
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

// 2. every place that pins one of these values by hand
const pins = [
  ["flybnb/genesis/genesis-v1.json",          (s) => JSON.parse(s).baseModelId,      BRAINS.min2.modelId, "baseModelId"],
  ["flybnb/genesis/flywire-783-min2.v3.json", (s) => JSON.parse(s).modelId,          BRAINS.min2.modelId, "modelId"],
  ["flybnb/genesis/flywire-783-min2.v3.json", (s) => JSON.parse(s).sha256,           BRAINS.min2.sha256,  "sha256"],
  ["flybnb/battery/battery-v1.json",          (s) => JSON.parse(s).payload_model_id, BRAINS.min5.modelId, "payload_model_id"],
  ["flybnb/battery/battery-v1.json",          (s) => JSON.parse(s).neurons,          BRAINS.min5.neurons, "neurons"],
  ["flybnb/analysis/run_battery.py",          (s) => s.match(/BASE_MODEL_ID\s*=\s*"(0x[0-9a-f]{64})"/)?.[1], BRAINS.min2.modelId, "BASE_MODEL_ID"],
  ["flybnb/analysis/phenotype_variance.py",   (s) => s.match(/BASE_MODEL_ID\s*=\s*"(0x[0-9a-f]{64})"/)?.[1], BRAINS.min2.modelId, "BASE_MODEL_ID"],
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
{ const files = ["README.md", "flybnb/README.md", "docs/DEPLOY-MAINNET.md", "docs/TOKENOMICS.md", "docs/DESIGN.md"]
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
