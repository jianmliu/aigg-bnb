import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {parseEther,keccak256,encodeFunctionData,parseAbi} from 'viem';
import {privateKeyToAccount} from 'viem/accounts';
import * as H from './harness.mjs';
import {clients} from '../relayer/chain.mjs';
const ROUNDS=process.argv.includes('--rounds'),VRF=ROUNDS||process.argv.includes('--vrf'),MODE=ROUNDS?'synchronous-vrf-rounds-v1':VRF?'synchronous-vrf-v1':'synchronous-v1',ADMISSION=1000n;
const MARKET=ROUNDS?'RoundVrfSynchronousTaskMarket':'VrfSynchronousTaskMarket',CONTROLLER=ROUNDS?'RoundVrfAdmission':'VrfAdmission';
const wait=async fn=>{for(let i=0;i<600;i++){if(await fn())return;await H.sleep(100);}throw Error('timed out waiting for chain/service');};
const anvil=await H.startAnvil(Number(process.env.SYNC_GATEWAY_TEST_PORT||8598));const cleanup=[];
let shuttingDown=false;
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'sync-gateway-'));
try {
 // Deploy directly: isolated chains must not share Forge's chain-31337 broadcast journal.
 const dep={chainId:31337,rpc:anvil.rpc,epochBlocks:1000,claimValidityEpochs:3,addresses:{}},deployer=H.clientsFor(dep,H.KEYS[0]),a=dep.addresses;
 a.verifier=await H.create(deployer,'PorwVerifierKeccak');a.meps=await H.create(deployer,'MEPRegistry');a.instances=await H.create(deployer,'InstanceRegistry',[parseEther('0.05'),5n]);
 a.beacon=await H.create(deployer,'CommitRevealBeacon',[1000n,10n,10n,parseEther('0.1')]);
 a.claims=await H.create(deployer,'PoRWClaimManager',[a.meps,a.instances,a.verifier,1000n,10n,parseEther('0.01'),parseEther('0.5'),a.beacon]);
 a.relays=await H.create(deployer,'RelayRegistry',[parseEther('1'),5n]);a.whitelist=await H.create(deployer,'CollectionWhitelist',[deployer.account.address]);
 await H.sendTo(deployer,a.instances,'InstanceRegistry','setClaimManager',[a.claims,3n]);
 const owner=H.clientsFor(dep,H.KEYS[0]);
 const feeLibrary=ROUNDS?await H.create(owner,'RoundFeeAccounting'):null;
 let coordinator,admission;
 if(VRF){const artifact=JSON.parse(fs.readFileSync(path.join(H.root,'contracts/out/VrfAdmission.t.sol/MockVrfCoordinator.json')));coordinator=(await owner.pub.waitForTransactionReceipt({hash:await owner.wallet.deployContract({abi:artifact.abi,bytecode:artifact.bytecode.object})})).contractAddress;}
 dep.addresses.market=await H.create(owner,VRF?MARKET:'SynchronousTaskMarket',[dep.addresses.meps,dep.addresses.instances,dep.addresses.claims,120n,40n,300n,...(VRF?[{coordinator,keyHash:'0x'+'11'.repeat(32),subId:1n,requestConfirmations:3,callbackGasLimit:200000,nativePayment:true,waitBlocks:500n,activationBlocks:200n,readyTTL:10000n,feeRecipient:owner.account.address},['0x'+'00'.repeat(20)],[ADMISSION],...(ROUNDS?[128n,64]:[])]:[])],ROUNDS?{RoundFeeAccounting:feeLibrary}:{});
 if(VRF)admission=await H.readFrom(owner,dep.addresses.market,MARKET,'admission');
 const fulfill=async id=>{const info=await H.readFrom(owner,admission,CONTROLLER,'requestInfo',[id]);const abi=parseAbi(['function fulfill(address,uint256,uint256)']);await owner.pub.waitForTransactionReceipt({hash:await owner.wallet.writeContract({address:coordinator,abi,functionName:'fulfill',args:[admission,info[0],42n]})});};
 dep.addresses.disputes=await H.create(owner,'SynchronousExecutionDisputes',[dep.addresses.meps,dep.addresses.instances,dep.addresses.market,5n,parseEther('0.01')]);
 const cap=await H.create(owner,'HostCapacity');dep.verification={mode:MODE};
 await H.sendTo(owner,cap,'HostCapacity','setMarket',[dep.addresses.market,true]);
 if(VRF){await H.sendTo(owner,cap,'HostCapacity','setMarket',[admission,true]);await H.sendTo(owner,dep.addresses.instances,'InstanceRegistry','setSlasher',[admission,true]);}
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
 const gateway=clients(dep,H.KEYS[4]);const R=await H.startRelayer(dep,H.KEYS[3],[mepId],{env:{PORW_VERIFICATION_MODE:MODE,PORW_SYNC_CONFIRMATIONS:'0',PORW_TASK_CLIENTS:gateway.account.address.toLowerCase(),PORW_BEACON_LAZY:'1',PORW_SPONSOR_EPOCH_GAS:'160000000',PORW_SPONSOR_DAY_GAS:'350000000'}});cleanup.push(()=>R.stop());
 const published=await R.api('/deployment');const failures=[];
 const catalog=await R.api('/meps');assert.deepEqual(catalog.find(m=>m.mepId===mepId).verificationSupport,{supported:true,maxInDegree:maxRow});
 const hosts=[];
 for(const key of [H.KEYS[1],H.KEYS[2]]){
  const c=clients(dep,key);await c.pub.waitForTransactionReceipt({hash:await c.instances.write.bond([[mepId]],{value:parseEther('0.5')})});
  const sessionKey='0x'+(hosts.length?'22':'11').repeat(32),session=privateKeyToAccount(sessionKey);const delegation=await E.makeDelegation(E.localWallet(key),published.domains.registry,session.address,100000);
  assert.equal((await R.api('/tx/delegate',{instance:delegation.instance,session:delegation.session,expiry:delegation.expiry,sig:delegation.sig})).ok,true);await H.sendTo(c,cap,'HostCapacity','setCapacity',[ROUNDS?2:1]);
  const node=new PorwNode(await loadKernelFromBytes(wasm),{privHex:sessionKey,domains:published.domains,delegation});await node.loadModel('sync-service-brain',payload,{exec:'lif',maxSteps:4});
  const relay=new RelayClient([published.relay],node.key);await relay.connect();cleanup.push(()=>relay.close());
  const service=new NodeService(node,relay);service.serve(model.mep.mepId,{tasks:false});
  const arm=async()=>{const nonce=await c.market.read.readinessNonce([c.account.address]),expiry=await c.pub.getBlockNumber({cacheTime:0})+500n;const hash=await c.market.read.readinessDigest([c.account.address,true,expiry,nonce]);const r=await R.api('/tx/sync/readiness',{instance:c.account.address,ready:true,expiry:String(expiry),nonce:String(nonce),signature:await session.sign({hash})});assert.equal(r.ok,true,JSON.stringify(r));};
  const host={c,node,relay,service,arm,stopTask:null,executionTail:Promise.resolve()};hosts.push(host);
  host.stopTask=relay.serve('task-announce',mepId,async env=>{
   try {
    const p=env.payload;
    // One WASM instance executes serially; task journals and commit/reveal waits remain independent.
    const execution=host.executionTail.then(async()=>structuredClone(await node.execute(model.mep.mepId,{steps:p.steps,commitStride:p.commitStride,stimulusSeed:p.stimulusSeed,stimulusIds:p.stimulusIds?Uint32Array.from(p.stimulusIds):null,silenceIds:p.silenceIds?Uint32Array.from(p.silenceIds):null})));
    host.executionTail=execution.catch(()=>{});const r=await execution;
    assert.equal(H.hex(r.result.initStateRoot),p.initStateRoot);
    const execDigest=H.hex(r.result.execDigest),execRoot=H.hex(r.result.execRoot),salt='0x'+(hosts.indexOf(host)?'bb':'aa').repeat(32),instance=c.account.address;
    const commitment=await c.market.read.resultCommitment([p.taskId,instance,execDigest,execRoot,salt]);
    const signature=await session.sign({hash:await c.market.read.commitmentDigest([p.taskId,instance,commitment])});
    const commit=await R.api('/tx/sync/commit',{taskId:p.taskId,instance,commitment,signature});assert.equal(commit.ok,true,JSON.stringify(commit));console.log('host committed',p.taskId.slice(0,10),instance.slice(0,10));
    await wait(async()=>Number((await c.market.read.sessionState([p.taskId]))[0])===2);
    const reveal=await R.api('/tx/sync/reveal',{taskId:p.taskId,instance,execDigest,execRoot,salt,signature:await session.sign({hash:await c.market.read.resultDigest([p.taskId,instance,execDigest,execRoot])})});assert.equal(reveal.ok,true,JSON.stringify(reveal));
    await wait(async()=>Number((await c.market.read.sessionState([p.taskId]))[0])===4);
    return {type:'result',payload:{taskId:p.taskId,execDigest,execRoot:'0x'+'ab'.repeat(32),counts:Buffer.from(r.result.counts.buffer,r.result.counts.byteOffset,r.result.counts.byteLength).toString('base64'),countsEncoding:'u32le-base64'}};
   }catch(e){console.error('host task failure',env.payload.taskId,e);failures.push(e);return {type:'result-refused',payload:{reason:e.message}};}
  });
 }
 const to=async b=>{const head=await anvil.block();if(head<b)await anvil.mine(b-head);};
 const enter=async e=>{await to(e*1000-5);await wait(async()=>(await R.api('/status')).commits.includes(e));await to(e*1000+2);await wait(async()=>(await R.api('/status')).reveals.includes(e));await to(e*1000+12);await wait(async()=>(await R.api('/status')).epochsRolled.includes(e));};
 await R.api('/wake',{instance:hosts[0].c.account.address});await enter(1);console.log('epoch 1 ready');
 const ep=await R.api('/epoch?mep='+mepId);for(const h of hosts)await h.service.announce(model.mep.mepId,H.unhex(ep.challenge));
 await enter(2);console.log('epoch 2 ready');await wait(async()=>(await R.api('/status')).rootsPosted.some(r=>r.epoch===1&&r.count===2));
 for(const h of hosts){const r=await R.api('/tx/materialize',{mep:mepId,epoch:1,instance:h.c.account.address});assert.equal(r.ok,true,JSON.stringify(r));await h.arm();}
 console.log('signed hosts ready and eligible');
 const gatewayEnv={GATEWAY_BEARER:'test',GATEWAY_VRF_ADMISSION_BUDGET_WEI:'1000000',...(ROUNDS?{GATEWAY_ROUND_CREDIT_SWEEP_MIN_WEI:'1'}:{}),GATEWAY_MODELS:`sync=${mepId}`,GATEWAY_STATE:path.join(tmp,'state.json'),GATEWAY_POLL_MS:'100',GATEWAY_RESULT_TIMEOUT_MS:'60000'};let G=await H.startGateway(R,H.KEYS[4],gatewayEnv);cleanup.push(()=>G.stop());
 const call=async body=>{const r=await fetch(G.url+'/v1/responses',{method:'POST',headers:{authorization:'Bearer test','content-type':'application/json'},body:JSON.stringify(body)});return {status:r.status,body:await r.json()};};
 console.log('gateway ready');
 const responseFinished=async r=>{const id=r.body.id;const until=Date.now()+120000;while(!shuttingDown&&Date.now()<until){try{const response=await fetch(G.url+'/v1/responses/'+id,{headers:{authorization:'Bearer test'}});const body=await response.json();if(['completed','failed'].includes(body.status))return {status:response.status,body};}catch{}await H.sleep(100);}return {status:503,body:{status:'failed',error:'response polling stopped'}};};
 let secondAgreement,secondId;
 let delivered=false;const agreement=call({model:'sync',seed:7,max_output_tokens:4,...(VRF?{background:true}:{})}).then(async r=>{
  if(VRF)r=await responseFinished(r);
  delivered=true;return r;
 });
 await wait(async()=>{if(fs.existsSync(path.join(tmp,'state.json'))){const first=JSON.parse(fs.readFileSync(path.join(tmp,'state.json')))[0];if(first?.status==='failed')throw Error(JSON.stringify(first.error)+'\n'+G.log());}return BigInt(await gateway.market.read.pendingTask([hosts[0].c.account.address]))!==0n;});
 const agreedId=await gateway.market.read.pendingTask([hosts[0].c.account.address]);
 if(ROUNDS){const second=await call({model:'sync',seed:9,max_output_tokens:4,background:true});assert.equal(second.status,200);secondId=second.body.id;secondAgreement=responseFinished(second);await wait(async()=>(await H.readFrom(owner,admission,CONTROLLER,'pendingTasks',[hosts[0].c.account.address])).length===2);assert.notEqual(secondId,agreedId);assert.equal(await H.readFrom(owner,admission,CONTROLLER,'taskRound',[secondId]),await H.readFrom(owner,admission,CONTROLLER,'taskRound',[agreedId]));assert.equal((await H.readFrom(owner,admission,CONTROLLER,'requestInfo',[secondId]))[0],0n);}
 if(VRF){assert.equal(Number((await gateway.market.read.sessionState([agreedId]))[0]),6);assert.equal((await gateway.market.read.executors([agreedId])).length,0);
  await G.stop();const stateFile=path.join(tmp,'state.json'),saved=JSON.parse(fs.readFileSync(stateFile));assert.ok(saved[0].post_raw);saved[0].post_confirmed=false;delete saved[0].post_tx;delete saved[0].post_raw;fs.writeFileSync(stateFile,JSON.stringify(saved));G=await H.startGateway(R,H.KEYS[4],gatewayEnv);
  if(ROUNDS){
   assert.equal((await H.readFrom(owner,admission,CONTROLLER,'requestInfo',[agreedId]))[0],0n,'collecting restart must not request early');
   const rid=await H.readFrom(owner,admission,CONTROLLER,'taskRound',[agreedId]),round=await H.readFrom(owner,admission,CONTROLLER,'roundInfo',[rid]);
   await to(Number(round[0])+64);await wait(async()=>(await H.readFrom(owner,admission,CONTROLLER,'requestInfo',[agreedId]))[0]!==0n);
   assert.equal((await H.readFrom(owner,admission,CONTROLLER,'requestInfo',[secondId]))[0],1n,'two tasks bind one shared request');
   assert.equal(await owner.pub.readContract({address:coordinator,abi:parseAbi(['function count() view returns(uint256)']),functionName:'count'}),1n);
  }else{assert.equal((await H.readFrom(owner,admission,CONTROLLER,'requestInfo',[agreedId]))[0],1n,'restart keeps original VRF request');await anvil.mine(64);}
  await fulfill(agreedId);await anvil.mine(64);await wait(async()=>Number((await gateway.market.read.sessionState([agreedId]))[0])===1);if(ROUNDS)await wait(async()=>Number((await gateway.market.read.sessionState([secondId]))[0])===1);console.log('allocated awaiting finality');}
 const allocatedThrough=BigInt(await anvil.block());await anvil.mine(64);
 if(ROUNDS){const finalized=await gateway.pub.getBlock({blockTag:'finalized'});console.log('allocation finality',{allocatedThrough:String(allocatedThrough),finalized:String(finalized.number)});if(finalized.number<allocatedThrough)await anvil.mine(Number(allocatedThrough-finalized.number)+32);assert.ok((await gateway.pub.getBlock({blockTag:'finalized'})).number>=allocatedThrough);}
 await wait(async()=>Number((await gateway.market.read.sessionState([agreedId]))[0])===4);
 if(ROUNDS)await wait(async()=>{const saved=JSON.parse(fs.readFileSync(path.join(tmp,'state.json'))).find(c=>c.id===secondId);assert.notEqual(saved?.status,'failed',JSON.stringify(saved?.error));return Number((await gateway.market.read.sessionState([secondId]))[0])===4;});
 await H.sleep(300);assert.equal(delivered,false,'latest completion must not publish as finalized');
 await anvil.mine(64);
 console.log('agreement tasks completed on chain');
 const agreed=await agreement;if(agreed.status!==200)console.log(JSON.stringify(agreed),G.log(),failures);
 if(VRF){assert.equal(agreed.body.receipt.admission_fee_wei,String(ROUNDS?ADMISSION/2n:ADMISSION));assert.equal(agreed.body.receipt.admission_deposit_wei,String(ADMISSION));assert.equal(agreed.body.receipt.admission_refund_wei,String(ROUNDS?ADMISSION/2n:0n));assert.equal(agreed.body.receipt.total_escrow_wei,String(BigInt(agreed.body.receipt.fee_wei)+ADMISSION));}
 assert.equal(agreed.status,200);assert.equal(agreed.body.status,'completed');assert.equal(agreed.body.receipt.exec_root,(await gateway.market.read.resultOf([agreed.body.id,agreed.body.receipt.executors[0]]))[1]);assert.equal(agreed.body.receipt.finality,'final');assert.equal(agreed.body.receipt.verification,MODE);assert.equal(agreed.body.receipt.counts.status,'verified');assert.equal(agreed.body.receipt.executors.length,2);assert.equal(failures.length,0);
 if(ROUNDS){const second=await secondAgreement;assert.equal(second.status,200);assert.equal(second.body.status,'completed');assert.equal(second.body.receipt.verification,MODE);assert.equal(second.body.receipt.admission_fee_wei,String(ADMISSION/2n));assert.equal(second.body.receipt.admission_refund_wei,String(ADMISSION/2n));
  const ledger=JSON.parse(fs.readFileSync(gatewayEnv.GATEWAY_STATE+'.admission.json'));assert.equal(ledger[agreedId].net,String(ADMISSION/2n));assert.equal(ledger[secondId].net,String(ADMISSION/2n));
  await wait(async()=>await gateway.pub.readContract({address:a.market,abi:parseAbi(['function credits(address,address) view returns(uint256)']),functionName:'credits',args:['0x'+'00'.repeat(20),gateway.account.address]})===0n);
  // A finalized-charge RPC failure after on-chain settlement can mark a call failed.
  // Simulate that crash state: the next gateway must repair the lifetime budget
  // and the visible expense even though the call is already terminal.
  await G.stop();const budgetFile=gatewayEnv.GATEWAY_STATE+'.admission.json';const damaged=JSON.parse(fs.readFileSync(budgetFile));damaged[agreedId]=String(ADMISSION);fs.writeFileSync(budgetFile,JSON.stringify(damaged));
  const savedCalls=JSON.parse(fs.readFileSync(gatewayEnv.GATEWAY_STATE));const damagedCall=savedCalls.find(c=>c.id===agreedId);damagedCall.status='failed';damagedCall.error={status:500,type:'gateway_error',message:'finalized RPC unavailable'};damagedCall.receipt.admission_fee_wei=String(ADMISSION);damagedCall.receipt.admission_refund_wei='0';
  const damagedAfterLedger=savedCalls.find(c=>c.id===secondId);damagedAfterLedger.post_confirmed=false;damagedAfterLedger.admission_fee_net_wei=undefined;damagedAfterLedger.receipt.admission_fee_wei=String(ADMISSION);damagedAfterLedger.receipt.admission_refund_wei='0';
  fs.writeFileSync(gatewayEnv.GATEWAY_STATE,JSON.stringify(savedCalls));
  G=await H.startGateway(R,H.KEYS[4],gatewayEnv);
  await wait(async()=>JSON.parse(fs.readFileSync(budgetFile))[agreedId]?.net===String(ADMISSION/2n));
  const repaired=await(await fetch(G.url+'/v1/responses/'+agreedId,{headers:{authorization:'Bearer test'}})).json();assert.equal(repaired.status,'failed');assert.equal(repaired.protocol_expenses.admission_fee_wei,String(ADMISSION/2n));assert.equal(repaired.receipt.admission_refund_wei,String(ADMISSION/2n));
  await wait(async()=>JSON.parse(fs.readFileSync(gatewayEnv.GATEWAY_STATE)).find(c=>c.id===secondId)?.post_confirmed===true);
  const repairedAfterLedger=await(await fetch(G.url+'/v1/responses/'+secondId,{headers:{authorization:'Bearer test'}})).json();assert.equal(repairedAfterLedger.status,'completed');assert.equal(repairedAfterLedger.protocol_expenses.admission_fee_wei,String(ADMISSION/2n));assert.equal(repairedAfterLedger.receipt.admission_refund_wei,String(ADMISSION/2n));
  for(const h of hosts){assert.equal((await H.readFrom(owner,admission,CONTROLLER,'pendingTasks',[h.c.account.address])).length,0);assert.equal(await H.readFrom(owner,cap,'HostCapacity','activeSlots',[h.c.account.address]),0);}}
 for(const h of hosts){assert.equal(await h.c.market.read.ready([h.c.account.address]),false);await h.arm();h.stopTask();}
 const pending=await call({model:'sync',seed:8,max_output_tokens:4,background:true});assert.equal(pending.status,200);
 const taskId=pending.body.id;
 if(VRF){
  await wait(async()=>Number((await gateway.market.read.sessionState([taskId]))[0])===6);
  if(ROUNDS){const rid=await H.readFrom(owner,admission,CONTROLLER,'taskRound',[taskId]),round=await H.readFrom(owner,admission,CONTROLLER,'roundInfo',[rid]);await to(Number(round[0]));await H.sendTo(owner,dep.addresses.market,MARKET,'sealRound',[rid]);}
  const info=await H.readFrom(owner,admission,CONTROLLER,'requestInfo',[taskId]);assert.notEqual(info[0],0n);await to(Number(info[1])+1);
 }else{
  await wait(async()=>Number((await gateway.market.read.sessionState([taskId]))[0])===1);
  const state=await gateway.market.read.sessionState([taskId]);await to(Number(state[1])+1);
 }
 await wait(async()=>Number((await gateway.market.read.sessionState([taskId]))[0])===5);await anvil.mine(64);
 let failed;await wait(async()=>{failed=await(await fetch(G.url+'/v1/responses/'+taskId,{headers:{authorization:'Bearer test'}})).json();return failed.status==='failed';});
 if(VRF){assert.equal(failed.protocol_expenses.admission_fee_wei,String(ADMISSION));assert.equal(failed.receipt.admission_fee_refundable,false);assert.equal((await gateway.market.read.executors([taskId])).length,0);await fulfill(taskId);assert.equal(Number((await gateway.market.read.sessionState([taskId]))[0]),5,'late word cannot resurrect');}
 assert.equal(failed.error.type,'inconclusive');assert.equal(failed.receipt.refunded,true);assert.equal(failed.usage?.output_tokens??0,0);assert.equal(Number((await gateway.market.read.sessionState([taskId]))[0]),5);
 assert.equal(failures.length,0);
 console.log('agreement receipts and expiry verified');
 // A real open dispute exercises the sponsored selector boundary, not a missing-task revert.
 for(const h of hosts)await h.arm();
 const disputedTask={mepId,stimulusSeed:3,steps:1,commitStride:1,initStateRoot:'0x'+'00'.repeat(32),fee:1000000n,deadline:0n,redundancy:2},nonce='0x'+'dc'.repeat(32);
 const did=await gateway.market.read.taskId([disputedTask,'0x'+'00'.repeat(20),nonce,0,gateway.account.address]);
 await gateway.pub.waitForTransactionReceipt({hash:await gateway.market.write.postTask([disputedTask,nonce],{value:disputedTask.fee+(VRF?ADMISSION:0n)})});
 if(ROUNDS){const rid=await H.readFrom(owner,admission,CONTROLLER,'taskRound',[did]),round=await H.readFrom(owner,admission,CONTROLLER,'roundInfo',[rid]);await to(Number(round[0]));await H.sendTo(owner,dep.addresses.market,MARKET,'sealRound',[rid]);}
 if(VRF){await fulfill(did);await gateway.pub.waitForTransactionReceipt({hash:await gateway.market.write.allocate([did])});}
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
 console.log(ROUNDS?'PASS shared VRF gateway: two concurrent tasks, collecting restart, one request, independent completions, drained capacity, expiry and dispute boundaries':VRF?'PASS VRF gateway: durable post, phase-6 hash-loss restart, single request, no-word expiry, late callback ignored, fee accounting, real WASM verification and dispute boundaries':'PASS real WASM hosts + synchronous HTTP commit/reveal + gateway digest verification; silent hosts close inconclusive without billing; authenticated dispute selector/replay boundaries');
}catch(error){console.error(error);if(fs.existsSync(path.join(tmp,'state.json')))console.error(JSON.parse(fs.readFileSync(path.join(tmp,'state.json'),'utf8')).map(({id,status,error,verification,results})=>({id,status,error,verification,results})));throw error;}finally{shuttingDown=true;for(const stop of cleanup.reverse())await stop();anvil.stop();fs.rmSync(tmp,{recursive:true,force:true});}
