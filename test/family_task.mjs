import test from 'node:test';
import assert from 'node:assert/strict';
import { stringToHex, keccak256 } from 'viem';
import {createFamilyResolver,recipeGraph} from '../frontend/src/core/family-task.js';
import * as runtime from '../contracts/lib/aigg-porw/web/porw-browser/delta.js';
const word=n=>'0x'+n.repeat(64),addr=n=>'0x'+n.repeat(40),unhex=s=>Uint8Array.from(Buffer.from(s.slice(2),'hex'));
const base=word('1'),child=word('2'),model=word('3'),taskId=word('4'),instance=addr('5'),zero=word('0');
const recipe=(parents=[zero,zero],override={})=>runtime.encodeDelta3({baseModelId:unhex(model),neurons:2,parentA:unhex(parents[0]),parentB:unhex(parents[1]),seed:1n,name:'test',layout:1,...override});
function fixture(){let downloads=0;const reads=[];const payload=recipe(),task={mepId:child,steps:5,commitStride:1,stimulusSeed:7,initStateRoot:word('6')};
 const values={tasks:[task,addr('7'),1n,50n,0n,true,false,false,false],executors:[instance],submitted:false,batchRuns:0,TASK_TIMEOUT:30n,enrollmentMep:base,baseOf:base,getMEP:{modelId:word('8'),weightsDA:stringToHex('https://example.test/deltas/child.delta'),neurons:2,synapses:3,synapseRoot:word('9'),execKind:word('a')},termsOf:[addr('0'),0],lifWeightUnit:18022};
 const deployment={chainId:97,rpc:'https://rpc.test',addresses:{market:addr('1'),meps:addr('2'),instances:addr('3')}};
 const opts={deployment,instance,families:new Map([[base,{modelId:model,neurons:2,maxSteps:100}]]),client:{getChainId:async()=>97,getBlockNumber:async()=>60n,readContract:async c=>{reads.push(c);return values[c.functionName];}},runtime,fetcher:async()=>{downloads++;return new Response(payload);}};
 return {opts,values,reads,env:{type:'task-announce',mepId:child,payload:{taskId,steps:5,stimulusSeed:7,commitStride:1}},downloads:()=>downloads};}
test('future child resolves directly from chain without catalog or a base download',async()=>{const f=fixture();const out=await createFamilyResolver(f.opts)(f.env);assert.equal(out.baseMepId,base);assert.equal(out.mep.mepId,child);assert.equal(out.payload.initStateRoot,word('6'));assert.equal(f.downloads(),1);assert(f.reads.every(x=>x.blockNumber===60n));});
test('unassigned, closed, wrong family, wrong parameters or wrong chain never downloads',async()=>{for(const mutate of [f=>f.values.executors=[],f=>f.values.tasks[6]=true,f=>f.values.submitted=true,f=>f.values.enrollmentMep=word('f'),f=>f.env.payload.steps=6,f=>f.env.mepId=base,f=>f.opts.client.getChainId=async()=>56]){const f=fixture();mutate(f);await assert.rejects(createFamilyResolver(f.opts)(f.env));assert.equal(f.downloads(),0);}});
test('root task does not download a delta',async()=>{const f=fixture();f.values.tasks[0].mepId=base;f.env.mepId=base;f.values.baseOf=zero;const out=await createFamilyResolver(f.opts)(f.env);assert.equal(out.delta,null);assert.equal(f.downloads(),0);});
test('ancestor graph fetches content-addressed parents and verifies every hash',async()=>{const parent=recipe(),hash=keccak256(parent),childRecipe=recipe([hash,hash]);const hits=[];const fetcher=async u=>{hits.push(u);return new Response(u.endsWith('child.delta')?childRecipe:parent);};const graph=await recipeGraph(['https://example.test/deltas/child.delta'],{modelId:model,neurons:2},{runtime,fetcher});assert.equal(graph.ancestors.length,1);assert.equal(hits.length,2);assert(hits[1].endsWith(hash+'.delta'));await assert.rejects(recipeGraph(['https://example.test/child.delta'],{modelId:model,neurons:2},{runtime,fetcher:async u=>new Response(u.endsWith('child.delta')?childRecipe:recipe([zero,zero], {seed:2n}))}),/hash|ids/);});
test('bad family, ancestor layout, missing data, streaming size limit fail closed',async()=>{for(const bytes of [recipe([zero,zero],{baseModelId:unhex(word('f'))}),recipe([zero,zero],{layout:0}),new Uint8Array(65537)])await assert.rejects(recipeGraph(['https://example.test/child.delta'],{modelId:model,neurons:2},{runtime,fetcher:async()=>new Response(bytes)}));await assert.rejects(recipeGraph(['https://example.test/child.delta'],{modelId:model,neurons:2},{runtime,fetcher:async()=>new Response('',{status:404})}));});
test('batch type and run count must match chain',async()=>{const f=fixture();f.values.batchRuns=2;await assert.rejects(createFamilyResolver(f.opts)(f.env),/batch/);f.env.type='batch-announce';f.env.payload.runs=[{stimulusSeed:1}];await assert.rejects(createFamilyResolver(f.opts)(f.env),/count/);});

test('ancestor recipes cannot change base name length',async()=>{const parent=recipe([zero,zero],{name:'longer'}),hash=keccak256(parent),childRecipe=recipe([hash,zero]);await assert.rejects(recipeGraph(['https://example.test/child.delta'],{modelId:model,neurons:2,nameBytes:4},{runtime,fetcher:async u=>new Response(u.endsWith('child.delta')?childRecipe:parent)}),/name/);});
test('resolver has one admission slot and releases it after failure',async()=>{
 const f=fixture();let release;f.opts.client.getChainId=()=>new Promise(r=>release=r);
 const resolve=createFamilyResolver(f.opts),first=resolve(f.env);
 await assert.rejects(resolve(f.env),/busy/);release(56);await assert.rejects(first,/chain/);
 const next=resolve(f.env);release(97);await next;assert.equal(f.downloads(),1);
});
test('aborted graph makes no requests and stops mirror fallback',async()=>{
 const controller=new AbortController();controller.abort();let calls=0;
 await assert.rejects(recipeGraph(['https://example.test/a.delta'],{modelId:model,neurons:2},{runtime,signal:controller.signal,fetcher:async()=>{calls++;return new Response(recipe());}}),/abort/i);
 assert.equal(calls,0);
 const live=new AbortController();
 await assert.rejects(recipeGraph(['https://example.test/a.delta','https://example.test/b.delta'],{modelId:model,neurons:2},{runtime,signal:live.signal,fetcher:async()=>{calls++;live.abort();throw Error('network');}}),/abort/i);
 assert.equal(calls,1);
});
test('batch family limit is 64 before recipe download',async()=>{
 const f=fixture();f.env.type='batch-announce';f.values.batchRuns=65;f.env.payload.runs=Array.from({length:65},()=>({stimulusSeed:1}));
 await assert.rejects(createFamilyResolver(f.opts)(f.env),/batch/);assert.equal(f.downloads(),0);
 f.values.batchRuns=64;f.env.payload.runs.pop();await createFamilyResolver(f.opts)(f.env);assert.equal(f.downloads(),1);
});
