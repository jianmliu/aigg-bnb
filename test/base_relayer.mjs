import test from 'node:test';
import assert from 'node:assert/strict';
import { providerModels } from '../relayer/providers.mjs';
const base='base', child='child';
for (const batch of [false,true]) test(`provider counts share enrollment reads (batch=${batch}) while preserving child metadata`,async()=>{
 const calls=[];const votes=['0xaa','0xaa','0xbb'];
 const ch={chain:{id:batch?97:31337},claims:{read:{currentEpoch:async()=>7n,beacon:async()=>1n}},instances:{address:'0x'+'11'.repeat(20),read:{eligibleVotes:async([id])=>{calls.push(id);return votes;}}},pub:{multicall:async({contracts})=>contracts.map(c=>{calls.push(c.args[0]);return votes;})}};
 const rows=await providerModels(ch,new Map([[base,{info:{mepId:base,enrollmentMepId:base}}],[child,{info:{mepId:child,enrollmentMepId:base,token:3}}]]));
 assert.deepEqual(calls,[base]);assert.equal(rows[1].mepId,child);assert.equal(rows[1].token,3);assert.equal(rows[1].providers,2);assert.equal(rows[1].votes,3);
});

test('routing distinguishes declared ancestry from activated enrollment and fails closed on RPC errors',async()=>{
 const { enrollmentMetadata }=await import('../relayer/enrollment.mjs');
 const zero='0x'+'00'.repeat(32);
 const ch={meps:{read:{baseOf:async()=>base}},instances:{read:{enrollmentMep:async()=>child}}};
 assert.deepEqual(await enrollmentMetadata(ch,child),{baseMepId:base,enrollmentMepId:child});
 ch.instances.read.enrollmentMep=async()=>base;
 assert.deepEqual(await enrollmentMetadata(ch,child),{baseMepId:base,enrollmentMepId:base});
 ch.meps.read.baseOf=async()=>zero;ch.instances.read.enrollmentMep=async()=>child;
 assert.deepEqual(await enrollmentMetadata(ch,child),{baseMepId:null,enrollmentMepId:child});
 const unsupported=()=>{throw Object.assign(new Error('selector absent'),{name:'ContractFunctionZeroDataError'});};
 ch.meps.read.baseOf=unsupported;ch.instances.read.enrollmentMep=unsupported;
 assert.deepEqual(await enrollmentMetadata(ch,child),{baseMepId:null,enrollmentMepId:child});
 ch.instances.read.enrollmentMep=async()=>{throw Error('RPC timeout');};
 await assert.rejects(enrollmentMetadata(ch,child),/RPC timeout/);
});

test('catalog reconciles base dependency lifetimes without losing pinned child or metadata',async()=>{
 const { reconcileEnrollmentBases }=await import('../relayer/enrollment.mjs');
 const make=(id,enrollmentMepId=id,pinned=false)=>({info:{mepId:id,enrollmentMepId,token:9},pinned,aggregators:new Map()});
 const models=new Map([[child,make(child,base,true)]]);let loaded=0,stopped=0;
 const load=async id=>{loaded++;return make(id);};
 await reconcileEnrollmentBases(models,new Set(),load);
 assert.equal(loaded,1);assert.equal(models.get(child).info.token,9);assert(models.has(base));
 await reconcileEnrollmentBases(models,new Set(),load);assert.equal(loaded,1);
 models.get(child).pinned=false;models.get(base).aggregators.set(1,{stop:()=>stopped++});
 await reconcileEnrollmentBases(models,new Set(),load);assert.equal(models.size,0);assert.equal(stopped,1);
});

test('reverted getters with Solidity error data and inconsistent registries are rejected',async()=>{
 const { enrollmentMetadata, unsupportedGetter }=await import('../relayer/enrollment.mjs');
 assert.equal(unsupportedGetter({name:'ContractFunctionRevertedError',reason:'not registered'}),false);
 assert.equal(unsupportedGetter({name:'ContractFunctionRevertedError',raw:'0x12345678'}),false);
 const ch={meps:{read:{baseOf:async()=>base}},instances:{read:{enrollmentMep:async()=>'unrelated'}}};
 await assert.rejects(enrollmentMetadata(ch,child),/enrollment mismatch/);
});

test('BNB RPC empty revert getter falls back while reasoned and nonempty reverts fail closed',async()=>{
 const { enrollmentMetadata, unsupportedGetter }=await import('../relayer/enrollment.mjs');
 const empty={name:'ContractFunctionRevertedError',reason:'execution reverted: 0x',raw:'0x'};
 const wrapped={name:'ContractFunctionExecutionError',cause:empty};
 assert.equal(unsupportedGetter(wrapped),true);
 for(const e of [{...empty,raw:'0x12345678'},{...empty,reason:'execution reverted: denied'},{...empty,data:{errorName:'Denied'}}]) assert.equal(unsupportedGetter({cause:e}),false);
 const absent=async()=>{throw wrapped;};
 assert.deepEqual(await enrollmentMetadata({meps:{read:{baseOf:absent}},instances:{read:{enrollmentMep:absent}}},child),{baseMepId:null,enrollmentMepId:child});
});
