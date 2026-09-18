// Fetch a registered MEP's model payload from a Greenfield storage provider and verify it before it is written
// to disk. The SP is untrusted: the bytes are accepted only if they reproduce the `model_id` the MEP pins
// on-chain (the keccak weights Merkle root), so a wrong, stale or hostile SP can only deny service. Publishing
// is in js/greenfield_admin.mjs; this is the other half, for anyone who wants to run a node.
//   source the .env.<network> (or pass --env), then:
//   node js/fetch_brain.mjs <mepId> <out.bin> [sp endpoint]
import fs from "node:fs";
import { deploymentFromEnv, loadEnv } from "../relayer/env.mjs";
import { clients } from "../relayer/chain.mjs";
import { fetchVerified, parsePointer, objectUrl } from "./greenfield.js";
const args = process.argv.slice(2);
const envAt = args.indexOf("--env"); if (envAt >= 0) { loadEnv(args[envAt + 1]); args.splice(envAt, 2); }
const [mepId, out, spArg] = args;
if (!mepId || !out) { console.log("usage: fetch_brain.mjs [--env <file>] <mepId> <out.bin> [sp endpoint]"); process.exit(2); }
const sp = spArg || process.env.PORW_GNFD_SP || "https://gnfd-testnet-sp2.bnbchain.org";
const dep = deploymentFromEnv(); if (!dep) throw new Error("no deployment: source the .env.<network> written by deploy.sh, or pass --env <file>");
const c = clients(dep);
const m = await c.meps.read.getMEP([mepId]);
const pointer = Buffer.from(m.weightsDA.slice(2), "hex").toString();
const unhex = (s) => Uint8Array.from(s.slice(2).match(/../g).map((h) => parseInt(h, 16)));
console.log(`MEP ${mepId}\n  pointer  ${pointer}\n  model_id ${m.modelId}\n  ${m.neurons} neurons, ${m.synapses} synapse records\n  from     ${objectUrl(sp, parsePointer(pointer))}`);
const t0 = Date.now();
const r = await fetchVerified(sp, pointer, unhex(m.modelId));
fs.writeFileSync(out, r.bytes);
console.log(`verified ${r.bytes.length} bytes in ${((Date.now() - t0) / 1000).toFixed(1)} s: model_id matches the MEP -> ${out}`);
