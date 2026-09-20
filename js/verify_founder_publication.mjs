// Verify published bytes against the checked-in genesis and generated local profiles.
// Usage: node js/verify_founder_publication.mjs <origin> <local-profiles.json> [report.json]
import fs from 'node:fs';import assert from 'node:assert/strict';import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';import {promisify} from 'node:util';
import {keccak256} from 'viem';import {build} from '../flybnb/genesis/build_genesis_v2.mjs';
const run=promisify(execFile),[originArg,profilesPath,reportPath]=process.argv.slice(2);
if(!originArg||!profilesPath)throw Error('Expected origin local-profiles.json [report.json]');
const origin=new URL(originArg).origin;
const get=async p=>(await run('curl',['--fail','--silent','--show-error','--location','--retry','2','--max-time','90',origin+p],{encoding:'buffer',maxBuffer:25*1024*1024})).stdout;
const local=JSON.parse(fs.readFileSync(profilesPath)),published=JSON.parse(await get('/profiles.json'));assert.deepEqual(published,local);
const g=build();assert.deepEqual(JSON.parse(await get('/genesis-v2.json')),g);
let next=0,count=0;
await Promise.all(Array.from({length:8},async()=>{while(next<g.size){const x=g.individuals[next++];const b=await get(`/deltas/${x.deltaHash}.delta`);assert.equal(keccak256(b),x.deltaHash);assert.equal('0x'+b.toString('hex'),x.recipe);count++;}}));
console.log(`PASS ${count} public deltas match all genesis recipes`);
const bases=[];
for(const base of local.bases){
 const p=new URL(base.weightsDA).pathname;
 const m=JSON.parse(await get(p+'.parts.json'));assert(Number.isSafeInteger(m.parts)&&m.parts>0&&m.parts<100);assert(Number.isSafeInteger(m.size)&&m.size>0);
 const sha=createHash('sha256');let size=0;
 for(let i=0;i<m.parts;i++){const b=await get(p+'.part'+i);assert.equal(b.length,Math.min(m.part,m.size-size));size+=b.length;sha.update(b);}
 const digest=sha.digest('hex');assert.equal(size,m.size);assert.equal(digest,base.sha256);
 bases.push({modelId:base.modelId,sha256:digest,bytes:size});console.log(`PASS public base ${base.name}: ${size} bytes, SHA-256 matches`);
}
const report={origin,checkedAt:new Date().toISOString(),genesisRoot:g.root,deltas:count,bases,result:'PASS'};
if(reportPath)fs.writeFileSync(reportPath,JSON.stringify(report,null,2)+'\n');
