import test from 'node:test';
import assert from 'node:assert/strict';
import {verifyDeployment,verificationMode} from '../relayer/synchronous.mjs';
import {admissionAction,readAdmission,advanceAdmission} from '../relayer/vrf-admission.mjs';
const mode='synchronous-vrf-rounds-v1';
test('round admission is an explicit v3 capability and never silently treated as v2',async()=>{
 assert.equal(verificationMode({verification:{mode}}),mode);
 assert.equal(await verifyDeployment({verification:{mode}},async()=>1n,async()=>3n),true);
 await assert.rejects(verifyDeployment({verification:{mode}},async()=>1n,async()=>2n),/admission/);
 await assert.rejects(verifyDeployment({verification:{mode:'synchronous-vrf-v1'}},async()=>1n,async()=>3n),/admission/);
});
test('collecting round seals only after cutoff and expires instead of buying a late reroll',()=>{
 const info={state:5,closeBlock:'100',randomnessDeadline:'120',roundId:'7'};
 assert.equal(admissionAction(info,99n),null);
 assert.equal(admissionAction(info,100n),'sealRound');
 assert.equal(admissionAction(info,120n),'sealRound');
 assert.equal(admissionAction(info,121n),'expire');
});
test('round observation uses the same block for task and shared round metadata',async()=>{
 const calls=[],ch={verificationMode:mode,market:{read:{admission:async()=> '0x'+'11'.repeat(20)}},pub:{readContract:async o=>{calls.push(o);return o.functionName==='requestInfo'?[0n,120n,0n,0n,500n,5,3]:o.functionName==='taskRound'?7n:[100n,120n,0n,0n,0n,0,2];}}};
 const r=await readAdmission(ch,'0x'+'22'.repeat(32),{blockNumber:90n});assert.equal(r.roundId,'7');assert.equal(r.closeBlock,'100');assert.equal(r.roundTaskCount,2);assert(calls.every(c=>c.blockNumber===90n));
});
test('round progression submits roundId, never taskId, and rechecks finalized action',async()=>{
 const sent=[],ch={verificationMode:mode,account:{address:'0x'+'33'.repeat(20)},pub:{waitForTransactionReceipt:async()=>({status:'success'}),getBlock:async o=>({number:110n,hash:'0xaa'}),getBlockNumber:async()=>110n,readContract:async o=>o.functionName==='requestInfo'?[0n,120n,0n,0n,500n,5,3]:o.functionName==='taskRound'?7n:[100n,120n,0n,0n,0n,0,2]},market:{read:{sessionState:async()=>[6],admission:async()=> '0x'+'11'.repeat(20)},simulate:{sealRound:async a=>sent.push(['simulate',a])},estimateGas:{sealRound:async()=>100n},write:{sealRound:async a=>{sent.push(['write',a]);return '0xhash';}}}};
 assert.equal(await advanceAdmission(ch,'0x'+'22'.repeat(32),fn=>fn()),'0xhash');assert.deepEqual(sent,[['simulate',[7n]],['write',[7n]]]);
});

test('round pending API exposes all memberships at one finalized block',async()=>{
 const {syncReader}=await import('../relayer/synchronous.mjs');
 const ids=['0x'+'aa'.repeat(32),'0x'+'bb'.repeat(32)],instance='0x'+'11'.repeat(20),seen=[];
 const read=syncReader({verificationMode:mode,pub:{getBlock:async()=>({number:90n,hash:'0xaa'})},market:{read:{pendingTask:async()=>ids[0],pendingTasks:async(a,o)=>{seen.push(o.blockNumber);return ids;},ready:async()=>true,readinessNonce:async()=>1n}}});
 const result=await read.pending(instance);assert.deepEqual(result.taskIds,ids);assert.equal(result.taskId,ids[0]);assert.deepEqual(seen,[90n]);
});
test('round seal sponsorship binds task, chain and action, resolving only its locked round',async()=>{
 const {prepareSyncFinalize,finalizeMessage}=await import('../relayer/synchronous.mjs');const {privateKeyToAccount}=await import('viem/accounts');
 const a=privateKeyToAccount('0x'+'11'.repeat(32)),dep={chainId:31337,verification:{mode},addresses:{market:'0x'+'22'.repeat(20)}};
 const b={taskId:'0x'+'aa'.repeat(32),instance:a.address,expiry:'100'};
 const ch={verificationMode:mode,pub:{getBlockNumber:async()=>99n,readContract:async o=>o.functionName==='requestInfo'?[0n,120n,0n,0n,500n,5,2]:o.functionName==='taskRound'?7n:[100n,120n,0n,0n,0n,0,2]},instances:{read:{resolve:async x=>x[0]}},market:{read:{admission:async()=>dep.addresses.market}}};
 b.signature=await a.signMessage({message:finalizeMessage(dep,b).replace('synchronous expiry','synchronous round sealing')});
 const action=await prepareSyncFinalize(dep,b,ch,'sealRound');assert.equal(action.functionName,'sealRound');assert.deepEqual(action.args,[7n]);
 await assert.rejects(prepareSyncFinalize(dep,b,ch,'allocate'),/signature/);
 await assert.rejects(prepareSyncFinalize({...dep,chainId:1},b,ch,'sealRound'),/signature/);
});
test('round inbox accepts a non-first pending task while preserving live signer checks',async()=>{
 const {synchronousInbox}=await import('../relayer/synchronous.mjs');const host='0x'+'11'.repeat(20),id='0x'+'aa'.repeat(32);
 const ch={verificationMode:mode,pub:{getBlock:async()=>({number:100n,hash:'0xaa'})},market:{read:{pendingTask:async()=>{throw Error('first-only gate forbidden');},taskSigner:async()=>host,hasPendingTask:async()=>true,sessionState:async()=>[1,120n,130n,200n]}},instances:{read:{resolve:async()=>host}}};
 assert.equal(await synchronousInbox(ch,host,id),host);ch.market.read.hasPendingTask=async()=>false;await assert.rejects(synchronousInbox(ch,host,id),/assignment/);
});

test('keeper race after head recheck does not fail a posted task',async()=>{
 let advanced=false;
 const ch={verificationMode:mode,account:{},pub:{getBlock:async()=>({number:110n,hash:'0xaa'}),getBlockNumber:async()=>110n,readContract:async o=>o.functionName==='requestInfo'?[advanced?1n:0n,120n,0n,0n,500n,advanced?1:5,2]:o.functionName==='taskRound'?7n:[100n,120n,advanced?1n:0n,0n,0n,advanced?1:5,2]},market:{read:{sessionState:async()=>[6],admission:async()=> '0x'+'11'.repeat(20)},simulate:{sealRound:async()=>{advanced=true;throw Error('another keeper sealed');}}}};
 assert.equal(await advanceAdmission(ch,'0x'+'22'.repeat(32),fn=>fn()),null);
 advanced=false;ch.market.simulate.sealRound=async()=>{ch.pub.getBlockNumber=async()=>121n;throw Error('insufficient funds');};
 await assert.rejects(advanceAdmission(ch,'0x'+'22'.repeat(32),fn=>fn()),/insufficient funds/);
});
