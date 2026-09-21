import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {parseEther,keccak256,encodeFunctionData,parseAbi} from 'viem';
import {privateKeyToAccount} from 'viem/accounts';
import * as H from './harness.mjs';
import {clients} from '../relayer/chain.mjs';
const wait=async fn=>{for(let i=0;i<200;i++){if(await fn())return;await H.sleep(100);}throw Error('timed out waiting for chain/service');};
const anvil=await H.startAnvil(Number(process.env.SYNC_GATEWAY_TEST_PORT||8598));const cleanup=[];
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'sync-gateway-'));
try {
 const dep=await H.deploy(anvil.rpc,{EPOCH_BLOCKS:'1000',CLAIM_VALIDITY_EPOCHS:'3'}),owner=H.clientsFor(dep,H.KEYS[0]);
 dep.addresses.market=await H.create(owner,'SynchronousTaskMarket',[dep.addresses.meps,dep.addresses.instances,dep.addresses.claims,120n,40n,300n]);
 dep.addresses.disputes=await H.create(owner,'SynchronousExecutionDisputes',[dep.addresses.meps,dep.addresses.instances,dep.addresses.market,5n,parseEther('0.01')]);
 const cap=await H.create(owner,'HostCapacity');dep.verification={mode:'synchronous-v1'};
 await H.sendTo(owner,cap,'HostCapacity','setMarket',[dep.addresses.market,true]);
 await H.sendTo(owner,dep.addresses.market,'SynchronousTaskMarket','setHostCapacity',[cap]);
 await H.sendTo(owner,dep.addresses.market,'SynchronousTaskMarket','setDisputes',[dep.addresses.disputes]);
 await H.sendTo(owner,dep.addresses.instances,'InstanceRegistry','setSlasher',[dep.addresses.market,true]);
 const {PorwNode}=await H.porw('node.js'),{loadKernelFromBytes}=await H.porw('porw.js'),{synthesizePayloadV2}=await H.porw('synth.js');
 const {RelayClient}=await H.porw('relay_client.js'),{NodeService}=await H.porw('node_service.js');const E=await H.porw('eip712.js');
 const wasm=fs.readFileSync(path.join(H.porwDir,'sketch.wasm')),payload=synthesizePayloadV2('sync-service-brain',1025,1024);
 const pv=new DataView(payload.buffer,payload.byteOffset,payload.byteLength),synOffset=30+new TextEncoder().encode('sync-service-brain').length+1025*8;for(let i=0;i<1024;i++){pv.setUint32(synOffset+i*10,i+1,true);pv.setUint32(synOffset+i*10+4,0,true);}
 const probe=new PorwNode(await loadKernelFromBytes(wasm));const model=await probe.loadModel('sync-service-brain',payload,{exec:'lif',maxSteps:4}),mepId=H.hex(model.mep.mepId);
 await owner.pub.waitForTransactionReceipt({hash:await owner.meps.write.registerMEP([{modelId:H.hex(model.mep.modelId),schemeDigest:H.hex(model.mep.schemeDigest),execKind:H.hex(model.mep.execKind),neurons:1025,synapses:1024,synapseRoot:H.hex(model.csr.synapseRoot),weightsDA:'0x'+Buffer.from('gnfd://test/sync').toString('hex')}])});
 const rowStarts=probe.k.u32(model.csr.rowStartPtr,model.hdr.neurons+1);let maxRow=0;for(let i=0;i<model.hdr.neurons;i++)maxRow=Math.max(maxRow,rowStarts[i+1]-rowStarts[i]);
 await H.sendTo(owner,dep.addresses.market,'SynchronousTaskMarket','setProfileSupport',[mepId,maxRow]);
 const gateway=clients(dep,H.KEYS[4]);const R=await H.startRelayer(dep,H.KEYS[3],[mepId],{env:{PORW_VERIFICATION_MODE:'synchronous-v1',PORW_SYNC_CONFIRMATIONS:'0',PORW_TASK_CLIENTS:gateway.account.address.toLowerCase(),PORW_BEACON_LAZY:'1',PORW_SPONSOR_EPOCH_GAS:'160000000',PORW_SPONSOR_DAY_GAS:'350000000'}});cleanup.push(()=>R.stop());
 const published=await R.api('/deployment');const failures=[];
 const catalog=await R.api('/meps');assert.deepEqual(catalog.find(m=>m.mepId===mepId).verificationSupport,{supported:true,maxInDegree:maxRow});
 const hosts=[];
 for(const key of [H.KEYS[1],H.KEYS[2]]){
  const c=clients(dep,key);await c.pub.waitForTransactionReceipt({hash:await c.instances.write.bond([[mepId]],{value:parseEther('0.5')})});
  const sessionKey='0x'+(hosts.length?'22':'11').repeat(32),session=privateKeyToAccount(sessionKey);const delegation=await E.makeDelegation(E.localWallet(key),published.domains.registry,session.address,100000);
  assert.equal((await R.api('/tx/delegate',{instance:delegation.instance,session:delegation.session,expiry:delegation.expiry,sig:delegation.sig})).ok,true);await H.sendTo(c,cap,'HostCapacity','setCapacity',[1]);
  const node=new PorwNode(await loadKernelFromBytes(wasm),{privHex:sessionKey,domains:published.domains,delegation});await node.loadModel('sync-service-brain',payload,{exec:'lif',maxSteps:4});
  const relay=new RelayClient([published.relay],node.key);await relay.connect();cleanup.push(()=>relay.close());
  const service=new NodeService(node,relay);service.serve(model.mep.mepId,{tasks:false});
  const arm=async()=>{const nonce=await c.market.read.readinessNonce([c.account.address]),expiry=await c.pub.getBlockNumber({cacheTime:0})+500n;const hash=await c.market.read.readinessDigest([c.account.address,true,expiry,nonce]);const r=await R.api('/tx/sync/readiness',{instance:c.account.address,ready:true,expiry:String(expiry),nonce:String(nonce),signature:await c.account.sign({hash})});assert.equal(r.ok,true,JSON.stringify(r));};
  const host={c,node,relay,service,arm,stopTask:null};hosts.push(host);
  host.stopTask=relay.serve('task-announce',mepId,async env=>{
   try {
    const p=env.payload,r=await node.execute(model.mep.mepId,{steps:p.steps,commitStride:p.commitStride,stimulusSeed:p.stimulusSeed,stimulusIds:p.stimulusIds?Uint32Array.from(p.stimulusIds):null,silenceIds:p.silenceIds?Uint32Array.from(p.silenceIds):null});
    assert.equal(H.hex(r.result.initStateRoot),p.initStateRoot);
    const execDigest=H.hex(r.result.execDigest),execRoot=H.hex(r.result.execRoot),salt='0x'+(hosts.indexOf(host)?'bb':'aa').repeat(32),instance=c.account.address;
    const commitment=await c.market.read.resultCommitment([p.taskId,instance,execDigest,execRoot,salt]);
    const signature=await session.sign({hash:await c.market.read.commitmentDigest([p.taskId,instance,commitment])});
    const commit=await R.api('/tx/sync/commit',{taskId:p.taskId,instance,commitment,signature});assert.equal(commit.ok,true,JSON.stringify(commit));
    await wait(async()=>Number((await c.market.read.sessionState([p.taskId]))[0])===2);
    const reveal=await R.api('/tx/sync/reveal',{taskId:p.taskId,instance,execDigest,execRoot,salt,signature:await session.sign({hash:await c.market.read.resultDigest([p.taskId,instance,execDigest,execRoot])})});assert.equal(reveal.ok,true,JSON.stringify(reveal));
    await wait(async()=>Number((await c.market.read.sessionState([p.taskId]))[0])===4);
    return {type:'result',payload:{taskId:p.taskId,execDigest,execRoot:'0x'+'ab'.repeat(32),counts:Buffer.from(r.result.counts.buffer,r.result.counts.byteOffset,r.result.counts.byteLength).toString('base64'),countsEncoding:'u32le-base64'}};
   }catch(e){failures.push(e);return {type:'result-refused',payload:{reason:e.message}};}
  });
 }
 const to=async b=>{const head=await anvil.block();if(head<b)await anvil.mine(b-head);};
 const enter=async e=>{await to(e*1000-5);await wait(async()=>(await R.api('/status')).commits.includes(e));await to(e*1000+2);await wait(async()=>(await R.api('/status')).reveals.includes(e));await to(e*1000+12);await wait(async()=>(await R.api('/status')).epochsRolled.includes(e));};
 await R.api('/wake',{instance:hosts[0].c.account.address});await enter(1);console.log('epoch 1 ready');
 const ep=await R.api('/epoch?mep='+mepId);for(const h of hosts)await h.service.announce(model.mep.mepId,H.unhex(ep.challenge));
 await enter(2);console.log('epoch 2 ready');await wait(async()=>(await R.api('/status')).rootsPosted.some(r=>r.epoch===1&&r.count===2));
 for(const h of hosts){const r=await R.api('/tx/materialize',{mep:mepId,epoch:1,instance:h.c.account.address});assert.equal(r.ok,true,JSON.stringify(r));await h.arm();}
 console.log('signed hosts ready and eligible');
 const G=await H.startGateway(R,H.KEYS[4],{GATEWAY_BEARER:'test',GATEWAY_MODELS:`sync=${mepId}`,GATEWAY_STATE:path.join(tmp,'state.json'),GATEWAY_POLL_MS:'100',GATEWAY_RESULT_TIMEOUT_MS:'15000'});cleanup.push(()=>G.stop());
 const call=async body=>{const r=await fetch(G.url+'/v1/responses',{method:'POST',headers:{authorization:'Bearer test','content-type':'application/json'},body:JSON.stringify(body)});return {status:r.status,body:await r.json()};};
 console.log('gateway ready');
 let delivered=false;const agreement=call({model:'sync',seed:7,max_output_tokens:4}).then(r=>{delivered=true;return r;});
 await wait(async()=>BigInt(await gateway.market.read.pendingTask([hosts[0].c.account.address]))!==0n);
 const agreedId=await gateway.market.read.pendingTask([hosts[0].c.account.address]);
 await anvil.mine(64);
 await wait(async()=>Number((await gateway.market.read.sessionState([agreedId]))[0])===4);
 await H.sleep(300);assert.equal(delivered,false,'latest completion must not publish as finalized');
 await anvil.mine(64);
 const agreed=await agreement;if(agreed.status!==200)console.log(JSON.stringify(agreed),G.log(),failures);
 assert.equal(agreed.status,200);assert.equal(agreed.body.status,'completed');assert.equal(agreed.body.receipt.exec_root,(await gateway.market.read.resultOf([agreed.body.id,agreed.body.receipt.executors[0]]))[1]);assert.equal(agreed.body.receipt.finality,'final');assert.equal(agreed.body.receipt.verification,'synchronous-v1');assert.equal(agreed.body.receipt.counts.status,'verified');assert.equal(agreed.body.receipt.executors.length,2);assert.equal(failures.length,0);
 for(const h of hosts){assert.equal(await h.c.market.read.ready([h.c.account.address]),false);await h.arm();h.stopTask();}
 const pending=await call({model:'sync',seed:8,max_output_tokens:4,background:true});assert.equal(pending.status,200);
 const taskId=pending.body.id;await wait(async()=>Number((await gateway.market.read.sessionState([taskId]))[0])===1);
 const state=await gateway.market.read.sessionState([taskId]);await to(Number(state[1])+1);
 await wait(async()=>Number((await gateway.market.read.sessionState([taskId]))[0])===5);await anvil.mine(64);
 let failed;await wait(async()=>{failed=await(await fetch(G.url+'/v1/responses/'+taskId,{headers:{authorization:'Bearer test'}})).json();return failed.status==='failed';});
 assert.equal(failed.error.type,'inconclusive');assert.equal(failed.receipt.refunded,true);assert.equal(failed.usage?.output_tokens??0,0);assert.equal(Number((await gateway.market.read.sessionState([taskId]))[0]),5);
 assert.equal(failures.length,0);
 // A real open dispute exercises the sponsored selector boundary, not a missing-task revert.
 for(const h of hosts)await h.arm();
 const disputedTask={mepId,stimulusSeed:3,steps:1,commitStride:1,initStateRoot:'0x'+'00'.repeat(32),fee:1000000n,deadline:0n,redundancy:2},nonce='0x'+'dc'.repeat(32);
 const did=await gateway.market.read.taskId([disputedTask,'0x'+'00'.repeat(20),nonce,0,gateway.account.address]);
 await gateway.pub.waitForTransactionReceipt({hash:await gateway.market.write.postTask([disputedTask,nonce],{value:disputedTask.fee})});
 const trees=hosts.map((_,host)=>{const leaves=Array.from({length:1025},(_,idx)=>{const b=Buffer.alloc(20);b.writeUInt32LE(idx);if(idx===0)b.writeUInt32LE(host,16);return keccak256(b);});const levels=[leaves];while(levels.at(-1).length>1){const a=levels.at(-1);levels.push(Array.from({length:Math.ceil(a.length/2)},(_,i)=>keccak256('0x'+a[i*2].slice(2)+(a[i*2+1]||a[i*2]).slice(2))));}return levels;});
 const results=hosts.map((h,i)=>({taskId:did,instance:h.c.account.address,execDigest:'0x'+'dd'.repeat(32),execRoot:trees[i].at(-1)[0],salt:'0x'+(i?'22':'11').repeat(32)}));
 for(let i=0;i<2;i++){const c=hosts[i].c,r=results[i],commitment=await c.market.read.resultCommitment([did,r.instance,r.execDigest,r.execRoot,r.salt]);const response=await R.api('/tx/sync/commit',{taskId:did,instance:r.instance,commitment,signature:await c.account.sign({hash:await c.market.read.commitmentDigest([did,r.instance,commitment])})});assert.equal(response.ok,true,JSON.stringify(response));}
 for(let i=0;i<2;i++){const c=hosts[i].c,r=results[i];const response=await R.api('/tx/sync/reveal',{...r,signature:await c.account.sign({hash:await c.market.read.resultDigest([did,r.instance,r.execDigest,r.execRoot])})});assert.equal(response.ok,true,JSON.stringify(response));}
 assert.equal(Number((await gateway.market.read.sessionState([did]))[0]),3);
 const c=hosts[0].c,d=await c.disputes.read.disputes([did]),round=await c.disputes.read.roundNonce([did]),moveNonce=await c.disputes.read.moveNonce([did,c.account.address]);
 const move=async data=>{const b={taskId:did,instance:c.account.address,phase:Number(d[6]),round:String(round),nonce:String(moveNonce),expiry:String(d[12]),data};b.signature=await c.account.sign({hash:await c.disputes.read.moveDigest([did,b.instance,b.phase,round,moveNonce,d[12],keccak256(data)])});return R.api('/tx/sync/move',b);};
 const before=(await R.api('/status')).txs.length;
 assert.match((await move('0xffffffff'+did.slice(2))).error,/would revert/);
 assert.equal((await R.api('/status')).txs.length,before);
 const known=encodeFunctionData({abi:parseAbi(['function revealRoots(bytes32,bytes32[])']),functionName:'revealRoots',args:[did,[results[0].execRoot]]});
 assert.equal((await move(known)).ok,true);assert.match((await move(known)).error,/would revert/);
 const abi=parseAbi(['function revealRoots(bytes32,bytes32[])','function postStepRoots(bytes32,bytes32[])','function postChildren(bytes32,bytes32,bytes32)','function postRowLifChunk(bytes32,uint32,uint32,int32,int32,uint16,uint16,uint32,int64[])']);
 const forward=async(i,name,values)=>{const c=hosts[i].c,d=await c.disputes.read.disputes([did]),round=await c.disputes.read.roundNonce([did]),nonce=await c.disputes.read.moveNonce([did,c.account.address]),data=encodeFunctionData({abi,functionName:name,args:[did,...values]});const request={taskId:did,instance:c.account.address,phase:Number(d[6]),round:String(round),nonce:String(nonce),expiry:String(d[12]),data};request.signature=await c.account.sign({hash:await c.disputes.read.moveDigest([did,c.account.address,request.phase,round,nonce,d[12],keccak256(data)])});const response=await R.api('/tx/sync/move',request);assert.equal(response.ok,true,JSON.stringify(response));return response;};
 await forward(1,'revealRoots',[[results[1].execRoot]]);
 for(let i=0;i<2;i++)await forward(i,'postStepRoots',[[results[i].execRoot]]);
 for(let level=trees[0].length-2;level>=0;level--)for(let i=0;i<2;i++)await forward(i,'postChildren',[trees[i][level][0],trees[i][level][1]]);
 const rowLength=Number(rowStarts[1]-rowStarts[0]);assert.ok(rowLength>=1024);
 const chunk=await forward(0,'postRowLifChunk',[0,rowLength,0,0,0,0,0,Array.from({length:1024},(_,i)=>-BigInt(i+1))]);
 assert.ok(chunk.gasUsed>6000000&&chunk.gasUsed<16777216,JSON.stringify(chunk));
 assert.equal((await hosts[0].c.disputes.read.lifPartyState([did,hosts[0].c.account.address])).sums.length,1024);
 console.log('sponsored 1024-entry chunk gas',chunk.gasUsed);
 console.log('PASS real WASM hosts + synchronous HTTP commit/reveal + gateway digest verification; silent hosts close inconclusive without billing; authenticated dispute selector/replay boundaries');
}catch(error){console.error(error);throw error;}finally{for(const stop of cleanup.reverse())await stop();anvil.stop();fs.rmSync(tmp,{recursive:true,force:true});}
