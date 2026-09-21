import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {fundingPlan,PrivateJournal,validateDeployment,worker} from '../js/smoke_synchronous_testnet.mjs';
test('smoke funding is chain97 only and bounded including retained funding history',()=>{
 assert.throws(()=>validateDeployment({chainId:56}),/97/);
 assert.throws(()=>fundingPlan(10n**16n,[0n,0n]),/cap/);
 const p=fundingPlan(5n*10n**15n,[0n,3n*10n**15n]);assert.deepEqual(p,[6n*10n**15n,3n*10n**15n]);
 assert.throws(()=>fundingPlan(5n*10n**15n,[0n,0n],15n*10n**15n),/cap/);
});
test('private journal refuses repository paths and retains typed evidence privately across writes',()=>{
 assert.throws(()=>new PrivateJournal(path.resolve('secret-smoke.bin')),/outside/);
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'smoke-journal-')),file=path.join(dir,'private.bin');
 try{const j=new PrivateJournal(file);j.save({salt:new Uint8Array([1,2]),nonce:3n});assert.equal(fs.statSync(file).mode&0o777,0o600);assert.deepEqual(j.load(),{salt:new Uint8Array([1,2]),nonce:3n});j.save({nonce:4n});assert.equal(j.load().nonce,4n);fs.chmodSync(file,0o644);assert.throws(()=>new PrivateJournal(file),/0600/);}finally{fs.rmSync(dir,{recursive:true,force:true});}
});

test('smoke adapter loads actual WASM and validates exact locally computed LIF profile',async()=>{
 const H=await import('./harness.mjs');const {synthesizePayloadV2}=await H.porw('synth.js');const {PorwNode}=await H.porw('node.js');const {loadKernelFromBytes}=await H.porw('porw.js');
 const payload=synthesizePayloadV2('private-smoke',16,32),node=new PorwNode(await loadKernelFromBytes(fs.readFileSync(H.porwDir+'/sketch.wasm')));const m=await node.loadModel('private-smoke',payload,{exec:'lif',maxSteps:4}),mepId=H.hex(m.mep.mepId);
 const ask=await worker({},()=>{});await ask('prepare',{mepId,bytes:payload});assert.equal((await ask('host',{mepId,name:'private-smoke',exec:'lif',maxSteps:4})).matches,true);await ask('close');
});

test('interrupted readiness replays its exact durable signature and never trusts armed flag',async()=>{
 const {reconcileSmokeReadiness,confirmedSmokeReady}=await import('../js/smoke_synchronous_testnet.mjs');
 const zero='0x'+'00'.repeat(32),h={armed:true},p={ready:false,taskId:zero,nonce:0n,blockNumber:10n};let sends=0,arms=0;
 const authorization={ready:true,nonce:'0',expiry:'99',signature:'original'},host={session:{record:null},idleRecord:{readiness:[authorization]},chain:{pending:async()=>({...p}),read:async()=>p.nonce,client:{getBlockNumber:async()=>10n}},send:async(k,a)=>{assert.strictEqual(a,authorization);sends++;},readiness:async()=>{arms++;}};
 assert.equal(await confirmedSmokeReady({h,host,eligible:async()=>true}),false);
 await reconcileSmokeReadiness({h,host,eligible:async()=>true,commit:()=>{}});assert.equal(sends,1);assert.equal(arms,0);
 p.ready=true;p.nonce=1n;assert.equal(await confirmedSmokeReady({h,host,eligible:async()=>true}),true);assert.equal(await confirmedSmokeReady({h,host,eligible:async()=>false}),false);
});
test('pre-submit interruption can arm, but consumed readiness or any task journal never re-arms or prints READY',async()=>{
 const {reconcileSmokeReadiness,confirmedSmokeReady}=await import('../js/smoke_synchronous_testnet.mjs');let arms=0;
 const h={armed:true},p={ready:false,taskId:'0x'+'00'.repeat(32),nonce:0n},host={session:{record:null},chain:{pending:async()=>p,read:async()=>p.nonce},readiness:async()=>{arms++;}};
 const args={h,host,eligible:async()=>true,commit:()=>{}};await reconcileSmokeReadiness(args);assert.equal(arms,1);
 host.idleRecord={readiness:[{nonce:'0',ready:true}]};p.nonce=1n;await reconcileSmokeReadiness(args);assert.equal(arms,1);assert.equal(h.readinessConsumed,true);
 for(const phase of ['committing','completed','inconclusive']){host.session.record={taskId:'task',phase};p.ready=true;await reconcileSmokeReadiness(args);assert.equal(arms,1);assert.equal(await confirmedSmokeReady(args),false);}
});
test('preflight reads live protocol and exact certificate and rejects revoked or oversized support',async()=>{
 const {validateLiveSupport}=await import('../js/smoke_synchronous_testnet.mjs');const calls=[];let version=1n,degree=12;
 const client={readContract:async a=>{calls.push(a);return a.functionName==='protocolVersion'?version:degree;}};
 await validateLiveSupport(client,'market','exact-mep');assert.deepEqual(calls[1].args,['exact-mep']);
 degree=0;await assert.rejects(validateLiveSupport(client,'market','exact-mep'),/certificate/);
 degree=16385;await assert.rejects(validateLiveSupport(client,'market','exact-mep'),/certificate/);
 degree=12;version=2n;await assert.rejects(validateLiveSupport(client,'market','exact-mep'),/protocol/);
});

test('latest nonce advancement waits for finality without replay or premature READY',async()=>{
 const {reconcileSmokeReadiness,confirmedSmokeReady}=await import('../js/smoke_synchronous_testnet.mjs');let sends=0,arms=0;
 const h={instance:'host'},p={ready:false,taskId:'0x'+'00'.repeat(32),nonce:0n};
 const host={session:{record:null},idleRecord:{readiness:[{ready:true,nonce:'0',expiry:'99',signature:'saved'}]},chain:{pending:async()=>p,read:async(name,args)=>{assert.equal(name,'readinessNonce');assert.deepEqual(args,['host']);return 1n;},client:{getBlockNumber:async()=>10n}},send:async()=>{sends++;},readiness:async()=>{arms++;}};
 const args={h,host,eligible:async()=>true,commit:()=>{}};await reconcileSmokeReadiness(args);assert.equal(sends,0);assert.equal(arms,0);assert.equal(await confirmedSmokeReady(args),false);assert.equal(h.readinessConsumed,undefined);
 p.ready=true;p.nonce=1n;assert.equal(await confirmedSmokeReady(args),true);
});

test('public funding amounts format both hosts as BNB without treating array indexes as units',async()=>{
 const {formatFundingPlan}=await import('../js/smoke_synchronous_testnet.mjs');assert.deepEqual(formatFundingPlan([6000000000000000n,6000000000000000n]),['0.006','0.006']);
});
