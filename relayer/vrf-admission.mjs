import {parseAbi} from 'viem';
import {readFinalized} from './synchronous.mjs';
export const VRF_MODE='synchronous-vrf-v1';
export const VrfAdmissionAbi=parseAbi([
 'function MARKET() view returns (address)',
 'function WAIT_BLOCKS() view returns (uint64)',
 'function ACTIVATION_BLOCKS() view returns (uint64)',
 'function READY_TTL() view returns (uint64)',
 'function MAX_CANDIDATES() view returns (uint256)',
 'function readyUntil(address) view returns (uint64)',
 'function requestInfo(bytes32) view returns (uint256 requestId,uint64 randomnessDeadline,uint64 fulfilledAt,uint64 allocationDeadline,uint64 maxSessionEnd,uint8 state,uint8 candidateCount)',
]);
export function normalizeAdmission(raw){
 return {requestId:String(raw[0]),randomnessDeadline:String(raw[1]),fulfilledAt:String(raw[2]),allocationDeadline:String(raw[3]),maxSessionEnd:String(raw[4]),state:Number(raw[5]),candidateCount:Number(raw[6])};
}
export function admissionAction(info,head){
 if(info.state===1)return BigInt(head)>BigInt(info.randomnessDeadline)?'expire':null;
 if(info.state===2)return BigInt(head)>BigInt(info.allocationDeadline)?'expire':'allocate';
 return null;
}
export async function readAdmission(ch,id,options={}){
 const address=await ch.market.read.admission([],options);
 return normalizeAdmission(await ch.pub.readContract({address,abi:VrfAdmissionAbi,functionName:'requestInfo',args:[id],...options}));
}
export async function admissionCapability(ch){
 if(ch.verificationMode!==VRF_MODE)return {};
 const address=await ch.market.read.admission();
 const read=functionName=>ch.pub.readContract({address,abi:VrfAdmissionAbi,functionName});
 const [market,wait,activation,ttl,max,fee]=await Promise.all([read('MARKET'),read('WAIT_BLOCKS'),read('ACTIVATION_BLOCKS'),read('READY_TTL'),read('MAX_CANDIDATES'),ch.market.read.admissionFee(['0x'+'00'.repeat(20)])]);
 if(market.toLowerCase()!==ch.market.address.toLowerCase())throw Error('VRF controller market mismatch');
 return {admissionVersion:2,admission:address,randomnessWaitBlocks:String(wait),activationBlocks:String(activation),readyTtlBlocks:String(ttl),maxCandidates:Number(max),nativeAdmissionFeeWei:String(fee),admissionFeeRefundable:false};
}
// Observe finalized randomness before spending gas. Recheck at head under the wallet's
// normal nonce queue; another caller may have advanced the same request meanwhile.
export async function advanceAdmission(ch,id,send){
 const confirmed=await readFinalized(ch.pub,async options=>({phase:Number((await ch.market.read.sessionState([id],options))[0]),info:await readAdmission(ch,id,options)}));
 if(confirmed.phase!==6)return null;
 const permitted=admissionAction(confirmed.info,await ch.pub.getBlockNumber({cacheTime:0}));if(!permitted)return null;
 return send(async()=>{
  const state=await ch.market.read.sessionState([id]);if(Number(state[0])!==6)return null;
  const info=await readAdmission(ch,id),head=await ch.pub.getBlockNumber({cacheTime:0}),action=admissionAction(info,head);
  if(!action||action!==permitted)return null;
  await ch.market.simulate[action]([id],{account:ch.account});
  const gas=await ch.market.estimateGas[action]([id],{account:ch.account});
  if(gas>16777216n)throw Error('VRF progression exceeds transaction gas bound');
  return ch.market.write[action]([id]);
 });
}
