import test from 'node:test';
import assert from 'node:assert/strict';
import {verificationMode,verifyDeployment,sessionOutcome,assignmentReady,synchronousInbox} from '../relayer/synchronous.mjs';
const dep=mode=>({verification:{mode}});
test('VRF admission is an explicit versioned capability and cannot be mislabeled',async()=>{
 assert.equal(verificationMode(dep('synchronous-vrf-v1')),'synchronous-vrf-v1');
 assert.equal(await verifyDeployment(dep('synchronous-vrf-v1'),async()=>1n,async()=>2n),true);
 await assert.rejects(verifyDeployment(dep('synchronous-v1'),async()=>1n,async()=>2n),/admission/);
 await assert.rejects(verifyDeployment(dep('synchronous-vrf-v1'),async()=>1n,async()=>1n),/admission/);
 await assert.rejects(verifyDeployment(dep('synchronous-vrf-v1'),async()=>1n,async()=>{throw Error('RPC failed');}),/admission/);
 await assert.rejects(verifyDeployment(dep('synchronous-vrf-v1'),async()=>1n),/admission/);
});
test('awaiting randomness is neither completed nor executable',()=>{
 assert.deepEqual(sessionOutcome({phase:6}),{terminal:false,accepted:false,status:'awaiting randomness'});
 assert.equal(assignmentReady({phase:6,commitDeadline:0n},10n,10n,1n),'wait');
});
test('VRF inbox uses frozen task signer, never mutable readiness signer',async()=>{
 const host='0x'+'11'.repeat(20), signer='0x'+'22'.repeat(20), id='0x'+'33'.repeat(32);
 const ch={verificationMode:'synchronous-vrf-v1',pub:{getBlock:async()=>({number:10n,hash:'0xaa'})},market:{read:{taskSigner:async args=>{assert.deepEqual(args,[id,host]);return signer;},readinessSigner:async()=>{throw Error('mutable signer forbidden');},pendingTask:async()=>id,sessionState:async()=>[1,20n,30n,40n]}},instances:{read:{resolve:async()=>host,delegations:async()=>[host,40n]}}};
 assert.equal(await synchronousInbox(ch,host,id),signer);
});
test('VRF progression uses fulfillment deadline and never discards a timely seed',async()=>{
 const {admissionAction}=await import('../relayer/vrf-admission.mjs');
 const waiting={state:1,randomnessDeadline:'100',allocationDeadline:'0'};
 assert.equal(admissionAction(waiting,100n),null);assert.equal(admissionAction(waiting,101n),'expire');
 const fulfilled={...waiting,state:2,fulfilledAt:'95',allocationDeadline:'115'};
 assert.equal(admissionAction(fulfilled,101n),'allocate');assert.equal(admissionAction(fulfilled,115n),'allocate');assert.equal(admissionAction(fulfilled,116n),'expire');
 assert.equal(admissionAction({...fulfilled,state:3},120n),null);
});
test('crash recovery finds original phase-6 posting transaction without reposting',async()=>{
 const {recoverPost}=await import('../gateway/vrf-post.mjs');const {parseAbi,encodeFunctionData}=await import('viem');
 const market='0x'+'11'.repeat(20),sender='0x'+'22'.repeat(20),id='0x'+'33'.repeat(32),nonce='0x'+'44'.repeat(32),abi=parseAbi(['function postTask(uint256,bytes32) payable']);
 const input=encodeFunctionData({abi,functionName:'postTask',args:[1n,nonce]});
 const ch={account:{address:sender},market:{address:market,abi,read:{tasks:async()=>[{},sender,0n,100n,0n,true,false,false,false]}},pub:{getBlock:async options=>{assert.equal(options.blockNumber,100n);return{transactions:[{hash:id,to:market,from:sender,input}]};}}};
 assert.equal(await recoverPost(ch,id,1n,nonce),id);
 ch.pub.getBlock=async()=>({transactions:[]});await assert.rejects(recoverPost(ch,id,1n,nonce),/original posting transaction/);
 ch.market.read.tasks=async()=>[{},sender,0n,0n,0n,false];assert.equal(await recoverPost(ch,id,1n,nonce),null);
});
test('only confirmed admission is expense; reverted hash is only reserved budget',async()=>{
 const {admissionExpense}=await import('../gateway/vrf-post.mjs');
 assert.equal(admissionExpense({post_tx:'0xaa',admission_fee_wei:'7'}),'0');
 assert.equal(admissionExpense({post_confirmed:true,admission_fee_wei:'7'}),'7');
 assert.equal(admissionExpense({post_confirmed:true,admission_fee_wei:'7',receipt:{admission_fee_wei:'3'}}),'3');
});
test('VRF post persists the signed transaction before broadcast and replays identical bytes',async()=>{
 const {persistVrfPost,broadcastVrfPost}=await import('../gateway/vrf-post.mjs');const {parseAbi}=await import('viem');let saved=false,prepared=0;const sent=[];
 const c={task:{fee:'10'},admission_fee_wei:'2',nonce:'0x'+'44'.repeat(32)},ch={account:{address:'0x'+'11'.repeat(20)},market:{address:'0x'+'22'.repeat(20),abi:parseAbi(['function postTask(uint256,bytes32) payable']),estimateGas:{postTask:async()=>100n}},wallet:{prepareTransactionRequest:async r=>{prepared++;return r;},signTransaction:async()=>'0xabcd'},pub:{request:async({params})=>{assert.equal(saved,true);sent.push(params[0]);}}};
 await persistVrfPost(ch,c,1n,()=>{saved=true;});await broadcastVrfPost(ch,c);const raw=c.post_raw;
 await persistVrfPost(ch,c,1n,()=>{});await broadcastVrfPost(ch,c);assert.equal(prepared,1);assert.deepEqual(sent,[raw,raw]);assert.ok(c.post_tx);
});
test('runtime market ABI includes stored task evidence used by outbox recovery',async()=>{
 const {SynchronousMarketAbi}=await import('../relayer/synchronous.mjs');assert.ok(SynchronousMarketAbi.some(x=>x.type==='function'&&x.name==='tasks'));
});
