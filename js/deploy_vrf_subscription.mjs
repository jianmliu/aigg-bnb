#!/usr/bin/env node
// Creates and funds one testnet subscription, deploys its mesh and enrolls its controller.
// Private journal contains signed transactions. Preserve it; do not commit or delete it.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {parseArgs} from 'node:util';
import {createPublicClient,createWalletClient,http,defineChain,parseAbi,encodeFunctionData,parseEventLogs,keccak256,stringToHex} from 'viem';
import {privateKeyToAccount} from 'viem/accounts';
import {deployFamilyMesh} from './migrate_family_mesh.mjs';
import {BSC_TESTNET_VRF} from './check_vrf_deployment.mjs';
const json=x=>JSON.stringify(x,(_,v)=>typeof v==='bigint'?String(v):v,2)+'\n';
const same=(a,b)=>a.toLowerCase()===b.toLowerCase();
export const subscriptionAbi=parseAbi([
 'function createSubscription() returns(uint256)',
 'event SubscriptionCreated(uint256 indexed subId,address owner)',
 'function fundSubscriptionWithNative(uint256 subId) payable',
 'function addConsumer(uint256 subId,address consumer)',
 'function getSubscription(uint256 subId) view returns(uint96 balance,uint96 nativeBalance,uint64 reqCount,address subOwner,address[] consumers)',
]);
export async function deployVrfSubscription({c,cfg,journal}) {
 assert([97,31337].includes(cfg.chainId),'unsupported chain');
 assert.equal(await c.pub.getChainId(),cfg.chainId,'wrong chain');
 assert(same(c.account.address,cfg.owner),'wrong owner');
 assert(['synchronous-vrf-v1','synchronous-vrf-rounds-v1'].includes(cfg.protocol),'unsupported VRF mode');
 if(cfg.protocol==='synchronous-vrf-rounds-v1'){assert(Number.isSafeInteger(cfg.rounds?.roundBlocks)&&cfg.rounds.roundBlocks>0,'round blocks');assert(Number.isInteger(cfg.rounds?.maxRoundTasks)&&cfg.rounds.maxRoundTasks>0&&cfg.rounds.maxRoundTasks<=64,'round task bound');}
 assert.equal(cfg.vrf.nativePayment,true,'native payment required');
 assert(Number.isInteger(cfg.vrf.requestConfirmations)&&cfg.vrf.requestConfirmations>=3&&cfg.vrf.requestConfirmations<=200,'confirmations');
 assert(Number.isInteger(cfg.vrf.callbackGasLimit)&&cfg.vrf.callbackGasLimit>=100000&&cfg.vrf.callbackGasLimit<=2500000,'callback gas');
 for(const k of ['waitBlocks','activationBlocks','readyTTL'])assert(Number.isSafeInteger(cfg.vrf[k])&&cfg.vrf[k]>0,'invalid window');
 assert(BigInt(cfg.admissionFeeWei)>0n,'admission fee');
 assert(BigInt(cfg.fundingWei)>0n && BigInt(cfg.fundingWei)<=50_000_000_000_000_000n,'funding limit');
 if(cfg.chainId===97){
  assert(same(cfg.vrf.coordinator,BSC_TESTNET_VRF.coordinator),'wrong coordinator');
  assert(same(cfg.vrf.keyHash,BSC_TESTNET_VRF.keyHash),'wrong key hash');
 }
 assert((await c.pub.getBytecode({address:cfg.vrf.coordinator}))?.length>2,'coordinator has no code');
 const configHash=keccak256(stringToHex(json(cfg)));
 const state=fs.existsSync(journal)?JSON.parse(fs.readFileSync(journal)):{version:1,configHash,chainId:cfg.chainId,owner:cfg.owner,coordinator:cfg.vrf.coordinator,transactions:{}};
 assert.equal(state.configHash,configHash,'subscription journal mismatch');
 const save=()=>{fs.mkdirSync(path.dirname(journal),{recursive:true});fs.writeFileSync(journal+'.tmp',json(state),{mode:0o600});fs.renameSync(journal+'.tmp',journal);};save();
 async function tx(label,functionName,args=[],value=0n){
  let row=state.transactions[label];
  if(!row){
   const nonce=await c.pub.getTransactionCount({address:cfg.owner,blockTag:'latest'});
   assert.equal(await c.pub.getTransactionCount({address:cfg.owner,blockTag:'pending'}),nonce,'pending deployer nonce');
   const gasPrice=await c.pub.getGasPrice();assert(gasPrice<=3_000_000_000n,'gas ceiling');
   const to=cfg.vrf.coordinator,data=encodeFunctionData({abi:subscriptionAbi,functionName,args});
   const gas=(await c.pub.estimateGas({account:c.account,to,data,value}))*120n/100n;
   assert(gas<1_000_000n,'gas limit');
   assert(await c.pub.getBalance({address:cfg.owner})>value+gas*gasPrice+20_000_000_000_000_000n,'wallet reserve');
   const request=await c.wallet.prepareTransactionRequest({account:c.account,to,data,value,nonce,gas,gasPrice,type:'legacy'});
   const serializedTransaction=await c.wallet.signTransaction(request);
   row=state.transactions[label]={hash:keccak256(serializedTransaction),serializedTransaction,status:'prepared'};save();
  }
  assert.equal(keccak256(row.serializedTransaction),row.hash,'corrupt signed transaction');
  if(row.status!=='success'){
   try{await c.wallet.sendRawTransaction({serializedTransaction:row.serializedTransaction});}
   catch(error){try{await c.pub.getTransaction({hash:row.hash});}catch{throw error;}}
  }
  const receipt=await c.pub.waitForTransactionReceipt({hash:row.hash,confirmations:cfg.chainId===97?3:1,timeout:180000});
  assert.equal(receipt.status,'success',label+' reverted');
  Object.assign(row,{status:'success',blockNumber:String(receipt.blockNumber),gasUsed:String(receipt.gasUsed)});save();
  console.log(label,row.hash);return receipt;
 }
 const receipt=await tx('create-subscription','createSubscription');
 const events=parseEventLogs({abi:subscriptionAbi,eventName:'SubscriptionCreated',logs:receipt.logs.filter(l=>same(l.address,cfg.vrf.coordinator))});
 assert.equal(events.length,1,'missing subscription creation event');
 assert(same(events[0].args.owner,cfg.owner),'subscription owner mismatch');
 const subId=events[0].args.subId;assert(subId>0n);state.subId=String(subId);save();
 const getSub=()=>c.pub.readContract({address:cfg.vrf.coordinator,abi:subscriptionAbi,functionName:'getSubscription',args:[subId]});
 assert(same((await getSub())[3],cfg.owner),'subscription owner changed');
 await tx('fund-subscription','fundSubscriptionWithNative',[subId],BigInt(cfg.fundingWei));
 const mesh=await deployFamilyMesh({c,cfg:{...cfg,vrf:{...cfg.vrf,subId:String(subId)}},journal:journal+'.mesh.json'});
 state.addresses=mesh.addresses;state.consumer=mesh.addresses.admission;save();
 const consumerAbi=parseAbi(['function subId() view returns(uint256)','function coordinator() view returns(address)','function MARKET() view returns(address)']);
 const read=fn=>c.pub.readContract({address:state.consumer,abi:consumerAbi,functionName:fn});
 assert.equal(await read('subId'),subId);assert(same(await read('coordinator'),cfg.vrf.coordinator));assert(same(await read('MARKET'),mesh.addresses.market));
 if(state.transactions['add-consumer'] || !(await getSub())[4].some(x=>same(x,state.consumer)))await tx('add-consumer','addConsumer',[subId,state.consumer]);
 const [linkBalance,nativeBalance,reqCount,owner,consumers]=await getSub();
 assert(same(owner,cfg.owner));assert(consumers.some(x=>same(x,state.consumer)),'consumer missing');
 assert(nativeBalance>0n,'empty native subscription balance');
 state.subscription={linkBalance:String(linkBalance),nativeBalance:String(nativeBalance),reqCount:String(reqCount),owner,consumers};
 state.verifiedAt=new Date().toISOString();save();return state;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const {values}=parseArgs({options:{broadcast:{type:'boolean'},config:{type:'string'},journal:{type:'string'}}});
 assert(values.broadcast&&values.config&&values.journal,'--broadcast --config FILE --journal FILE required');
 const cfg=JSON.parse(fs.readFileSync(values.config));assert.equal(cfg.chainId,97);
 const account=privateKeyToAccount(process.env.PORW_DEPLOYER_KEY);
 assert(same(account.address,'0xFE560Af8f5cFC209794b3Df7DC7E281D4Ef81EDa'),'wrong deployment wallet');
 const chain=defineChain({id:97,name:'BSC Testnet',nativeCurrency:{name:'tBNB',symbol:'tBNB',decimals:18},rpcUrls:{default:{http:[cfg.rpc]}}});
 const c={account,pub:createPublicClient({chain,transport:http(cfg.rpc)}),wallet:createWalletClient({account,chain,transport:http(cfg.rpc)})};
 fs.mkdirSync(path.dirname(values.journal),{recursive:true});
 const lock=values.journal+'.lock';
 const fd=fs.openSync(lock,'wx',0o600);fs.writeSync(fd,String(process.pid));fs.closeSync(fd);
 try{
  const s=await deployVrfSubscription({c,cfg,journal:values.journal});
  console.log(json({subId:s.subId,consumer:s.consumer,subscription:s.subscription,addresses:s.addresses,liveProofVerified:false}));
 }finally{fs.rmSync(lock);}
}
