// Real Female FlyWire + MaleCNS recipes through custody, adoption, funded Breed, hatch and MEP registration.
// Uses local Anvil only. Execution smoke test is 4 steps, NOT the full scientific battery.
import fs from 'node:fs';import path from 'node:path';import assert from 'node:assert/strict';
import {parseEther,stringToHex,keccak256,encodeAbiParameters} from 'viem';
import * as H from './harness.mjs';
import {deriveBreedRecipe} from '../js/breed_recipe.mjs';
import {state0Root} from '../gateway/state0.mjs';
const baseDir=process.env.FOUNDER_BASE_DIR;if(!baseDir)throw Error('FOUNDER_BASE_DIR required');
const {PorwNode}=await H.porw('node.js'),{loadKernelFromBytes}=await H.porw('porw.js'),{withTerms}=await H.porw('mep.js');
const {runLeaf}=await H.porw('batch.js'),{merkleRoot}=await H.porw('verify.js');
const g=JSON.parse(fs.readFileSync(new URL('../flybnb/genesis/genesis-v2.json',import.meta.url)));
const wasm=fs.readFileSync(H.porwDir+'/sketch.wasm'),zero='0x'+'0'.repeat(64),nil='0x'+'0'.repeat(40);
const fields=(m,da)=>({modelId:H.hex(m.modelId),schemeDigest:H.hex(m.schemeDigest),execKind:H.hex(m.execKind),neurons:m.neurons,synapses:m.synapses,synapseRoot:H.hex(m.synapseRoot),weightsDA:stringToHex(da)});
H.forgeBuild();const anvil=await H.startAnvil(8578);
const cleanup=[];
try{
 const dep=await H.deployMesh(anvil.rpc),admin=H.clientsFor(dep,H.KEYS[0]),buyer=H.clientsFor(dep,H.KEYS[1]);
 await H.sendTo(admin,dep.addresses.meps,'MEPRegistry','declareLifKind',[7209]);
 const recipient=await H.create(admin,'TreasuryRouter',[admin.account.address,admin.account.address]);
 const C=await H.create(admin,'FlyCollection',[g.baseModelId,g.baseMale,g.root,g.size,0n,0n,parseEther('0.01'),0n,recipient,dep.addresses.meps,nil,nil,zero,zero,dep.addresses.market,1000,{baseVendor:recipient,baseShareBps:1000,saleRoyaltyBps:500,owner:admin.account.address}]);
 const vault=await H.create(admin,'FounderInventoryVault',[C,recipient,admin.account.address]);
 const sale=await H.readFrom(admin,vault,'FounderInventoryVault','sale');
 let maternal;
 for(const [tokenId,index] of [[1,0],[2,100]]){
  const x=g.individuals[index],unit=x.sex?7209:18022;
  const node=new PorwNode(await loadKernelFromBytes(wasm));
  const b=fs.readFileSync(path.join(baseDir,x.sex?'malecns-v1.0-min2.bin':'flywire-783-min2.bin'));
  const base=node.loadDeltaBase(b);assert.equal(H.hex(base.modelId),x.baseModelId);
  const st=await node.loadDelta(base,H.unhex(x.recipe),{exec:'lif',wUnitQ16:unit,maxSteps:4});
  assert.equal(await H.readFrom(admin,dep.addresses.meps,'MEPRegistry','lifWeightUnit',[H.hex(st.mep.execKind)]),unit);
  const da=`https://aigg-founder-assets.pages.dev/deltas/${x.deltaHash}.delta`;
  await H.sendTo(admin,vault,'FounderInventoryVault','mint',[index,x.sex,x.deltaHash,x.proof]);
  await H.sendTo(admin,vault,'FounderInventoryVault','register',[BigInt(tokenId),x.deltaHash,fields(st.mep,da)]);
  const ind=await H.readFrom(admin,C,'FlyCollection','individuals',[BigInt(tokenId)]);
  assert.equal(ind[3],H.hex(withTerms(st.mep,C,1000).mepId));
  assert.equal(Buffer.from((await admin.meps.read.getMEP([ind[3]])).weightsDA.slice(2),'hex').toString(),da);
  const expiry=(await admin.pub.getBlock()).timestamp+3600n;
  await H.sendTo(admin,vault,'FounderInventoryVault','list',[BigInt(tokenId),parseEther('0.01'),expiry]);
  await H.sendTo(buyer,sale,'TreasuryInventorySale','buy',[BigInt(tokenId),parseEther('0.01'),1n,expiry],parseEther('0.01'));
  if(!x.sex){node.models.clear();maternal={node,base,mark:node.k.mark(),unit};}
  console.log(`PASS real Founder ${index}: terms-bound MEP and direct delta, adopted from treasury inventory`);
 }
 assert.equal(await admin.pub.getBalance({address:recipient}),parseEther('0.02'));
 const runsRoot=H.hex(merkleRoot([1,2].map((seed,i)=>runLeaf(i,seed,state0Root(139255,seed,[0]).root))));
 const policy={versionHash:keccak256(stringToHex('real-founder-smoke-4steps-v1')),runsRoot,runs:2,steps:4,stride:2,redundancy:2,attempts:2,fee:parseEther('0.01'),lifetime:86400};
 const budget=await H.create(admin,'BatteryBudget',[C,dep.addresses.market,admin.account.address,policy]);
 await H.sendTo(buyer,C,'FlyCollection','setApprovalForAll',[budget,true]);
 await H.sendTo(buyer,budget,'BatteryBudget','breed',[1n,2n],parseEther('0.03'));
 const job=await H.readFrom(admin,budget,'BatteryBudget','jobOf',[3n]);assert.notEqual(job,nil);
 assert.equal(await admin.pub.getBalance({address:job}),parseEther('0.02'));
 assert.equal((await H.readFrom(admin,C,'FlyCollection','ownerOf',[3n])).toLowerCase(),buyer.account.address.toLowerCase());
 await anvil.mine(2);await H.sendTo(admin,C,'FlyCollection','hatch',[3n]);
 const child=await H.readFrom(admin,C,'FlyCollection','individuals',[3n]);
 const block=await admin.pub.getBlock({blockNumber:child[9]});
 const expected=keccak256(encodeAbiParameters([{type:'bytes32'},{type:'bytes32'},{type:'uint256'},{type:'uint256'},{type:'uint256'},{type:'bytes32'}],[g.individuals[0].deltaHash,g.individuals[100].deltaHash,1n,2n,3n,block.hash]));
 assert.equal(child[8],expected);assert.equal(child[0],g.baseModelId);
 const recipe=deriveBreedRecipe({maternalRecipe:g.individuals[0].recipe,baseModelId:child[0],seed:child[8],tokenId:3});
 const {node,base,unit}=maternal;const st=await node.loadDelta(base,recipe,{exec:'lif',wUnitQ16:unit,maxSteps:4});
 const deltaHash=keccak256(recipe);
 await H.sendTo(buyer,C,'FlyCollection','register',[3n,deltaHash,fields(st.mep,`https://example.invalid/test-only/${deltaHash}.delta`)]);
 const registered=await H.readFrom(admin,C,'FlyCollection','individuals',[3n]);
 assert.equal(registered[3],H.hex(withTerms(st.mep,C,1000).mepId));
 st.steps=4;st.commitStride=2;
 const execution=await node.runLif(st,1,[0]);assert.equal(execution.stateRoots.length,2);
 console.log('PASS actual child materialized and executed for 4 steps; maternal weight unit retained');
 const mepId=registered[3];
 const R=await H.startRelayer(dep,H.KEYS[3],[mepId]);cleanup.push(()=>R.stop());
 const network=await R.api('/deployment');
 const {RelayClient}=await H.porw('relay_client.js'),{NodeService}=await H.porw('node_service.js');
 const payload=new Uint8Array(node.k.u8(st.bufPtr,st.nTiles*4096));
 const hosts=[];
 for(const key of [H.KEYS[2],H.KEYS[4]]){
  const c=H.clientsFor(dep,key);
  await c.pub.waitForTransactionReceipt({hash:await c.instances.write.bond([[mepId]],{value:parseEther('0.5')})});
  const nd=new PorwNode(await loadKernelFromBytes(wasm),{privHex:key,domains:network.domains});
  const loaded=await nd.loadModel('real-child',payload,{maxSteps:4,exec:'lif',wUnitQ16:unit,terms:{beneficiary:C,royaltyBps:1000}});
  assert.equal(H.hex(loaded.mep.mepId),mepId);
  const rc=new RelayClient([network.relay],nd.key);await rc.connect();cleanup.push(()=>rc.close());
  const svc=new NodeService(nd,rc,{onResult:async r=>{const sent=await R.api('/tx/result',r);assert(sent.ok,JSON.stringify(sent));}});svc.serve(loaded.mep.mepId);
  hosts.push({c,svc,nd,loaded});
 }
 const waitFor=async fn=>{const start=Date.now();while(Date.now()-start<45000){if(await fn())return;await H.sleep(250);}throw Error('host/epoch timeout');};
 const toBlock=async n=>{const now=await anvil.block();if(n>now)await anvil.mine(n-now);};
 const epoch=Math.floor((await anvil.block())/40)+1;
 await toBlock(epoch*40-5);await waitFor(async()=>(await R.api('/status')).commits.includes(epoch));
 await toBlock(epoch*40+2);await waitFor(async()=>(await R.api('/status')).reveals.includes(epoch));
 await toBlock(epoch*40+12);await waitFor(async()=>(await R.api('/status')).epochsRolled.includes(epoch));
 const ep=await R.api('/epoch?mep='+mepId);
 for(const h of hosts)await h.svc.announce(h.loaded.mep.mepId,H.unhex(ep.challenge));
 await toBlock((epoch+1)*40-5);await waitFor(async()=>(await R.api('/status')).commits.includes(epoch+1));
 await toBlock((epoch+1)*40+2);await waitFor(async()=>(await R.api('/status')).reveals.includes(epoch+1));
 await toBlock((epoch+1)*40+12);await waitFor(async()=>(await R.api('/status')).epochsRolled.includes(epoch+1));
 await waitFor(async()=>(await R.api('/status')).rootsPosted.some(r=>r.epoch===epoch&&r.count===2));
 for(const h of hosts){const r=await R.api('/tx/materialize',{mep:mepId,epoch,instance:h.c.account.address.toLowerCase()});assert(r.ok,JSON.stringify(r));}
 await H.sendTo(admin,job,'BatteryJob','post',[BigInt(await anvil.block())+100n]);
 const tid=await H.readFrom(admin,job,'BatteryJob','taskId');assert.notEqual(tid,zero);
 assert.equal(await H.readFrom(admin,job,'BatteryJob','attempt'),1n);
 assert.equal(await admin.pub.getBalance({address:job}),parseEther('0.01'));
 const task=await H.readFrom(admin,dep.addresses.market,'TaskMarket','tasks',[tid]);assert.equal(task[0].mepId,registered[3]);
 const {keypair}=await H.porw('claim.js');
 const client=new RelayClient([network.relay],keypair(H.KEYS[0]));await client.connect();cleanup.push(()=>client.close());
 const outputs=[];
 for(const h of hosts){
  const got=await client.request(H.hex(h.nd.key.address),'batch-announce',mepId,{steps:4,commitStride:2,sets:{smoke:[0]},runs:[{stimulusSeed:1,stimulusSet:'smoke'},{stimulusSeed:2,stimulusSet:'smoke'}],taskId:tid,initStateRoot:runsRoot},{timeoutMs:90000,responseType:'result'});
  outputs.push(got.payload.execRoot);
  await waitFor(()=>admin.market.read.submitted([tid,h.c.account.address]));
 }
 assert.equal(outputs[0],outputs[1]);
 await H.sendTo(admin,dep.addresses.market,'TaskMarket','settle',[tid]);await anvil.mine(1);
 assert.equal(await H.readFrom(admin,job,'BatteryJob','accepted'),true);
 await H.sendTo(admin,job,'BatteryJob','deliver',[keccak256(stringToHex(JSON.stringify({deltaHash,outputs})))]);
 await H.sendTo(buyer,job,'BatteryJob','refund');assert.equal(await admin.pub.getBalance({address:job}),0n);
 await H.sendTo(buyer,C,'FlyCollection','settle',[3n]);
 assert.equal(await H.readFrom(buyer,C,'FlyCollection','owed',[buyer.account.address]),parseEther('0.0009'));
 assert.equal(await H.readFrom(buyer,C,'FlyCollection','owed',[recipient]),parseEther('0.0001'));
 console.log('PASS two real-model hosts agree, task settles, job delivers, unused budget refunds and royalties split');
 console.log('PASS Breed -> funded job -> hatch -> real delta -> royalty MEP -> paid task');
 const report={chain:'local Anvil only',genesisRoot:g.root,parentIndices:[0,100],childBase:child[0],childSex:Number(child[4]),childSeed:child[8],childDeltaHash:deltaHash,childProfileId:H.hex(st.mep.mepId),childMepId:registered[3],wUnitQ16:unit,steps:4,taskId:tid,fullScientificBatteryExecuted:false,result:'PASS'};
 fs.writeFileSync(process.env.FOUNDER_BREED_REPORT||'/tmp/aigg-real-breed-report.json',JSON.stringify(report,null,2)+'\n');
}finally{for(const fn of cleanup.reverse())await fn();anvil.stop();}
