// Real built browser + Anvil: root-only residency serves a child registered after startup.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import { chromium } from 'playwright';
import { parseEther } from 'viem';
import * as H from './harness.mjs';
import { startFrontend } from '../frontend/serve.mjs';
const waitFor=async (fn,label,ms=60000)=>{const end=Date.now()+ms;while(Date.now()<end){if(await fn())return;await H.sleep(250);}throw new Error('timed out: '+label);};
const anvil=await H.startAnvil(8591);const cleanup=[];let browser,page,R;
try {
 const dep=await H.deploy(anvil.rpc,{EPOCH_BLOCKS:'200'}),D=H.clientsFor(dep,H.KEYS[0]),W=H.clientsFor(dep,H.KEYS[1]);
 await H.sendTo(D,dep.addresses.instances,'InstanceRegistry','setMEPRegistry',[dep.addresses.meps]);
 const {synthesizePayloadV2}=await H.porw('synth.js'),{PorwNode}=await H.porw('node.js'),{loadKernelFromBytes}=await H.porw('porw.js');
 const {encodeDelta3,applyDelta,fitName,baseNameLength}=await H.porw('delta.js');
 const wasm=fs.readFileSync(H.porwDir+'/sketch.wasm'),STEPS=4;
 const ref=new PorwNode(await loadKernelFromBytes(wasm),{privHex:H.KEYS[4]});
 const base=synthesizePayloadV2('family-base',300,3000),bs=await ref.loadModel('base',base,{maxSteps:STEPS,exec:'lif'}),baseId=H.hex(bs.mep.mepId);
 const delta=encodeDelta3({baseModelId:bs.modelId,neurons:bs.hdr.neurons,parentA:new Uint8Array(32),parentB:new Uint8Array(32),seed:4321n,name:fitName('late-child',baseNameLength(base)),layout:1});
 const child=applyDelta(base,delta),terms={beneficiary:D.account.address,royaltyBps:500};
 const cs=await ref.loadModel('child',child,{maxSteps:STEPS,exec:'lif',baseMepId:baseId,terms}),childId=H.hex(cs.mep.mepId);
 let baseHits=0,deltaHits=0,blockBase=false;
 const source=http.createServer((req,res)=>{res.setHeader('Access-Control-Allow-Origin','*');res.setHeader('Content-Type','application/octet-stream');
   if(req.url==='/base.bin'){baseHits++;if(blockBase){res.writeHead(503);return res.end('base unavailable');}return res.end(base);}
   if(req.url==='/late.delta'){deltaHits++;return res.end(delta);}res.writeHead(404);res.end();});
 await new Promise(r=>source.listen(0,'127.0.0.1',r));cleanup.push(()=>new Promise(r=>source.close(r)));
 const origin=`http://127.0.0.1:${source.address().port}`;
 const fields=(st,url)=>({modelId:H.hex(st.modelId),schemeDigest:H.hex(st.mep.schemeDigest),execKind:H.hex(st.mep.execKind),neurons:st.hdr.neurons,synapses:st.hdr.synapses,synapseRoot:H.hex(st.csr.synapseRoot),weightsDA:'0x'+Buffer.from(url).toString('hex')});
 await H.sendTo(D,dep.addresses.meps,'MEPRegistry','registerMEP',[fields(bs,origin+'/base.bin')]);
 R=await H.startRelayer(dep,H.KEYS[3],[baseId]);cleanup.push(()=>R.stop());
 const fe=await startFrontend(0);cleanup.push(()=>new Promise(r=>fe.server.close(r)));
 const chrome=process.env.PW_CHROMIUM||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
 browser=await chromium.launch({headless:true,...(fs.existsSync(chrome)?{executablePath:chrome}:{})});page=await browser.newPage();
 await page.exposeFunction('__walletRequest',async(method,params)=>{
  switch(method){
   case 'eth_requestAccounts':case 'eth_accounts':return [W.account.address];
   case 'eth_chainId':return '0x'+dep.chainId.toString(16);
   case 'eth_call':return W.pub.call({to:params[0].to,data:params[0].data}).then(r=>r.data||'0x');
   case 'eth_getBalance':return '0x'+(await W.pub.getBalance({address:params[0]})).toString(16);
   case 'eth_blockNumber':return '0x'+(await W.pub.getBlockNumber()).toString(16);
   case 'eth_getTransactionReceipt':try{const r=await W.pub.getTransactionReceipt({hash:params[0]});return {status:r.status==='success'?'0x1':'0x0'};}catch{return null;}
   case 'eth_sendTransaction':return W.wallet.sendTransaction({to:params[0].to,data:params[0].data,value:BigInt(params[0].value||0)});
   case 'eth_signTypedData_v4':return (await H.porw('eip712.js')).localWallet(H.KEYS[1]).signTypedData(JSON.parse(params[1]));
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
 assert.deepEqual(await page.evaluate(()=>[...window.app.state.node.models.keys()]),[baseId]);assert.equal(baseHits,1);blockBase=true;
 // Crucially, registration occurs after the worker's relay handlers and resident base exist.
 await H.sendTo(D,dep.addresses.meps,'MEPRegistry','registerDerivedMEPWithTerms',[fields(cs,origin+'/late.delta'),baseId,terms.beneficiary,terms.royaltyBps]);
 assert.equal(await page.evaluate(id=>window.app.state.meps.some(m=>m.mepId===id),childId),false,'child absent from startup catalog');
 assert.equal(deltaHits,0,'no speculative child fetch');console.log('  ok   root resident before late child registration; no child fetched');
 const toBlock=async n=>{const now=await anvil.block();if(n>now)await anvil.mine(n-now);};
 const enter=async e=>{await toBlock(e*dep.epochBlocks-5);await waitFor(async()=>(await R.api('/status')).commits.includes(e),'beacon commit');await toBlock(e*dep.epochBlocks+2);await waitFor(async()=>(await R.api('/status')).reveals.includes(e),'beacon reveal');await toBlock(e*dep.epochBlocks+12);await waitFor(async()=>(await R.api('/status')).epochsRolled.includes(e),'epoch roll');};
 const epoch=Math.floor((await anvil.block())/dep.epochBlocks)+1;
 await enter(epoch);await waitFor(()=>page.evaluate(({id,e})=>!!window.app.state.claims[id]?.[e],{id:baseId,e:epoch}),'base claim');
 await enter(epoch+1);await waitFor(()=>page.evaluate(({id,e})=>window.app.state.materialized[id]?.[e]===true,{id:baseId,e:epoch}),'base materialization');
 assert.equal(await W.instances.read.isEligible([W.account.address,childId,BigInt(epoch+1)]),true,'base enrollment makes late child eligible');
 const expected=await ref.execute(cs.mep.mepId,{steps:STEPS,commitStride:1,stimulusSeed:7});
 const task={mepId:childId,stimulusSeed:7,steps:STEPS,commitStride:1,initStateRoot:H.hex(expected.result.initStateRoot),fee:parseEther('0.01'),deadline:BigInt(await anvil.block()+50),redundancy:1},nonce='0x'+'71'.repeat(32);
 await D.pub.waitForTransactionReceipt({hash:await D.market.write.postTask([task,nonce],{value:task.fee})});
 const taskId=H.taskIdOf(task,nonce);assert.deepEqual((await D.market.read.executors([taskId])).map(x=>x.toLowerCase()),[W.account.address.toLowerCase()]);
 const {RelayClient}=await H.porw('relay_client.js'),{keypair}=await H.porw('claim.js');const client=new RelayClient([(await R.api('/deployment')).relay],keypair(H.KEYS[0]));await client.connect();cleanup.push(()=>client.close());
 const session=await page.evaluate(()=>window.app.state.delegation.session);
 await assert.rejects(client.request(session,'task-announce',childId,{taskId:'0x'+'ff'.repeat(32),steps:STEPS,commitStride:1,stimulusSeed:7},{timeoutMs:15000,responseType:'result'}),error=>error.refused?.taskId==='0x'+'ff'.repeat(32));
 assert.equal(deltaHits,0,'nonexistent task rejected before recipe fetch');
 const response=await client.request(session,'task-announce',childId,{taskId,steps:STEPS,commitStride:1,stimulusSeed:7,initStateRoot:task.initStateRoot},{timeoutMs:90000,responseType:'result'});
 assert.equal(response.payload.execRoot,H.hex(expected.result.execRoot));assert.equal(response.payload.execDigest,H.hex(expected.result.execDigest));assert.equal(deltaHits,1);assert.equal(baseHits,1);console.log('  ok   assigned child executed from one recipe; result matches independent runtime');
 assert.deepEqual(await page.evaluate(()=>[...window.app.state.node.models.keys()]),[baseId],'child execution does not become resident');
 await waitFor(()=>D.market.read.submitted([taskId,W.account.address]),'signed child result on chain');
 const replay=await page.evaluate(id=>window.appActions.replayFamilyTask(id),taskId);assert.equal(replay.verified,true);assert.equal(replay.res.execRoot,response.payload.execRoot);assert.equal(deltaHits,1);assert.equal(baseHits,1);
 console.log('PASS browser family hosting: late child registration, root-only enrollment and residency, assigned task, exact independent result, delta-only fetch, persisted replay after submission');
} catch(error){if(page)console.error('page log:',await page.locator('#log').textContent().catch(()=>''));if(R)console.error('relayer tail:',R.log().slice(-3000));throw error;}
finally {if(browser)await browser.close();for(const stop of cleanup.reverse())try{await stop();}catch{}anvil.stop();}
