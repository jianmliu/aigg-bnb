// Independent manifest/recipe/profile consistency check before publication.
import fs from 'node:fs';import path from 'node:path';import assert from 'node:assert/strict';
import {keccak256} from 'viem';
import {build} from '../flybnb/genesis/build_genesis_v2.mjs';
import {makeMep} from '../contracts/lib/aigg-porw/web/porw-browser/mep.js';
import {lifExecKind} from '../contracts/lib/aigg-porw/web/porw-browser/lif.js';
const [dir]=process.argv.slice(2);if(!dir)throw Error('Expected asset directory');
const profiles=JSON.parse(fs.readFileSync(path.join(dir,'profiles.json'))),g=build();
const hex=b=>'0x'+Buffer.from(b).toString('hex'),bytes=h=>Buffer.from(h.slice(2),'hex');
assert.equal(profiles.genesisRoot,g.root);assert.equal(profiles.founders.length,200);assert.equal(profiles.bases.length,2);
assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir,'genesis-v2.json'))),g);
assert.equal(new Set(profiles.founders.map(x=>x.modelId)).size,200);
for(const p of [...profiles.bases,...profiles.founders]){
 const unit=p.sex?7209:18022;assert.equal(p.wUnitQ16,unit);assert.equal(p.execKind,hex(lifExecKind(unit)));
 const m=makeMep({name:p.name,modelId:bytes(p.modelId),execKind:bytes(p.execKind),neurons:p.neurons,synapses:p.synapses,synapseRoot:bytes(p.synapseRoot)});
 assert.equal(hex(m.schemeDigest),p.schemeDigest);assert.equal(hex(m.mepId),p.mepId);
 assert(!p.weightsDA.includes('#'));assert.equal(new URL(p.weightsDA).protocol,'https:');
}
for(let i=0;i<200;i++){
 const p=profiles.founders[i],x=g.individuals[i];assert.equal(p.index,i);assert.equal(p.sex,x.sex);assert.equal(p.baseModelId,x.baseModelId);assert.equal(p.deltaHash,x.deltaHash);
 const url=new URL(p.weightsDA);assert.equal(url.pathname,`/deltas/${x.deltaHash}.delta`);
 const delta=fs.readFileSync(path.join(dir,'deltas',x.deltaHash+'.delta'));
 assert.equal(hex(delta),x.recipe);assert.equal(keccak256(delta),x.deltaHash);
}
console.log('PASS: 200 direct deltas, two base profiles, 200 unique Founder profiles, execution units and genesis proofs');
