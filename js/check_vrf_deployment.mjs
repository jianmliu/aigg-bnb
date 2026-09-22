#!/usr/bin/env node
/** Read-only deployment preflight. Build ABIs with `forge build --root contracts` first.
 * node js/check_vrf_deployment.mjs --rpc=https://... --market=0x... --chain-id=97
 * Also accepts PORW_RPC, PORW_MARKET, PORW_CHAIN_ID. Never loads a wallet or sends a transaction.
 * Subscription funding/consumer registration and live VRF delivery require separate verification.
 */
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { createPublicClient, http, isAddress, zeroAddress } from 'viem';

export const BSC_TESTNET_VRF = Object.freeze({
 coordinator:'0xDA3b641D438362C440Ac5458c57e00a712b66700',
 // https://docs.chain.link/vrf/v2-5/supported-networks#bnb-chain-testnet
 minConfirmations:3,maxConfirmations:200,maxCallbackGas:2500000,
 keyHash:'0x8596b430971ac45bdf6088665b9ad8e8630c9d5049ab54b14dff711bee7c0e26',
});
const same=(a,b)=>typeof a==='string'&&typeof b==='string'&&a.toLowerCase()===b.toLowerCase();
const validAddress=a=>typeof a==='string'&&isAddress(a,{strict:false})&&!same(a,zeroAddress);
function loadAbis(){
 return Object.fromEntries(['VrfSynchronousTaskMarket','VrfAdmission','HostCapacity','InstanceRegistry','SynchronousExecutionDisputes'].map(name=>[
  name,JSON.parse(fs.readFileSync(new URL(`../contracts/out/${name}.sol/${name}.json`,import.meta.url),'utf8')).abi,
 ]));
}

