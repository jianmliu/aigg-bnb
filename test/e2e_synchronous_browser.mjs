// Real built browser + Anvil: root-only residency serves a child registered after startup.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import { chromium } from 'playwright';
import { parseEther,getContract,parseAbi } from 'viem';
import * as H from './harness.mjs';
import { startFrontend } from '../frontend/serve.mjs';
const THREE=process.argv.includes('--three'),VRF=process.argv.includes('--vrf'),MODE=VRF?'synchronous-vrf-v1':'synchronous-v1',ADMISSION=1000n;
const DISAGREE=process.argv.includes('--disagree'),RESTART=process.argv.includes('--restart'),SILENT=process.argv.includes('--silent'),BATCH=process.argv.includes('--batch');
const waitFor=async (fn,label,ms=60000)=>{const end=Date.now()+ms;while(Date.now()<end){if(await fn())return;await H.sleep(250);}throw new Error('timed out: '+label);};
const anvil=await H.startAnvil(8595);const cleanup=[];let browser,page,R;
try {
 const dep={chainId:31337,rpc:anvil.rpc,epochBlocks:1000,addresses:{}},D=H.clientsFor(dep,H.KEYS[0]);
 const a=dep.addresses;
 a.verifier=await H.create(D,'PorwVerifierKeccak');a.meps=await H.create(D,'MEPRegistry');a.instances=await H.create(D,'InstanceRegistry',[parseEther('0.05'),5n]);
 a.beacon=await H.create(D,'CommitRevealBeacon',[1000n,10n,10n,parseEther('0.1')]);
 a.claims=await H.create(D,'PoRWClaimManager',[a.meps,a.instances,a.verifier,1000n,10n,parseEther('0.01'),parseEther('0.5'),a.beacon]);
 await H.sendTo(D,a.instances,'InstanceRegistry','setClaimManager',[a.claims,3n]);
 let coordinator,admission;
 if(VRF){const artifact=JSON.parse(fs.readFileSync(H.root+'/contracts/out/VrfAdmission.t.sol/MockVrfCoordinator.json'));coordinator=(await D.pub.waitForTransactionReceipt({hash:await D.wallet.deployContract({abi:artifact.abi,bytecode:artifact.bytecode.object})})).contractAddress;}
 dep.addresses.market=await H.create(D,VRF?'VrfSynchronousTaskMarket':'SynchronousTaskMarket',[dep.addresses.meps,dep.addresses.instances,dep.addresses.claims,1000n,1000n,24000n,...(VRF?[{coordinator,keyHash:'0x'+'11'.repeat(32),subId:1n,requestConfirmations:3,callbackGasLimit:200000,nativePayment:true,waitBlocks:500n,activationBlocks:200n,readyTTL:10000n,feeRecipient:D.account.address},['0x'+'00'.repeat(20)],[ADMISSION]]:[])]);
 if(VRF)admission=await H.readFrom(D,dep.addresses.market,'VrfSynchronousTaskMarket','admission');
 const fulfill=async id=>{const info=await H.readFrom(D,admission,'VrfAdmission','requestInfo',[id]);await D.pub.waitForTransactionReceipt({hash:await D.wallet.writeContract({address:coordinator,abi:parseAbi(['function fulfill(address,uint256,uint256)']),functionName:'fulfill',args:[admission,info[0],42n]})});};
 dep.addresses.disputes=await H.create(D,'SynchronousExecutionDisputes',[dep.addresses.meps,dep.addresses.instances,dep.addresses.market,400n,parseEther('0.05')]);
 dep.addresses.relays=await H.create(D,'RelayRegistry',[parseEther('0.01'),5n]);
 for(const address of [dep.addresses.market,dep.addresses.disputes])await H.sendTo(D,dep.addresses.instances,'InstanceRegistry','setSlasher',[address,true]);
 await H.sendTo(D,dep.addresses.market,'SynchronousTaskMarket','setDisputes',[dep.addresses.disputes]);
 const cap=await H.create(D,'HostCapacity');await H.sendTo(D,cap,'HostCapacity','setMarket',[dep.addresses.market,true]);await H.sendTo(D,dep.addresses.market,'SynchronousTaskMarket','setHostCapacity',[cap]);
 if(VRF){await H.sendTo(D,cap,'HostCapacity','setMarket',[admission,true]);await H.sendTo(D,dep.addresses.instances,'InstanceRegistry','setSlasher',[admission,true]);}
 D.market=getContract({address:dep.addresses.market,abi:H.artifact('SynchronousTaskMarket').abi,client:{public:D.pub,wallet:D.wallet}});
 Object.assign(D,H.clientsFor(dep,H.KEYS[0]),{market:D.market});
 await H.sendTo(D,dep.addresses.instances,'InstanceRegistry','setMEPRegistry',[dep.addresses.meps]);
 const {synthesizePayloadV2}=await H.porw('synth.js'),{PorwNode}=await H.porw('node.js'),{loadKernelFromBytes}=await H.porw('porw.js');
 const {encodeDelta3,applyDelta,fitName,baseNameLength}=await H.porw('delta.js');
 const wasm=fs.readFileSync(H.porwDir+'/sketch.wasm'),STEPS=4;
 const ref=new PorwNode(await loadKernelFromBytes(wasm),{privHex:H.KEYS[4]});
 const base=synthesizePayloadV2('family-base',300,3000),bs=await ref.loadModel('base',base,{maxSteps:STEPS,exec:'lif'}),baseId=H.hex(bs.mep.mepId);
 const delta=encodeDelta3({baseModelId:bs.modelId,neurons:bs.hdr.neurons,parentA:new Uint8Array(32),parentB:new Uint8Array(32),seed:4321n,name:fitName('late-child',baseNameLength(base)),layout:1});
 const child=applyDelta(base,delta),terms={beneficiary:D.account.address,royaltyBps:500};
 const cs=await ref.loadModel('child',child,{maxSteps:STEPS,exec:'lif',baseMepId:baseId,terms}),childId=H.hex(cs.mep.mepId);
 const L=await H.porw('lif.js');await ref.execute(cs.mep.mepId,{steps:STEPS,commitStride:1,stimulusSeed:7});
 let lie=null;
 if(DISAGREE){const prev=await ref.lifStates(cs.mep.mepId,1);for(let neuron=0;neuron<cs.hdr.neurons&&!lie;neuron++){const st=L.decodeState(prev,neuron*16),ps=await ref.lifPartialSums(cs.mep.mepId,2,neuron);if(!ps.sums.length)continue;const sum=ps.sums.at(-1);for(const delta of [40,400,4000,40000])if(!L.sameState(L.transition(st,sum,neuron,2,7),L.transition(st,sum+BigInt(delta),neuron,2,7))){lie={step:2,neuron,delta,kind:'input'};break;}}assert.ok(lie);}

 let baseHits=0,deltaHits=0,blockBase=false;
 const source=http.createServer((req,res)=>{res.setHeader('Access-Control-Allow-Origin','*');res.setHeader('Content-Type','application/octet-stream');
   if(req.url==='/base.bin'){baseHits++;if(blockBase){res.writeHead(503);return res.end('base unavailable');}return res.end(base);}
   if(req.url==='/late.delta'){deltaHits++;return res.end(delta);}res.writeHead(404);res.end();});
 await new Promise(r=>source.listen(0,'127.0.0.1',r));cleanup.push(()=>new Promise(r=>source.close(r)));
 const origin=`http://127.0.0.1:${source.address().port}`;
 const fields=(st,url)=>({modelId:H.hex(st.modelId),schemeDigest:H.hex(st.mep.schemeDigest),execKind:H.hex(st.mep.execKind),neurons:st.hdr.neurons,synapses:st.hdr.synapses,synapseRoot:H.hex(st.csr.synapseRoot),weightsDA:'0x'+Buffer.from(url).toString('hex')});
 await H.sendTo(D,dep.addresses.meps,'MEPRegistry','registerMEP',[fields(bs,origin+'/base.bin')]);
 await anvil.mine(64);
 R=await H.startRelayer(dep,H.KEYS[3],[baseId],{env:{PORW_VERIFICATION_MODE:MODE,PORW_SYNC_CONFIRMATIONS:'0',PORW_SPONSOR_EPOCH_GAS:'160000000',PORW_SPONSOR_DAY_GAS:'350000000'}});cleanup.push(()=>R.stop());
 const fe=await startFrontend(0);cleanup.push(()=>new Promise(r=>fe.server.close(r)));
 const chrome=process.env.PW_CHROMIUM||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
 browser=await chromium.launch({headless:true,...(fs.existsSync(chrome)?{executablePath:chrome}:{})});const pages=[];
 for(const walletIndex of (THREE?[1,2,4]:[1,2])) {
 const W=H.clientsFor(dep,H.KEYS[walletIndex]);page=await browser.newPage();pages.push(page);
 if(DISAGREE&&walletIndex===2)await page.context().route(/\/porw\.[^/]+\/node\.js$/,async route=>{const response=await route.fetch();let code=await response.text();code=code.replace('async _execute(mepId, { steps = 1, commitStride = 1, stimulusSeed = 1, stimulusIds = null, silenceIds = null, commit = true } = {}) {', 'async _execute(mepId, { steps = 1, commitStride = 1, stimulusSeed = 1, stimulusIds = null, silenceIds = null, commit = true } = {}) { this.execLie = '+JSON.stringify(lie)+';');await route.fulfill({response,body:code});});
 await page.exposeFunction('__walletRequest',async(method,params)=>{
  switch(method){
   case 'eth_requestAccounts':case 'eth_accounts':return [W.account.address];
   case 'eth_chainId':return '0x'+dep.chainId.toString(16);
   case 'eth_call':return W.pub.call({to:params[0].to,data:params[0].data}).then(r=>r.data||'0x');
   case 'eth_getBalance':return '0x'+(await W.pub.getBalance({address:params[0]})).toString(16);
   case 'eth_blockNumber':return '0x'+(await W.pub.getBlockNumber()).toString(16);
   case 'eth_getTransactionReceipt':try{const r=await W.pub.getTransactionReceipt({hash:params[0]});return {status:r.status==='success'?'0x1':'0x0'};}catch{return null;}
   case 'eth_sendTransaction':return W.wallet.sendTransaction({to:params[0].to,data:params[0].data,value:BigInt(params[0].value||0)});
   case 'eth_signTypedData_v4':return (await H.porw('eip712.js')).localWallet(H.KEYS[walletIndex]).signTypedData(JSON.parse(params[1]));
   default:throw new Error('unsupported wallet method '+method);
  }
 });
 await page.addInitScript(()=>{window.ethereum={isPorwTestWallet:true,request:({method,params})=>window.__walletRequest(method,params||[])};});
 await page.goto(fe.url);await page.waitForFunction(()=>window.__ready===true);
 await page.evaluate(url=>{document.getElementById('relayer').value=url;},R.apiBase);await page.click('#btnDep');
 await page.waitForFunction(()=>window.app.state.deployment!==null);assert.equal(await page.evaluate(()=>window.app.state.deployment.familyHosting),true);
 assert.deepEqual(await page.evaluate(()=>window.app.state.meps.map(m=>m.mepId)),[baseId]);
 await page.click('#navHost');await page.click('#btnConnect');await page.waitForFunction(()=>window.app.state.wallet!==null);
 await page.fill('#amount','0.5');await page.click('#btnBond');await page.waitForFunction(()=>window.app.state.bonded>0n,null,{timeout:60000});
 await page.click('#btnDelegate');await page.waitForFunction(()=>window.app.state.resolved!==null,null,{timeout:60000});
 await page.fill('#url',origin+'/base.bin');await page.click('#btnModel');await page.waitForFunction(id=>window.app.state.loaded[id]?.ok,baseId,{timeout:60000});
 await page.fill('#steps',String(STEPS));await page.click('#btnStart');await page.waitForFunction(()=>window.app.state.node?.models.size===1,null,{timeout:120000});
 await page.waitForFunction(()=>window.app.state.synchronousSession?.phase==='idle');
 await page.getByRole('button',{name:'Set 1 browser slot',exact:true}).click();
 await waitFor(async()=>Number(await H.readFrom(W,cap,'HostCapacity','capacityOf',[W.account.address]))===1,'browser slot');
 await page.evaluate(()=>window.appActions.armSynchronousSession());
 await anvil.mine(64);
 }
 await anvil.mine(64);blockBase=true;
 // Crucially, registration occurs after the worker's relay handlers and resident base exist.
 await H.sendTo(D,dep.addresses.meps,'MEPRegistry','registerDerivedMEPWithTerms',[fields(cs,origin+'/late.delta'),baseId,terms.beneficiary,terms.royaltyBps]);
 const rows=ref.k.u32(cs.csr.rowStartPtr,cs.hdr.neurons+1);let maxDegree=0;for(let i=0;i<cs.hdr.neurons;i++)maxDegree=Math.max(maxDegree,rows[i+1]-rows[i]);
 await H.sendTo(D,dep.addresses.market,'SynchronousTaskMarket','setProfileSupport',[childId,maxDegree]);
 assert.equal(await page.evaluate(id=>window.app.state.meps.some(m=>m.mepId===id),childId),false,'child absent from startup catalog');
 assert.equal(deltaHits,0,'no speculative child fetch');console.log('  ok   root resident before late child registration; no child fetched');
 const toBlock=async n=>{const now=await anvil.block();if(n>now)await anvil.mine(n-now);};
 const enter=async e=>{await toBlock(e*dep.epochBlocks-5);await waitFor(async()=>(await R.api('/status')).commits.includes(e),'beacon commit');await toBlock(e*dep.epochBlocks+2);await waitFor(async()=>(await R.api('/status')).reveals.includes(e),'beacon reveal');await toBlock(e*dep.epochBlocks+12);await waitFor(async()=>(await R.api('/status')).epochsRolled.includes(e),'epoch roll');};
 const epoch=Math.floor((await anvil.block())/dep.epochBlocks)+1;
 await enter(epoch);for(const page of pages)await waitFor(()=>page.evaluate(({id,e})=>!!window.app.state.claims[id]?.[e],{id:baseId,e:epoch}),'base claim');
 await enter(epoch+1);for(const page of pages)await waitFor(()=>page.evaluate(({id,e})=>window.app.state.materialized[id]?.[e]===true,{id:baseId,e:epoch}),'base materialization');
 for(const walletIndex of (THREE?[1,2,4]:[1,2])){const W=H.clientsFor(dep,H.KEYS[walletIndex]);assert.equal(await W.instances.read.isEligible([W.account.address,childId,BigInt(epoch+1)]),true);}
 const runs=[{stimulusSeed:7},{stimulusSeed:9}],expected=BATCH?await ref.executeBatch(cs.mep.mepId,{steps:STEPS,commitStride:1,runs}):await ref.execute(cs.mep.mepId,{steps:STEPS,commitStride:1,stimulusSeed:7});
 const task={mepId:childId,stimulusSeed:BATCH?0:7,steps:STEPS,commitStride:1,initStateRoot:H.hex(expected.result.initStateRoot),fee:parseEther('0.01'),deadline:0n,redundancy:2},nonce='0x'+'71'.repeat(32);
 await D.pub.waitForTransactionReceipt({hash:await D.market.write[BATCH?'postBatch':'postTask'](BATCH?[task,runs.length,nonce]:[task,nonce],{value:task.fee+(VRF?ADMISSION:0n)})});
 const taskId=await D.market.read.taskId([task,'0x'+'00'.repeat(20),nonce,BATCH?runs.length:0,D.account.address]);if(VRF){
  assert.equal(Number((await D.market.read.sessionState([taskId]))[0]),6);await anvil.mine(64);
  for(const p of pages){await p.waitForFunction(()=>window.app.state.synchronousSession?.phase==='awaiting randomness');assert.equal(await p.evaluate(()=>window.app.state.synchronousSession.safeToClose),false);}
  await fulfill(taskId);await anvil.mine(64);await waitFor(async()=>Number((await D.market.read.sessionState([taskId]))[0])===1,'VRF allocation');
 }
 assert.equal((await D.market.read.executors([taskId])).length,2);await anvil.mine(64);
 const {RelayClient}=await H.porw('relay_client.js'),{keypair}=await H.porw('claim.js');const client=new RelayClient([(await R.api('/deployment')).relay],keypair(H.KEYS[0]));await client.connect();cleanup.push(()=>client.close());

 const chosen=await D.market.read.executors([taskId]),selectedPages=[],unselected=[];
 for(const p of pages){const address=await p.evaluate(()=>window.app.state.wallet);(chosen.some(a=>a.toLowerCase()===address.toLowerCase())?selectedPages:unselected).push(p);}
 for(const p of unselected){await waitFor(()=>p.evaluate(()=>window.app.state.synchronousSession?.safeToClose===true),'unselected finalized release');assert.equal(await p.evaluate(()=>window.app.state.synchronousSession.ready),false);assert.equal(await p.evaluate(()=>window.app.state.synchronousSession.phase),'idle');}
 const sessions=await Promise.all(selectedPages.map(page=>page.evaluate(()=>window.app.state.delegation.session)));
 if(RESTART){
  client.request(sessions[0],BATCH?'batch-announce':'task-announce',childId,{taskId,steps:STEPS,commitStride:1,stimulusSeed:task.stimulusSeed,initStateRoot:task.initStateRoot,counts:true,...(BATCH?{runs}:{})},{timeoutMs:1000,responseType:'result'}).catch(()=>{});
  const first=H.clientsFor(dep,H.KEYS[1]).account.address;
  await waitFor(async()=>!/^0x0{64}$/.test(await D.market.read.commitments([taskId,first])),'first persisted commitment');
  const commitment=await D.market.read.commitments([taskId,first]);await anvil.mine(64);
  const page=pages[0];await page.reload();await page.waitForFunction(()=>window.__ready===true);
  await page.evaluate(url=>{document.getElementById('relayer').value=url;},R.apiBase);await page.click('#btnDep');await page.waitForFunction(()=>window.app.state.deployment!==null);
  await page.click('#navHost');await page.click('#btnConnect');await page.waitForFunction(()=>window.app.state.wallet!==null);
  await page.click('#btnDelegate');await page.waitForFunction(()=>window.app.state.resolved!==null);
  await page.evaluate(()=>window.appActions.resumeSynchronousSession());
  assert.equal(await page.evaluate(()=>window.app.state.node.models.size),0,'recovery does not refetch resident base');
  assert.equal(await D.market.read.commitments([taskId,first]),commitment,'reload preserves original commitment');
 }
 if(SILENT)await pages[1].close();
 const results=(SILENT?sessions.slice(0,1):sessions).map(session=>client.request(session,BATCH?'batch-announce':'task-announce',childId,{taskId,steps:STEPS,commitStride:1,stimulusSeed:task.stimulusSeed,initStateRoot:task.initStateRoot,counts:true,...(BATCH?{runs}:{})},{timeoutMs:120000,responseType:'result'}));for(const result of results)result.catch(()=>{});
 const mining=setInterval(()=>anvil.mine(64).catch(()=>{}),3000);cleanup.push(()=>clearInterval(mining));
 if(SILENT){
  await waitFor(async()=>Number((await D.market.read.sessionState([taskId]))[0])===5,'silent peer expires inconclusively',90000);
  await waitFor(()=>pages[0].evaluate(()=>window.app.state.synchronousSession?.safeToClose===true),'inconclusive terminal safe-to-close');
  assert.equal(await D.market.read.settledDigest([taskId]),'0x'+'00'.repeat(32));assert.equal(await D.market.read.credits(['0x'+'00'.repeat(20),D.account.address]),task.fee);
  for(const index of [1,2])assert.equal(await D.instances.read.bonded([H.clientsFor(dep,H.KEYS[index]).account.address]),parseEther('0.5'));
  console.log('PASS silent peer: browser finalizes inconclusive, client credited, no silence slash, confirmed safe-to-close');
 }else{
 await waitFor(async()=>Number((await D.market.read.sessionState([taskId]))[0])===4,'automatic bounded verification',240000);
 for(const page of pages)await waitFor(()=>page.evaluate(()=>window.app.state.synchronousSession?.safeToClose===true),'confirmed safe-to-close',30000);
 const responses=await Promise.all(results);assert.equal(responses[0].payload.execRoot,H.hex(expected.result.execRoot));if(DISAGREE)assert.notEqual(responses[1].payload.execRoot,responses[0].payload.execRoot);else assert.equal(responses[1].payload.execRoot,responses[0].payload.execRoot);for(const response of responses)assert.ok(BATCH?response.payload.runs?.length===2:response.payload.counts);
 if(DISAGREE)assert.ok(await D.instances.read.bonded([H.clientsFor(dep,H.KEYS[2]).account.address])<parseEther('0.5'),'objective fraud slashed');
 assert.equal(await D.market.read.settledDigest([taskId]),H.hex(expected.result.execDigest));assert.equal(baseHits,THREE?3:2);assert.equal(deltaHits,2);
 if(!RESTART&&!DISAGREE&&!BATCH&&!THREE){
  for(const page of pages)await page.evaluate(()=>window.appActions.armSynchronousSession());await anvil.mine(64);
  const nextNonce='0x'+'72'.repeat(32);await D.pub.waitForTransactionReceipt({hash:await D.market.write.postTask([task,nextNonce],{value:task.fee+(VRF?ADMISSION:0n)})});
  const nextId=await D.market.read.taskId([task,'0x'+'00'.repeat(20),nextNonce,0,D.account.address]);await anvil.mine(64);
  if(VRF){await fulfill(nextId);await anvil.mine(64);await waitFor(async()=>Number((await D.market.read.sessionState([nextId]))[0])===1,'second VRF allocation');await anvil.mine(64);}
  const nextResults=sessions.map(session=>client.request(session,'task-announce',childId,{taskId:nextId,steps:STEPS,commitStride:1,stimulusSeed:7,initStateRoot:task.initStateRoot,counts:true},{timeoutMs:90000,responseType:'result'}));for(const p of nextResults)p.catch(()=>{});
  await Promise.all(nextResults);await waitFor(async()=>Number((await D.market.read.sessionState([nextId]))[0])===4,'second explicitly armed task');
  for(const page of pages){await waitFor(()=>page.evaluate(()=>window.app.state.synchronousSession?.safeToClose===true),'second terminal safe-to-close');
   const archived=await page.evaluate(async taskId=>{const dbs=await indexedDB.databases(),db=await new Promise((resolve,reject)=>{const r=indexedDB.open(dbs.find(x=>x.name.startsWith('porw-synchronous-v1:')).name);r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error)});return new Promise((resolve,reject)=>{const r=db.transaction('session').objectStore('session').get('task:'+taskId);r.onsuccess=()=>resolve(!!r.result?.manifest?.baseBytes);r.onerror=()=>reject(r.error)});},taskId);assert.equal(archived,true,'old exact evidence archived through rearm');}
  console.log('  ok   explicit rearm completes second task while preserving first task evidence');
 }
 if(THREE){assert.equal(unselected.length,1);await unselected[0].evaluate(()=>window.appActions.armSynchronousSession());await anvil.mine(64);await waitFor(()=>unselected[0].evaluate(()=>window.app.state.synchronousSession?.ready===true),'unselected explicit rearm');await unselected[0].evaluate(()=>window.appActions.drainSynchronousSession());await anvil.mine(64);await waitFor(()=>unselected[0].evaluate(()=>window.app.state.synchronousSession?.safeToClose===true),'unselected explicit drain');console.log('PASS third candidate: reserved, released without execution, explicit rearm and drain');}
 console.log((RESTART?'RESTART ':'' )+(BATCH?'BATCH ':'')+'PASS two real browsers: family child, durable commit/reveal, '+(DISAGREE?'automatic disagreement proof and objective slash':'agreement')+', correct output and confirmed safe-to-close');
 }
} catch(error){if(page)console.error('page log:',await page.locator('#log').textContent().catch(()=>''));if(R)console.error('relayer tail:',R.log().slice(-3000));throw error;}
finally {if(browser)await browser.close();for(const stop of cleanup.reverse())try{await stop();}catch{}anvil.stop();}
