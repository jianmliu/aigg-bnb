// Register a MEP on the deployed MEPRegistry from the fields the node computed for a payload
// (aigg-porw model_id / synapseRoot / exec kind / steps / stride) plus its Greenfield pointer.
//   source .env.<network>; node js/register_mep.mjs <fields.json> gnfd://<bucket>/<object>
// Registration is immutable: the pointer must already serve bytes whose model_id equals fields.modelId.
import fs from "node:fs";
import { toHex, stringToHex } from "viem";
import { deploymentFromEnv } from "../relayer/env.mjs";
import { clients } from "../relayer/chain.mjs";
import { fetchVerified, parsePointer } from "./greenfield.js";
const [fieldsPath, pointer, spEndpoint] = process.argv.slice(2); if (!fieldsPath || !pointer) { console.log("usage: register_mep.mjs <fields.json> gnfd://bucket/object [sp endpoint to verify first]"); process.exit(2); }
const f = JSON.parse(fs.readFileSync(fieldsPath, "utf8")); const dep = deploymentFromEnv(); if (!dep) throw new Error("source the .env.<network> first");
const pk = process.env.PORW_DEPLOYER_KEY || process.env.PORW_RELAYER_KEY; if (!pk) throw new Error("PORW_DEPLOYER_KEY");
parsePointer(pointer);
if (spEndpoint) { const unhex = (s) => Uint8Array.from(s.slice(2).match(/../g).map((h) => parseInt(h, 16))); const r = await fetchVerified(spEndpoint, pointer, unhex(f.modelId)); console.log(`verified ${r.bytes.length} bytes from ${r.url}: model_id matches`); }
const c = clients(dep, pk);
const m = { modelId: f.modelId, schemeDigest: f.schemeDigest, execKind: f.execKind, steps: f.steps, clampQ16: f.clampQ16, neurons: f.neurons, synapses: f.synapses, synapseRoot: f.synapseRoot, weightsDA: stringToHex(pointer) };
if (await c.meps.read.exists([f.mepId])) { console.log("already registered:", f.mepId); process.exit(0); }
const hash = await c.meps.write.registerMEP([m]); const rcpt = await c.pub.waitForTransactionReceipt({ hash });
console.log(`registerMEP ${rcpt.status} tx ${hash} gas ${rcpt.gasUsed}`);
const on = await c.meps.read.getMEP([f.mepId]); console.log(`on-chain MEP ${f.mepId}: modelId ${on.modelId} steps ${on.steps} stride ${on.clampQ16} neurons ${on.neurons} synapses ${on.synapses} weightsDA ${Buffer.from(on.weightsDA.slice(2), "hex").toString()}`);
