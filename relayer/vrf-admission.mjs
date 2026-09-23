import {parseAbi} from 'viem';
import {readFinalized} from './synchronous.mjs';
export const VRF_MODE='synchronous-vrf-v1';
export const ROUND_VRF_MODE='synchronous-vrf-rounds-v1';
export const isVrfMode=mode=>mode===VRF_MODE||mode===ROUND_VRF_MODE;
export const VrfAdmissionAbi=parseAbi([
 'function ROUND_BLOCKS() view returns (uint64)',
 'function MAX_ROUND_TASKS() view returns (uint8)',
 'function taskRound(bytes32) view returns (uint256)',
 'function roundInfo(uint256) view returns (uint64 closeBlock,uint64 randomnessDeadline,uint256 requestId,uint64 fulfilledAt,uint64 allocationDeadline,uint8 state,uint16 taskCount)',
 'function MARKET() view returns (address)',
 'function WAIT_BLOCKS() view returns (uint64)',
 'function ACTIVATION_BLOCKS() view returns (uint64)',
 'function READY_TTL() view returns (uint64)',
 'function MAX_CANDIDATES() view returns (uint256)',
 'function readyUntil(address) view returns (uint64)',
 'function requestInfo(bytes32) view returns (uint256 requestId,uint64 randomnessDeadline,uint64 fulfilledAt,uint64 allocationDeadline,uint64 maxSessionEnd,uint8 state,uint8 candidateCount)',
 'function admissionCharge(bytes32,address) view returns (uint256)',
 'function admissionFee(address) view returns (uint256)',
]);
export function normalizeAdmission(raw){
 return {requestId:String(raw[0]),randomnessDeadline:String(raw[1]),fulfilledAt:String(raw[2]),allocationDeadline:String(raw[3]),maxSessionEnd:String(raw[4]),state:Number(raw[5]),candidateCount:Number(raw[6])};
}
export function normalizeRoundAdmission(info,roundId,raw){return {...info,roundId:String(roundId),closeBlock:String(raw[0]),roundTaskCount:Number(raw[6])};}
export function admissionAction(info,head){
 if(info.state===5)return BigInt(head)>BigInt(info.randomnessDeadline)?'expire':BigInt(head)>=BigInt(info.closeBlock)?'sealRound':null;
 if(info.state===1)return BigInt(head)>BigInt(info.randomnessDeadline)?'expire':null;
 if(info.state===2)return BigInt(head)>BigInt(info.allocationDeadline)?'expire':'allocate';
 return null;
}
export async function readAdmission(ch,id,options={}){
 const address=await ch.market.read.admission([],options);
 const read=(functionName,args)=>ch.pub.readContract({address,abi:VrfAdmissionAbi,functionName,args,...options});
 const info=normalizeAdmission(await read('requestInfo',[id]));
 if(ch.verificationMode!==ROUND_VRF_MODE)return info;
 const roundId=await read('taskRound',[id]);
 return normalizeRoundAdmission(info,roundId,await read('roundInfo',[roundId]));
}
export async function admissionCapability(ch){
 if(!isVrfMode(ch.verificationMode))return {};
 const address=await ch.market.read.admission();
 const read=functionName=>ch.pub.readContract({address,abi:VrfAdmissionAbi,functionName});
 const [market,wait,activation,ttl,max,fee]=await Promise.all([read('MARKET'),read('WAIT_BLOCKS'),read('ACTIVATION_BLOCKS'),read('READY_TTL'),read('MAX_CANDIDATES'),ch.verificationMode===ROUND_VRF_MODE?ch.pub.readContract({address,abi:VrfAdmissionAbi,functionName:'admissionFee',args:['0x'+'00'.repeat(20)]}):ch.market.read.admissionFee(['0x'+'00'.repeat(20)])]);
 if(market.toLowerCase()!==ch.market.address.toLowerCase())throw Error('VRF controller market mismatch');
 const rounds=ch.verificationMode===ROUND_VRF_MODE?{roundBlocks:String(await read('ROUND_BLOCKS')),maxRoundTasks:Number(await read('MAX_ROUND_TASKS'))}:{};
 return {...rounds,admissionVersion:ch.verificationMode===ROUND_VRF_MODE?3:2,admission:address,randomnessWaitBlocks:String(wait),activationBlocks:String(activation),readyTtlBlocks:String(ttl),maxCandidates:Number(max),nativeAdmissionFeeWei:String(fee),admissionFeeRefundable:ch.verificationMode===ROUND_VRF_MODE};
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
  const args=action==='sealRound'?[BigInt(info.roundId)]:[id];
  try {
   await ch.market.simulate[action](args,{account:ch.account});
   const gas=await ch.market.estimateGas[action](args,{account:ch.account});
   if(gas>16777216n)throw Error('VRF progression exceeds transaction gas bound');
   const hash=await ch.market.write[action](args);
   // Hold the wallet queue through inclusion: other tasks share this round action.
   const receipt=await ch.pub.waitForTransactionReceipt({hash});
   if(receipt.status!=='success')throw Error('VRF progression transaction reverted');
   return hash;
  } catch(error) {
   // A different permissionless keeper may have advanced it after our head read.
   // Suppress only a proven state transition; real RPC/funding failures still surface.
   const after=await ch.market.read.sessionState([id]);
   if(Number(after[0])!==6)return null;
   const next=await readAdmission(ch,id);
   if(next.state!==info.state||next.requestId!==info.requestId)return null;
   throw error;
  }
 });
}
