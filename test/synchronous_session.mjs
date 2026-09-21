import test from 'node:test';
import assert from 'node:assert/strict';
import * as mod from '../frontend/src/core/synchronous-session.js';
const id = '0x'+'11'.repeat(32), instance='0x'+'22'.repeat(20), market='0x'+'33'.repeat(20);
const assignment={taskId:id,instance,market,chainId:31337,commitDeadline:10,revealDeadline:20,totalDeadline:50,manifest:{model:new Uint8Array([1,2]),inputs:[7]}};
function rig(storage={record:null}) {
 let chain={confirmed:true,blockNumber:5,state:1,taskId:id,instance,market,chainId:31337,pendingTask:id,ready:false,committed:false,revealed:false};
 const sent=[];let signs=0,executions=0;
 const journal={load:async()=>structuredClone(storage.record),save:async r=>{storage.record=structuredClone(r);}};
 const transport={send:async(kind,payload)=>{assert.ok(storage.record,'persist before transport');sent.push({kind,payload:structuredClone(payload)});}};
 const session=new mod.SynchronousSession({journal,chain:{snapshot:async()=>structuredClone(chain)},transport,
 signer:{sign:async h=>{signs++;return 'signed:'+h;}},hashes:{result:async()=> 'result-hash',commitment:async()=> 'commitment',commit:async()=> 'commit-hash'},
 execute:async()=>{executions++;return {execRoot:'root',execDigest:'digest'};},randomSalt:()=> 'salt',onChange:()=>{}});
 return {session,sent,storage,chain,setChain:x=>Object.assign(chain,x),counts:()=>({signs,executions})};
}
test('persists exact manifest, salt and signatures before commit; restart never reexecutes or re-signs',async()=>{
 assert.equal(typeof mod.SynchronousSession,'function');
 const r=rig();await r.session.begin(assignment);await r.session.tick();
 assert.deepEqual(r.sent.map(x=>x.kind),['commit']);assert.equal(r.storage.record.salt,'salt');assert.equal(r.storage.record.manifest.model[1],2);
 const restarted=rig(r.storage);await restarted.session.restore();await restarted.session.tick();
 assert.deepEqual(restarted.sent,r.sent);assert.deepEqual(restarted.counts(),{signs:0,executions:0});
});
test('reveal waits for confirmed both-committed state and resends the original signed result',async()=>{
 const r=rig();await r.session.begin(assignment);r.setChain({state:2,confirmed:false});await assert.rejects(r.session.tick(),/confirmed/);assert.equal(r.sent.length,0);
 r.setChain({confirmed:true,state:1,committed:true});await r.session.tick();assert.equal(r.sent.length,0);
 r.setChain({state:2});await r.session.tick();assert.equal(r.sent[0].kind,'reveal');assert.equal(r.sent[0].payload.resultSignature,'signed:result-hash');
});
test('single session admission and chain domain mismatches fail closed',async()=>{
 const r=rig();await r.session.begin(assignment);await assert.rejects(r.session.begin({...assignment,taskId:'other'}),/active/);
 r.setChain({market:'wrong'});await assert.rejects(r.session.tick(),/identity/);assert.equal(r.sent.length,0);
});
test('terminal outcome does not authorize close while ready or pending; inconclusive remains inconclusive',async()=>{
 const r=rig();await r.session.begin(assignment);r.setChain({state:5,ready:true,pendingTask:null});await r.session.tick();assert.equal(r.session.status.safeToClose,false);
 r.setChain({ready:false,pendingTask:id});await r.session.tick();assert.equal(r.session.status.safeToClose,false);
 r.setChain({pendingTask:null});await r.session.tick();assert.equal(r.session.status.safeToClose,true);assert.equal(r.session.status.phase,'inconclusive');
 assert.ok(r.storage.record.manifest); // no evidence deletion on terminal or before reload
});
test('storage failure publishes no commitment and cannot lose the active obligation',async()=>{
 const r=rig();r.session.journal.save=async()=>{throw Error('quota')};await assert.rejects(r.session.begin(assignment),/quota/);assert.equal(r.sent.length,0);assert.equal(r.session.status.safeToClose,false);
});
test('deadline expiry requests finalization, never fabricates success',async()=>{
 const r=rig();await r.session.begin(assignment);r.setChain({blockNumber:51});await r.session.tick();assert.equal(r.sent[0].kind,'finalize');assert.equal(r.session.status.safeToClose,false);
});
test('failed signature persistence cannot be bypassed by an in-memory retry',async()=>{const r=rig();const save=r.session.journal.save;r.session.journal.save=async x=>{if(x.commitSignature)throw Error('disk full');return save(x)};await assert.rejects(r.session.begin(assignment),/disk full/);await assert.rejects(r.session.tick(),/disk full/);assert.equal(r.sent.length,0);});
test('terminal cannot close until the saved drain authorization nonce is consumed',async()=>{const r=rig();await r.session.begin(assignment);r.session.record.readiness=[{ready:false,nonce:'4'}];r.setChain({state:4,ready:false,pendingTask:null,readinessNonce:4n});await r.session.tick();assert.equal(r.session.status.safeToClose,false);r.setChain({readinessNonce:5n});await r.session.tick();assert.equal(r.session.status.safeToClose,true);});
test('all immutable block deadlines are exposed before execution begins',async()=>{const r=rig();r.session.execute=async()=>{assert.equal(r.session.status.commitDeadline,10);assert.equal(r.session.status.revealDeadline,20);assert.equal(r.session.status.totalDeadline,50);return{execRoot:'root',execDigest:'digest'}};await r.session.begin(assignment);});
test('expired dispute round finalizes inconclusive without waiting for the overall deadline',async()=>{const r=rig();await r.session.begin(assignment);r.setChain({state:3,blockNumber:25,dispute:{deadline:24n}});await r.session.tick();assert.equal(r.sent[0].kind,'finalize');assert.equal(r.session.status.safeToClose,false);});
