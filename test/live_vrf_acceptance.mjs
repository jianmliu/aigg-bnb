// Explicit chain-97 acceptance against the staged VRF deployment. Keys stay in a private /tmp journal.
// VRF_SMOKE_OWNER_KEY and VRF_SMOKE_PAYLOAD are required; never uses mock callbacks.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import {createPublicClient,createWalletClient,http,encodeFunctionData,keccak256,encodePacked,zeroAddress,parseEther,parseEventLogs} from 'viem';
import {generatePrivateKey,privateKeyToAccount} from 'viem/accounts';
import {chainOf,eip712Domains} from '../relayer/chain.mjs';
import {PrivateJournal} from '../js/smoke_synchronous_testnet.mjs';
import {subscriptionAbi} from '../js/deploy_vrf_subscription.mjs';
import * as H from './harness.mjs';
assert(process.argv.includes('--broadcast'),'explicit --broadcast required');
const dep=JSON.parse(fs.readFileSync('tasks/live-runs/vrf-subscription-2026-09-22.json'));
assert.equal(dep.chainId,97);
const rpc='https://bsc-testnet-dataseed.bnbchain.org/',chain=chainOf(97,rpc),pub=createPublicClient({chain,transport:http(rpc,{retryCount:2})});
assert.equal(await pub.getChainId(),97);
const owner=privateKeyToAccount(process.env.VRF_SMOKE_OWNER_KEY);assert.equal(owner.address.toLowerCase(),dep.subscription.owner.toLowerCase());
const journal=new PrivateJournal('/tmp/aigg-vrf-live-acceptance.bin');
const lock=fs.openSync(journal.file+'.lock','wx',0o600);fs.writeSync(lock,String(process.pid));fs.closeSync(lock);
const state=journal.load()||{market:dep.addresses.market,owner:owner.address,hosts:Array.from({length:3},()=>({key:generatePrivateKey(),salt:generatePrivateKey()})),transactions:{},secret:generatePrivateKey(),nonce:generatePrivateKey()};
assert.equal(state.market,dep.addresses.market);assert.equal(state.owner,owner.address);
const save=()=>journal.save(state);save();
const log=(...x)=>console.log(new Date().toISOString(),...x),sleep=ms=>new Promise(r=>setTimeout(r,ms));
const abi=n=>JSON.parse(fs.readFileSync(`contracts/out/${n}.sol/${n}.json`)).abi;
const types={market:'VrfSynchronousTaskMarket',admission:'VrfAdmission',instances:'InstanceRegistry',claims:'PoRWClaimManager',beacon:'CommitRevealBeacon',hostCapacity:'HostCapacity',meps:'MEPRegistry'};
const read=(key,fn,args=[],blockNumber)=>pub.readContract({address:dep.addresses[key],abi:abi(types[key]),functionName:fn,args,...(blockNumber===undefined?{}:{blockNumber})});
const head=()=>pub.getBlockNumber({cacheTime:0});
async function waitBlock(target){for(;;){const remaining=target-await head();if(remaining<=0n)return;log('waiting for block',String(target));await sleep(remaining<60n?1500:10000);}}
async function tx(label,account,to,data='0x',value=0n){
 let r=state.transactions[label];const wallet=createWalletClient({account,chain,transport:http(rpc)});
 if(!r){const nonce=await pub.getTransactionCount({address:account.address,blockTag:'latest'});assert.equal(await pub.getTransactionCount({address:account.address,blockTag:'pending'}),nonce);
  const gasPrice=await pub.getGasPrice();assert(gasPrice<=3_000_000_000n);const gas=data==='0x'?21000n:(await pub.estimateGas({account,to,data,value}))*120n/100n;assert(gas<15_000_000n);
  const balance=await pub.getBalance({address:account.address});assert(balance>value+gas*gasPrice+(account.address===owner.address?parseEther('0.02'):0n),'funding reserve');
  const raw=await wallet.signTransaction(await wallet.prepareTransactionRequest({account,to,data,value,gas,gasPrice,nonce,type:'legacy'}));
  state.transactions[label]=r={raw,hash:keccak256(raw),account:account.address,to,value};save();
 }
 assert.equal(keccak256(r.raw),r.hash);
 if(!r.done)try{await wallet.sendRawTransaction({serializedTransaction:r.raw});}catch(e){try{await pub.getTransaction({hash:r.hash});}catch{throw e;}}
 const receipt=await pub.waitForTransactionReceipt({hash:r.hash,confirmations:3,timeout:180000});assert.equal(receipt.status,'success',label);
 r.done=true;r.blockNumber=receipt.blockNumber;r.gasUsed=receipt.gasUsed;r.gasPrice=receipt.effectiveGasPrice;save();log(label,r.hash);return receipt;
}
const call=(label,account,key,fn,args=[],value=0n)=>tx(label,account,dep.addresses[key],encodeFunctionData({abi:abi(types[key]),functionName:fn,args}),value);
async function cleanupHosts(){
 for(let i=0;i<state.hosts.length;i++){
  const h=state.hosts[i],account=privateKeyToAccount(h.key);h.address=account.address;
  assert.equal(await read('hostCapacity','activeSlots',[h.address]),0,'host still reserved');assert.equal(await read('instances','disputeHolds',[h.address]),0n,'host still held');assert.equal(BigInt(await read('market','pendingTask',[h.address])),0n,'host still pending');
  if(await read('market','ready',[h.address]))await call('disarm-'+i,account,'market','setReady',[false]);
  const credit=await read('market','credits',[zeroAddress,h.address]);h.credit??=credit;save();
  if(credit>0n || state.transactions['withdraw-'+i])await call('withdraw-'+i,account,'market','withdrawCredit',[zeroAddress,owner.address]);
  if(await read('instances','bonded',[h.address])>0n && await read('instances','exitAt',[h.address])===0n)await call('exit-'+i,account,'instances','requestExit');
 }
 log('all task holds released; waiting for refundable bond exits');
 await waitBlock((await Promise.all(state.hosts.map(h=>read('instances','exitAt',[h.address])))).reduce((a,b)=>a>b?a:b,0n));
 for(let i=0;i<state.hosts.length;i++){
  const h=state.hosts[i],account=privateKeyToAccount(h.key);
  if(await read('instances','bonded',[h.address])>0n)await call('finalize-exit-'+i,account,'instances','finalizeExit');
  if(!state.transactions['sweep-'+i]){const balance=await pub.getBalance({address:account.address}),gasPrice=await pub.getGasPrice();h.sweep=balance-gasPrice*21000n-1000000000000n;save();}
  if(h.sweep>0n)await tx('sweep-'+i,account,owner.address,'0x',h.sweep);
  assert.equal(await read('instances','bonded',[h.address]),0n);
 }
 state.cleanupComplete=true;save();
}
if(process.argv.includes('--cleanup')){await cleanupHosts();fs.unlinkSync(journal.file+'.lock');log('cleanup complete');process.exit(0);}
const {PorwNode}=await H.porw('node.js'),{loadKernelFromBytes}=await H.porw('porw.js');
const payload=new Uint8Array(fs.readFileSync(process.env.VRF_SMOKE_PAYLOAD)),wasm=fs.readFileSync(H.porwDir+'/sketch.wasm');
const domains=eip712Domains({chainId:97,addresses:dep.addresses});const runtimes=[];
for(let i=0;i<3;i++){
 const h=state.hosts[i],account=privateKeyToAccount(h.key);h.address=account.address;
 const node=new PorwNode(await loadKernelFromBytes(wasm),{privHex:h.key,domains});
 const model=await node.loadModel('flywire-fafb-v783-min5',payload,{exec:'lif',wUnitQ16:18022,maxSteps:4});
 assert.equal(H.hex(model.mep.mepId),'0x312dda12d308ba13796472e6ba444be4a94a5b04ce9e5ef3ada3649034443f8a');
 runtimes.push({h,account,node,model});log('real brain loaded',i,model.hdr.neurons,model.hdr.synapses);save();
}
const mepId=H.hex(runtimes[0].model.mep.mepId);assert(await read('market','profileMaxInDegree',[mepId])>0);
for(let i=0;i<3;i++){
 const {account}=runtimes[i];await tx('fund-host-'+i,owner,account.address,'0x',parseEther('0.006'));
 await call('bond-'+i,account,'instances','bond',[[mepId]],parseEther('0.005'));
 await call('capacity-'+i,account,'hostCapacity','setCapacity',[1]);
}
// Residency beacon is distinct from VRF assignment. One real commit/reveal supplies the claim challenge.
if(!state.epoch){const n=await head();state.epoch=n/200n+1n;save();}
await waitBlock(state.epoch*200n-38n);
await call('beacon-commit',owner,'beacon','commit',[keccak256(encodePacked(['bytes32','address'],[state.secret,owner.address]))],parseEther('0.005'));
await waitBlock(state.epoch*200n);
await call('beacon-reveal',owner,'beacon','reveal',[state.epoch,state.secret]);
await waitBlock(state.epoch*200n+41n);
await call('roll-epoch',owner,'claims','rollEpoch');
const challenge=await read('claims','epochChallenge',[state.epoch,mepId]);
for(let i=0;i<3;i++){
 const {h,account,node,model}=runtimes[i];
 if(!h.claim){const r=await node.residency(model.mep.mepId,H.unhex(challenge));h.claim={mepId,partialsRoot:H.hex(r.claim.partialsRoot),coverageBytes:BigInt(r.claim.coverageBytes),challenge};h.claimSignature=H.hex(r.signature);save();}
 await call('claim-'+i,account,'claims','submitClaim',[h.claim,h.claimSignature]);
 if(!state.transactions['post-task'])assert(await read('instances','isEligible',[account.address,mepId,await read('claims','currentEpoch')]));
 await call('ready-'+i,account,'market','setReady',[true]);
}
if(!state.task){state.task={mepId,stimulusSeed:7,steps:4,commitStride:1,initStateRoot:H.hex((await runtimes[0].node.execute(runtimes[0].model.mep.mepId,{steps:4,commitStride:1,stimulusSeed:7})).result.initStateRoot),fee:parseEther('0.001'),deadline:0n,redundancy:2};state.taskId=await read('market','taskId',[state.task,zeroAddress,state.nonce,0,owner.address]);save();}
if(!state.subBefore){state.subBefore=await pub.readContract({address:dep.coordinator,abi:subscriptionAbi,functionName:'getSubscription',args:[BigInt(dep.subscriptionId)]});save();}
const admissionFee=await read('admission','admissionFee',[zeroAddress]);
const post=await call('post-task',owner,'market','postTask',[state.task,state.nonce],state.task.fee+admissionFee);
if(!state.candidates){
assert.equal(Number((await read('market','sessionState',[state.taskId],post.blockNumber))[0]),6);
state.candidates=await read('admission','candidates',[state.taskId],post.blockNumber);assert.equal(state.candidates.length,3);
for(const c of state.candidates){assert(state.hosts.some(h=>h.address.toLowerCase()===c.host.toLowerCase()));assert.equal(await read('hostCapacity','activeSlots',[c.host],post.blockNumber),1);assert.equal(await read('instances','disputeHolds',[c.host],post.blockNumber),1n);}
save();}
log('POOL LOCKED',state.taskId);
let info=await read('admission','requestInfo',[state.taskId]);
while(Number(info[5])===1 && await head()<=info[1]){log('waiting for real Chainlink callback',String(info[0]));await sleep(12000);info=await read('admission','requestInfo',[state.taskId]);}
if(Number(info[5])===1){await call('expire-no-word',owner,'market','expire',[state.taskId]);await cleanupHosts();fs.unlinkSync(journal.file+'.lock');throw Error('VRF callback deadline missed; task expired, cleanup required');}
assert(info[2]>0n,'missing real callback');state.requestInfo=info;save();
// Exact fulfillment block receipts avoid historical eth_getLogs range scans.
if(!state.callback){
 const block=await pub.getBlock({blockNumber:info[2],includeTransactions:true});
 let receipts;try{receipts=await pub.getBlockReceipts({blockNumber:info[2]});}catch{receipts=[];for(const t of block.transactions)receipts.push(await pub.getTransactionReceipt({hash:t.hash}));}
 for(const r of receipts){const t=block.transactions.find(t=>t.hash===r.transactionHash);const events=parseEventLogs({abi:abi('VrfAdmission'),eventName:'RandomnessFulfilled',logs:r.logs.filter(l=>l.address.toLowerCase()===dep.consumer.toLowerCase())});
  if(events.some(e=>e.args.taskId===state.taskId&&e.args.requestId===info[0])){assert.equal(r.status,'success');state.callback={hash:r.transactionHash,blockNumber:r.blockNumber,from:t.from,to:t.to};break;}
 }
 assert(state.callback,'callback receipt not found');save();
}
log('REAL CALLBACK',state.callback.hash);
const allocation=await call('allocate',owner,'market','allocate',[state.taskId]);
state.executors=await read('market','executors',[state.taskId]);assert.equal(state.executors.length,2);assert.notEqual(state.executors[0],state.executors[1]);save();
if(!Object.keys(state.transactions).some(k=>k.startsWith('commit-result-')))for(const h of state.hosts){const selected=state.executors.some(a=>a.toLowerCase()===h.address.toLowerCase());assert.equal(await read('hostCapacity','activeSlots',[h.address],allocation.blockNumber),selected?1:0);assert.equal(await read('instances','disputeHolds',[h.address],allocation.blockNumber),selected?1n:0n);}
for(const address of state.executors){const i=runtimes.findIndex(r=>r.account.address.toLowerCase()===address.toLowerCase()),r=runtimes[i],h=r.h;
 if(!h.result){const result=(await r.node.execute(r.model.mep.mepId,{steps:4,commitStride:1,stimulusSeed:7})).result;assert.equal(H.hex(result.initStateRoot),state.task.initStateRoot);h.result={execDigest:H.hex(result.execDigest),execRoot:H.hex(result.execRoot)};h.counts=result.counts;save();}
 const commitment=await read('market','resultCommitment',[state.taskId,address,h.result.execDigest,h.result.execRoot,h.salt]);
 const signature=await r.account.sign({hash:await read('market','commitmentDigest',[state.taskId,address,commitment])});
 await call('commit-result-'+i,r.account,'market','commitResult',[state.taskId,address,commitment,signature]);
}
const chosen=state.executors.map(a=>runtimes.find(r=>r.account.address.toLowerCase()===a.toLowerCase()));assert.deepEqual(chosen[0].h.result,chosen[1].h.result);assert.deepEqual(chosen[0].h.counts,chosen[1].h.counts);
for(const r of chosen){const i=runtimes.indexOf(r),h=r.h,signature=await r.account.sign({hash:await read('market','resultDigest',[state.taskId,h.address,h.result.execDigest,h.result.execRoot])});await call('reveal-result-'+i,r.account,'market','revealResult',[state.taskId,h.address,h.result,h.salt,signature]);}
assert.equal(Number((await read('market','sessionState',[state.taskId]))[0]),4);state.result=chosen[0].h.result;
const topupFile='tasks/live-runs/vrf-acceptance-topup-2026-09-22.json';
let topupWei=0n;if(fs.existsSync(topupFile)){const t=JSON.parse(fs.readFileSync(topupFile));assert.equal(t.subscriptionId,dep.subscriptionId);const receipt=await pub.getTransactionReceipt({hash:t.hash});assert.equal(receipt.status,'success');const transfer=await pub.getTransaction({hash:t.hash});assert.equal(transfer.to.toLowerCase(),dep.coordinator.toLowerCase());assert.equal(transfer.input,encodeFunctionData({abi:subscriptionAbi,functionName:'fundSubscriptionWithNative',args:[BigInt(dep.subscriptionId)]}));assert.equal(transfer.value,BigInt(t.amountWei));topupWei=transfer.value;}
state.subAfter=await pub.readContract({address:dep.coordinator,abi:subscriptionAbi,functionName:'getSubscription',args:[BigInt(dep.subscriptionId)]});assert(state.subAfter[1]<state.subBefore[1]+topupWei);assert.equal(state.subAfter[2],state.subBefore[2]+1n);
await cleanupHosts();
assert.equal(state.hosts.reduce((sum,h)=>sum+h.credit,0n),state.task.fee);
assert.equal(await read('market','credits',[zeroAddress,await read('admission','feeRecipient')]),admissionFee);
await waitBlock(await head()+15n);
const finalBlock=(await pub.getBlock({blockTag:'finalized'})).number;
assert.equal(Number((await read('market','sessionState',[state.taskId],finalBlock))[0]),4);
const out={chainId:97,market:state.market,subscriptionId:dep.subscriptionId,consumer:dep.consumer,taskId:state.taskId,mepId,model:{neurons:139255,synapses:2700513,name:'flywire-fafb-v783-min5'},subscriptionTopupTransaction:fs.existsSync(topupFile)?JSON.parse(fs.readFileSync(topupFile)).hash:null,task:{initStateRoot:state.task.initStateRoot,steps:4,commitStride:1,stimulusSeed:7,executionFeeWei:String(state.task.fee),admissionFeeWei:String(admissionFee)},candidatePool:state.candidates,executors:state.executors,requestId:String(info[0]),callback:state.callback,result:state.result,subscriptionBeforeWei:String(state.subBefore[1]),subscriptionAfterWei:String(state.subAfter[1]),subscriptionTopupWei:String(topupWei),vrfChargeWei:String(state.subBefore[1]+topupWei-state.subAfter[1]),finalizedBlock:String(finalBlock),status:'completed',temporaryHosts:state.hosts.map(h=>({address:h.address,creditWei:String(h.credit),bondWithdrawn:true})),transactions:Object.fromEntries(Object.entries(state.transactions).map(([k,r])=>[k,{hash:r.hash,blockNumber:r.blockNumber,gasUsed:r.gasUsed}])),liveProofVerified:true,scope:'Real Chainlink callback and direct on-chain task with three local test hosts; not independent operators or browser/gateway acceptance',verifiedAt:new Date().toISOString()};
fs.writeFileSync('tasks/live-runs/vrf-acceptance-2026-09-22.json',JSON.stringify(out,(_,v)=>typeof v==='bigint'?String(v):v,2)+'\n');
state.complete=true;save();fs.unlinkSync(journal.file+'.lock');log('PASS real VRF task, matching WASM execution, payment and host cleanup');
