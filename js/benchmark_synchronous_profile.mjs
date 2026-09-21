// Read-only calibration over an exact local payload. Not a throughput or deadline guarantee for other hosts.
// Usage: node js/benchmark_synchronous_profile.mjs payload.bin wUnitQ16 [steps=100] [stride=10]
import fs from 'node:fs';import {createHash} from 'node:crypto';
import {PorwNode} from '../contracts/lib/aigg-porw/web/porw-browser/node.js';
import {loadKernelFromBytes} from '../contracts/lib/aigg-porw/web/porw-browser/porw.js';
import {measuredProfile} from './witness_profile.mjs';
const [file,unit,stepArg='100',strideArg='10']=process.argv.slice(2),steps=Number(stepArg),stride=Number(strideArg);
if(!file||!unit||!Number.isInteger(steps)||steps<1||!Number.isInteger(stride)||stride<1||stride>steps)throw Error('payload unit steps stride required');
const wasm=fs.readFileSync(new URL('../contracts/lib/aigg-porw/web/porw-browser/sketch.wasm',import.meta.url));
const bytes=fs.readFileSync(file),hex=b=>'0x'+Buffer.from(b).toString('hex'),node=new PorwNode(await loadKernelFromBytes(wasm));
let t=performance.now();const st=await node.loadModel('benchmark',bytes,{maxSteps:steps,exec:'lif',wUnitQ16:Number(unit)}),loadMs=performance.now()-t;
t=performance.now();const r=await node.execute(st.mep.mepId,{steps,commitStride:stride,stimulusSeed:7}),executeMs=performance.now()-t;
t=performance.now();await node.lifSegmentRoots(st.mep.mepId,0);const replayMs=performance.now()-t;
console.log(JSON.stringify({payload:file.split('/').at(-1),payloadSha256:createHash('sha256').update(bytes).digest('hex'),wasmSha256:createHash('sha256').update(wasm).digest('hex'),modelId:hex(st.modelId),mepId:hex(st.mep.mepId),synapseRoot:hex(st.csr.synapseRoot),neurons:st.hdr.neurons,synapses:st.hdr.synapses,maxInDegree:measuredProfile(node,st),steps,stride,loadMs,executeMs,replayMs,timings:r.timings,node:process.version,platform:process.platform,arch:process.arch},null,2));