/** Inject a read-only viem-compatible client for offline verification. All state reads share one finalized block, whose hash is rechecked before success. */
export async function checkVrfDeployment({client,market,chainId,abis}){
 const result={configurationValid:false,liveProofVerified:false,errors:[],
  subscription:{status:'external-check-required',checks:['subscription exists','controller is an authorized consumer','sufficient balance for selected payment asset']},
  liveProof:{status:'not-verified',required:'A real coordinator request and callback followed by successful task activation.'}};
 let stage='input';
 const requireCheck=(ok,code)=>{if(!ok)result.errors.push(code);};
 try{
  requireCheck(validAddress(market),'invalid-market-address');
  requireCheck(Number(chainId)===97,'unsupported-expected-chain');
  if(result.errors.length)return result;
  stage='chain';const actualChain=await client.getChainId();result.chainId=actualChain;
  requireCheck(actualChain===Number(chainId)&&actualChain===97,'chain-mismatch');
  if(result.errors.length)return result;
  stage='artifacts';abis??=loadAbis();
  stage='snapshot';const snapshot=await client.getBlock({blockTag:'finalized'});
  requireCheck(typeof snapshot.number==='bigint'&&snapshot.number>=0n&&/^0x[0-9a-f]{64}$/i.test(snapshot.hash??''),'invalid-finalized-block');
  if(result.errors.length)return result;
  const blockNumber=snapshot.number;result.blockNumber=String(blockNumber);result.blockHash=snapshot.hash;result.blockTag='finalized';
  const read=async(address,contract,functionName,args=[])=>{
   stage=`read:${contract}.${functionName}`;
   return client.readContract({address,abi:abis[contract],functionName,args,blockNumber});
  };
  const code=async(address,label)=>{
   if(!validAddress(address)){result.errors.push(`invalid-${label}-address`);return false;}
   stage=`code:${label}`;const bytecode=await client.getBytecode({address,blockNumber});
   const exists=!!bytecode&&bytecode!=='0x';requireCheck(exists,`missing-${label}-code`);return exists;
  };
  if(!await code(market,'market'))return result;
  const m=name=>read(market,'VrfSynchronousTaskMarket',name);
  requireCheck(BigInt(await m('admissionVersion'))===2n,'admission-version-not-2');
  requireCheck(BigInt(await m('protocolVersion'))===1n,'protocol-version-not-1');
  if(result.errors.length)return result;
  const controller=await m('admission'),capacity=await m('hostCapacity'),registry=await m('instances'),disputes=await m('disputes');
  result.addresses={market,controller,capacity,registry,disputes};
  for(const [label,address] of Object.entries({controller,capacity,registry,disputes}))await code(address,label);
  if(result.errors.length)return result;
  const c=name=>read(controller,'VrfAdmission',name);
  requireCheck(same(await c('MARKET'),market),'controller-market-mismatch');
  requireCheck(same(await c('instances'),registry),'controller-registry-mismatch');
  requireCheck(same(await read(disputes,'SynchronousExecutionDisputes','market'),market),'disputes-market-mismatch');
  requireCheck(same(await read(disputes,'SynchronousExecutionDisputes','instances'),registry),'disputes-registry-mismatch');
  for(const [label,address] of Object.entries({market,controller}))
   requireCheck(await read(capacity,'HostCapacity','authorizedMarkets',[address])===true,`capacity-${label}-unauthorized`);
  for(const [label,address] of Object.entries({controller,disputes}))
   requireCheck(await read(registry,'InstanceRegistry','slasher',[address])===true,`registry-${label}-unauthorized`);
  const config={};
  for(const name of ['coordinator','keyHash','subId','requestConfirmations','callbackGasLimit','nativePayment','WAIT_BLOCKS','ACTIVATION_BLOCKS','READY_TTL','feeRecipient']){
   const value=await c(name);config[name]=typeof value==='bigint'?String(value):value;
  }
  config.nativeAdmissionFee=String(await read(controller,'VrfAdmission','admissionFee',[zeroAddress]));
  result.config=config;
  requireCheck(same(config.coordinator,BSC_TESTNET_VRF.coordinator),'coordinator-not-approved-bsc-testnet');
  requireCheck(same(config.keyHash,BSC_TESTNET_VRF.keyHash),'key-hash-not-approved-bsc-testnet');
  await code(config.coordinator,'coordinator');
  requireCheck(BigInt(config.subId)>0n,'zero-subscription');
  requireCheck(Number(config.requestConfirmations)>=BSC_TESTNET_VRF.minConfirmations&&Number(config.requestConfirmations)<=BSC_TESTNET_VRF.maxConfirmations,'unsupported-request-confirmations');
  requireCheck(Number(config.callbackGasLimit)>=100000&&Number(config.callbackGasLimit)<=BSC_TESTNET_VRF.maxCallbackGas,'unsupported-callback-gas');
  requireCheck(typeof config.nativePayment==='boolean','invalid-payment-mode');
  for(const name of ['WAIT_BLOCKS','ACTIVATION_BLOCKS','READY_TTL'])requireCheck(BigInt(config[name])>0n,`zero-${name.toLowerCase()}`);
  requireCheck(validAddress(config.feeRecipient),'invalid-fee-recipient');
  requireCheck(BigInt(config.nativeAdmissionFee)>0n,'zero-native-admission-fee');
  stage='snapshot-recheck';const recheck=await client.getBlock({blockNumber});
  requireCheck(recheck.number===blockNumber&&same(recheck.hash,snapshot.hash),'snapshot-block-changed');
  result.configurationValid=result.errors.length===0;
 }catch{
  // RPC errors can include URLs, authorization headers and other credentials. Never serialize them.
  result.errors.push(`check-unavailable:${stage}`);
 }
 return result;
}

export async function main(argv=process.argv.slice(2),env=process.env){
 try{
  const {values}=parseArgs({args:argv,options:{rpc:{type:'string'},market:{type:'string'},'chain-id':{type:'string'},help:{type:'boolean'}},strict:true});
  if(values.help){console.log('Read-only VRF configuration preflight: --rpc URL --market ADDRESS --chain-id 97 (or PORW_RPC/PORW_MARKET/PORW_CHAIN_ID). Build artifacts with forge build --root contracts. Funding, consumer registration, and live callbacks require separate verification.');return 0;}
  const rpc=values.rpc??env.PORW_RPC,market=values.market??env.PORW_MARKET,chainId=Number(values['chain-id']??env.PORW_CHAIN_ID);
  if(!rpc||!/^https?:\/\//i.test(rpc))throw Error('invalid rpc');
  const client=createPublicClient({transport:http(rpc,{timeout:5000,retryCount:0}),batch:{multicall:false}});
  const result=await checkVrfDeployment({client,market,chainId});
  console.log(JSON.stringify(result,null,2));return result.configurationValid?0:1;
 }catch{
  console.log(JSON.stringify({configurationValid:false,liveProofVerified:false,errors:['invalid-arguments-or-client-setup']}));return 1;
 }
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)process.exitCode=await main();
