// A new collection root; the v1 female research manifest remains immutable.
import fs from 'node:fs';import {gunzipSync} from 'node:zlib';import {fileURLToPath} from 'node:url';
import {keccak256} from 'viem';
import {build as female,leafOf,tree,proofFor} from './build_genesis.mjs';
import {decodeDelta3} from '../../contracts/lib/aigg-porw/web/porw-browser/delta.js';
const read=p=>fs.readFileSync(new URL(p,import.meta.url));
const hex=b=>'0x'+Buffer.from(b).toString('hex');
export function build(){
 const f=female(),battery=JSON.parse(read('../battery/battery-male-v1.json'));
 const rows=gunzipSync(read('../results/male/pilot/rows.jsonl.gz')).toString().trim().split('\n').map(JSON.parse).filter(r=>r.kind==='founder');
 if(rows.length!==100||new Set(rows.map(r=>r.id)).size!==100)throw Error('Expected 100 distinct measured male founders');
 const entries=f.individuals.map(x=>({...x,baseModelId:f.baseModelId}));
 for(const r of rows){
  const recipe=r.recipe_hex.startsWith('0x')?r.recipe_hex:'0x'+r.recipe_hex;
  const d=decodeDelta3(Buffer.from(recipe.slice(2),'hex')),baseModelId=hex(d.baseModelId),deltaHash=keccak256(recipe);
  if(baseModelId!==battery.population.base_model_id)throw Error('Male recipe base mismatch');
  if(deltaHash!== (r.delta_id.startsWith('0x')?r.delta_id:'0x'+r.delta_id))throw Error('Male research delta hash mismatch');
  entries.push({index:entries.length,pilotInd:r.id,sex:1,baseModelId,deltaHash,recipe});
 }
 const levels=tree(entries.map(x=>leafOf(x.index,x.sex,x.deltaHash)));
 return {version:2,note:'Replacement genesis: unchanged 100 female pilot founders plus 100 measured MaleCNS founders. Sex follows the actual base model.',source:['flybnb/results/pilot/runs.jsonl','flybnb/results/male/pilot/rows.jsonl.gz'],size:entries.length,root:levels.at(-1)[0],baseModelId:f.baseModelId,baseMale:battery.population.base_model_id,sexes:{female:100,male:100},weightUnits:{female:18022,male:battery.population.w_unit_q16},individuals:entries.map((x,i)=>({...x,proof:proofFor(levels,i)}))};
}
if(process.argv[1]===fileURLToPath(import.meta.url)){
 const out=new URL('genesis-v2.json',import.meta.url),text=JSON.stringify(build(),null,1)+'\n';
 if(process.argv.includes('--check')){if(fs.readFileSync(out,'utf8')!==text)throw Error('genesis-v2 is stale');}
 else fs.writeFileSync(out,text);
 console.log('Verified 200 founders: 100 female, 100 male');
}
