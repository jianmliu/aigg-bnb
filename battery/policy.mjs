// Print deployment inputs for the exact battery bytes; this does not transact.
import fs from 'node:fs';import {keccak256} from 'viem';
import {state0Root} from '../gateway/state0.mjs';import {batteryBatch,resolvedRuns} from '../flybnb/battery/battery_batch.mjs';
import * as B from '../contracts/lib/aigg-porw/web/porw-browser/batch.js';import * as V from '../contracts/lib/aigg-porw/web/porw-browser/verify.js';
const raw=fs.readFileSync(process.argv[2]||'flybnb/battery/battery-v1.json'),spec=JSON.parse(raw),runs=resolvedRuns(batteryBatch(spec));
console.log(JSON.stringify({versionHash:keccak256(raw),runsRoot:V.hex(V.merkleRoot(runs.map((r,k)=>B.runLeaf(k,r.stimulusSeed,state0Root(spec.neurons,r.stimulusSeed,[...r.stimulusIds]).root)))),runs:runs.length,steps:spec.steps,stride:spec.commit_stride,neurons:spec.neurons},null,2));
