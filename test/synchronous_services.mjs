import test from 'node:test';
import assert from 'node:assert/strict';
const load=()=>import('../relayer/synchronous.mjs');
test('capability refuses unknown or inconsistent protocol declarations',async()=>{
 const {verificationMode}=await load();
 assert.equal(verificationMode({}), 'legacy');
 assert.equal(verificationMode({verification:{mode:'synchronous-v1'}}),'synchronous-v1');
 assert.throws(()=>verificationMode({verification:{mode:'synchronous-v2'}}),/unsupported/);
});
test('only completed sessions yield accepted output; disagreement and silence stay unaccepted',async()=>{
 const {sessionOutcome}=await load();
 for(const phase of [0,1,2,3]) assert.equal(sessionOutcome({phase}).terminal,false);
 assert.deepEqual(sessionOutcome({phase:4}),{terminal:true,accepted:true,status:'completed'});
 assert.deepEqual(sessionOutcome({phase:5}),{terminal:true,accepted:false,status:'inconclusive'});
 assert.throws(()=>sessionOutcome({phase:100}),/phase/);
});
test('bounded waiter does not settle or fail a live dispute; finalizes only after deadline',async()=>{
 const {waitForSession}=await load(); let reads=0,finalized=0,sleeps=0;
 const state=()=>({phase:reads++<2?3:5,overallDeadline:20n,commitDeadline:10n,revealDeadline:15n});
 const outcome=await waitForSession({read:state,block:async()=>21n,finalize:async()=>{finalized++;return 'receipt';},sleep:async()=>{sleeps++;}});
 assert.equal(outcome.state.phase,5);assert.equal(finalized,2);assert.equal(sleeps,2);
});
test('deadline block itself remains legal; no finalization at boundary',async()=>{
 const {waitForSession}=await load();let reads=0,finalized=0;
 await waitForSession({read:async()=>({phase:reads++?4:1,commitDeadline:10n,revealDeadline:15n,overallDeadline:20n}),block:async()=>10n,finalize:async()=>{finalized++;},sleep:async()=>{}});
 assert.equal(finalized,0);
});
test('protocol probe refuses legacy descriptor for synchronous address and failed claimed sync',async()=>{
 const {verifyDeployment}=await load();
 await assert.rejects(()=>verifyDeployment({},async()=>1n),/capability/);
 await assert.rejects(()=>verifyDeployment({verification:{mode:'synchronous-v1'}},async()=>{throw Object.assign(Error('no function'),{name:'ContractFunctionZeroDataError'});}),/capability/);
 assert.equal(await verifyDeployment({},async()=>{throw Object.assign(Error('no function'),{name:'ContractFunctionZeroDataError'});}),false);
 assert.equal(await verifyDeployment({verification:{mode:'synchronous-v1'}},async()=>1n),true);
});
test('sponsored readiness recovers instance rather than trusting metadata',async()=>{
 const {prepareSyncMutation}=await load();const {privateKeyToAccount}=await import('viem/accounts');
 const signer=privateKeyToAccount('0x'+'11'.repeat(32)), impostor=privateKeyToAccount('0x'+'22'.repeat(32));
 const hash='0x'+'ab'.repeat(32),signature=await signer.sign({hash});
 const deps={market:{read:{readinessDigest:async()=>hash}},instances:{read:{resolve:async a=>a[0]}}};
 const b={instance:impostor.address,ready:true,expiry:'30',nonce:'0',signature};
 await assert.rejects(()=>prepareSyncMutation('readiness',b,deps),/signature/);
 b.instance=signer.address;
 const action=await prepareSyncMutation('readiness',b,deps);assert.equal(action.functionName,'setReadyBySig');assert.equal(action.instance.toLowerCase(),signer.address.toLowerCase());
});
test('unknown methods and unbounded proof calldata are never forwarded',async()=>{
 const {prepareSyncMutation}=await load();
 await assert.rejects(()=>prepareSyncMutation('withdraw',{},{}),/unsupported/);
 await assert.rejects(()=>prepareSyncMutation('move',{data:'0x'+'aa'.repeat(262145)},{}),/calldata/);
});
test('session reads coalesce and conceal roots until both commitments; malformed ids never query RPC',async()=>{
 const {syncReader}=await load();let calls=0;const id='0x'+'aa'.repeat(32),instance='0x'+'11'.repeat(20);
 const ch={pub:{getBlock:async()=>({number:18n,hash:'0x123'})},market:{read:{sessionState:async()=>{calls++;return [1,30n,40n,60n];},executors:async()=>[instance],commitments:async()=>id,submitted:async()=>false}}};
 const read=syncReader(ch,{confirmations:2});
 const [a,b]=await Promise.all([read.session(id),read.session(id)]);
 assert.equal(calls,1);assert.equal(a.phase,1);assert.equal(a.block,'18');assert.equal('results' in a,false);assert.deepEqual(a,b);
 await assert.rejects(()=>read.session('bad'),/taskId/);assert.equal(calls,1);
});
test('expiry sponsorship signs the specific task, market, chain, instance and expiry',async()=>{
 const {prepareSyncFinalize,finalizeMessage}=await load();const {privateKeyToAccount}=await import('viem/accounts');const a=privateKeyToAccount('0x'+'11'.repeat(32));
 const dep={chainId:31337,addresses:{market:'0x'+'22'.repeat(20)}};const b={taskId:'0x'+'aa'.repeat(32),instance:a.address,expiry:'100'};
 b.signature=await a.signMessage({message:finalizeMessage(dep,b)});
 const ch={pub:{getBlockNumber:async()=>99n},instances:{read:{resolve:async x=>x[0]}},market:{}};
 assert.equal((await prepareSyncFinalize(dep,b,ch)).functionName,'expire');
 await assert.rejects(()=>prepareSyncFinalize({...dep,chainId:1},b,ch),/signature/);
 await assert.rejects(()=>prepareSyncFinalize(dep,{...b,taskId:'0x'+'bb'.repeat(32)},ch),/signature/);
 ch.pub.getBlockNumber=async()=>101n;await assert.rejects(()=>prepareSyncFinalize(dep,b,ch),/expired/);
});
test('confirmed completion reader refuses partial result and binds accepted root/digest',async()=>{
 const {acceptedSession}=await load();const id='0x'+'aa'.repeat(32),a='0x'+'11'.repeat(20),digest='0x'+'bb'.repeat(32),root='0x'+'cc'.repeat(32);
 const market={read:{sessionState:async()=>[3,1n,2n,3n],settledRef:async()=>a,settledDigest:async()=>digest,resultOf:async()=>[digest,root],executors:async()=>[a]}};
 await assert.rejects(()=>acceptedSession(market,id),/completed/);
 market.read.sessionState=async()=>[4,1n,2n,3n];assert.deepEqual(await acceptedSession(market,id),{execDigest:digest,execRoot:root,executors:[a]});
 market.read.settledDigest=async()=> '0x'+'00'.repeat(32);await assert.rejects(()=>acceptedSession(market,id),/digest/);
});
test('transport failure cannot downgrade a deployment to legacy',async()=>{
 const {verifyDeployment}=await load();await assert.rejects(()=>verifyDeployment({},async()=>{throw Error('HTTP request failed');}),/unavailable/);
});
test('profile certification is exact, cached across catalogs, and failures never imply support',async()=>{
 const {verificationSupportReader}=await load();let calls=0,fail=false,time=0;
 const base='0x'+'aa'.repeat(32),child='0x'+'bb'.repeat(32);
 const read=verificationSupportReader({market:{read:{profileMaxInDegree:async([id])=>{calls++;if(fail)throw Error('RPC failed');return id===base?10167:0;}}}},{ttl:100,now:()=>time});
 assert.deepEqual(await read(base),{supported:true,maxInDegree:10167});
 assert.deepEqual(await read(child),{supported:false,maxInDegree:0});await read(base);assert.equal(calls,2);
 time=101;fail=true;await assert.rejects(()=>read(base),/RPC failed/);fail=false;assert.equal((await read(base)).supported,true);assert.equal(calls,4);
});
test('announcements wait for finalized assignment and never dispatch after commit expiry',async()=>{
 const {assignmentReady}=await load();
 const state={phase:1,commitDeadline:'100'};
 assert.equal(assignmentReady(state,60n,49n,50n),'wait');
 assert.equal(assignmentReady(state,60n,50n,50n),'ready');
 assert.equal(assignmentReady(state,101n,100n,50n),'closed');
 assert.equal(assignmentReady({...state,phase:5},60n,50n,50n),'closed');
});
test('sponsor admission includes predicted gas and bounded synchronous readiness reserve',async()=>{
 const {sponsorAdmission,syncSponsorReady}=await load();
 assert.equal(sponsorAdmission(7000000n,1500000,50000000).ok,false);
 assert.equal(sponsorAdmission(100n,99,500).ok,false);
 assert.equal(sponsorAdmission(16777217n,50000000,50000000).ok,false);
 assert.equal(sponsorAdmission(100n,100,100).ok,true);
 assert.equal(syncSponsorReady(1500000,50000000,1000n,0n),false);
 assert.equal(syncSponsorReady(160000000,350000000,350000000n,1n),true);
 assert.equal(syncSponsorReady(160000000,350000000,349999999n,1n),false);
});
