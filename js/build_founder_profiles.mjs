// Reproduce every Founder profile from verified bases; no chain writes.
// Usage: node js/build_founder_profiles.mjs <base-dir> <output-dir> <public-origin>
// Output IDs are bare profiles. Final royalty-bearing MEP IDs require the NEW collection address.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {keccak256} from 'viem';
import {build} from '../flybnb/genesis/build_genesis_v2.mjs';
import {PorwNode} from '../contracts/lib/aigg-porw/web/porw-browser/node.js';
import {loadKernelFromBytes} from '../contracts/lib/aigg-porw/web/porw-browser/porw.js';
const [baseDir,out,originArg]=process.argv.slice(2);
if(!baseDir||!out||!originArg)throw Error('Expected base-dir output-dir public-origin');
const origin=new URL(originArg).origin;
assert(origin.startsWith('https://'));
const hex=b=>'0x'+Buffer.from(b).toString('hex');
const g=build(), wasm=fs.readFileSync(new URL('../contracts/lib/aigg-porw/web/porw-browser/sketch.wasm',import.meta.url));
const wasmSha256=createHash('sha256').update(wasm).digest('hex');
fs.mkdirSync(path.join(out,'deltas'),{recursive:true});
const result={version:1,genesisRoot:g.root,wasmSha256,note:'Bare execution profiles; collection-specific royalty terms must be bound after deployment.',bases:[],founders:[]};
const fields=(st,weightsDA)=>({...JSON.parse(JSON.stringify(st.mep,(_,v)=>v instanceof Uint8Array?hex(v):v)),weightsDA});
for(const sex of [0,1]){
 const name=sex?'malecns-v1.0-min2':'flywire-783-min2',expected=sex?g.baseMale:g.baseModelId,wUnitQ16=sex?g.weightUnits.male:g.weightUnits.female;
 const file=path.join(baseDir,name+'.bin'),bytes=fs.readFileSync(file),manifest=JSON.parse(fs.readFileSync(file+'.manifest.json'));
 assert.equal(bytes.length,manifest.bytes);assert.equal(createHash('sha256').update(bytes).digest('hex'),manifest.sha256);
 const nd=new PorwNode(await loadKernelFromBytes(wasm));
 const start=nd.k.mark();
 const bs=await nd.loadModel(name,bytes,{maxSteps:2,exec:'lif',wUnitQ16});
 assert.equal(hex(bs.mep.modelId),expected);
 result.bases.push({sex,wUnitQ16,sha256:manifest.sha256,...fields(bs,`${origin}/bases/${name}.bin`)});
 nd.models.clear();nd.k.release(start);
 const base=nd.loadDeltaBase(bytes),mark=nd.k.mark();assert.equal(hex(base.modelId),expected);
 for(const individual of g.individuals.filter(x=>x.sex===sex)){
  const recipe=Buffer.from(individual.recipe.slice(2),'hex');assert.equal(keccak256(recipe),individual.deltaHash);
  const st=await nd.loadDelta(base,recipe,{maxSteps:2,exec:'lif',wUnitQ16});
  assert.equal(st.hdr.neurons,manifest.neurons);
  const deltaPath=`deltas/${individual.deltaHash}.delta`;
  fs.writeFileSync(path.join(out,deltaPath),recipe);
  result.founders.push({index:individual.index,sex,baseModelId:expected,deltaHash:individual.deltaHash,wUnitQ16,...fields(st,`${origin}/${deltaPath}`)});
  fs.writeFileSync(path.join(out,'profiles.partial.json'),JSON.stringify(result,null,2)+'\n');
  console.log(`Founder ${individual.index}: ${hex(st.mep.mepId)}`);
  nd.models.clear();nd.k.release(mark);
 }
}
assert.equal(result.founders.length,200);assert.equal(new Set(result.founders.map(f=>f.modelId)).size,200);
fs.renameSync(path.join(out,'profiles.partial.json'),path.join(out,'profiles.json'));
fs.writeFileSync(path.join(out,'genesis-v2.json'),JSON.stringify(g,null,2)+'\n');
console.log('Verified 200 profiles and deltas; royalty-bound MEPs await collection address.');
