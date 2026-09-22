import test from 'node:test';import assert from 'node:assert/strict';import * as mod from '../frontend/src/core/synchronous-chain.js';
test('chain adapter requires explicit supported capability before any RPC request',()=>{assert.equal(typeof mod.createSynchronousChain,'function');assert.throws(()=>mod.createSynchronousChain({deployment:{verification:{mode:'unknown'}}}),/capability/);});
test('snapshot pins all calls to a finalized block and rejects reorg during reads',async()=>{
 const instance='0x'+'11'.repeat(20),other='0x'+'22'.repeat(20),market='0x'+'33'.repeat(20),id='0x'+'44'.repeat(32);let changed=false;const blocks=[];
 const chain=mod.createSynchronousChain({deployment:{chainId:31337,verification:{mode:'synchronous-v1'},addresses:{market,disputes:other}},instance,client:{getChainId:async()=>31337,getBlock:async args=>({number:9n,hash:changed&&args.blockNumber?'changed':'stable'}),readContract:async x=>{blocks.push(x.blockNumber);return {protocolVersion:1n,sessionState:[4,3n,6n,10n],pendingTask:'0x'+'00'.repeat(32),ready:false,commitments:id,submitted:true,executors:[instance,other]}[x.functionName];}}});
 const result=await chain.snapshot({taskId:id});assert.equal(result.confirmed,true);assert.ok(blocks.every(x=>x===9n));changed=true;await assert.rejects(chain.snapshot({taskId:id}),/reorganized/);
});
test('VRF pending candidate is reserved without an executor pair and exposes bounded wait',async()=>{
 const instance='0x'+'11'.repeat(20),market='0x'+'22'.repeat(20),controller='0x'+'33'.repeat(20),id='0x'+'44'.repeat(32);
 const chain=mod.createSynchronousChain({deployment:{chainId:31337,verification:{mode:'synchronous-vrf-v1'},addresses:{market}},instance,client:{getChainId:async()=>31337,getBlock:async()=>({number:9n,hash:'stable'}),readContract:async x=>({protocolVersion:1n,admissionVersion:2n,admission:controller,sessionState:[6,0n,0n,200n],pendingTask:id,ready:false,readinessNonce:2n,requestInfo:[5n,30n,0n,0n,200n,1,3]})[x.functionName]}});
 const result=await chain.pending();assert.equal(result.phase,6);assert.equal(result.admission.requestId,'5');assert.equal(result.admission.randomnessDeadline,'30');
});
