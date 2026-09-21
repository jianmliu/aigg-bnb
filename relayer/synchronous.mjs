// Synchronous sessions are an explicit deployment capability. Unknown versions never fall back.
export function verificationMode(dep) {
 const mode=dep.verification?.mode ?? 'legacy';
 if(!['legacy','synchronous-v1'].includes(mode))throw Error(`unsupported verification mode: ${mode}`);
 return mode;
}
export function sessionOutcome(state) {
 const phase=Number(state.phase);
 if(!Number.isInteger(phase)||phase<0||phase>5)throw Error('invalid synchronous phase');
 return {terminal:phase>=4,accepted:phase===4,status:['unassigned','committing','revealing','disputing','completed','inconclusive'][phase]};
}
export function sessionExpired(state,block) {
 const phase=Number(state.phase);
 return phase===1?block>BigInt(state.commitDeadline):phase===2?block>BigInt(state.revealDeadline):phase===3?block>BigInt(state.overallDeadline):false;
}
export async function waitForSession({read,block,finalize,sleep=()=>new Promise(r=>setTimeout(r,1000)),onState=()=>{}}) {
 let receipt=null;
 for(;;){const state=await read();const outcome=sessionOutcome(state);await onState(state,outcome);
  if(outcome.terminal)return {state,outcome,receipt};
  if(await sessionExpired(state,await block()))receipt=await finalize();
  await sleep();
 }
}

import {unsupportedGetter} from './enrollment.mjs';
import {parseAbi,recoverAddress,keccak256} from 'viem';
export const SynchronousMarketAbi=parseAbi([
 'struct Task { bytes32 mepId; uint32 stimulusSeed; uint32 steps; uint32 commitStride; bytes32 initStateRoot; uint256 fee; uint64 deadline; uint8 redundancy; }',
 'function taskId(Task t,address token,bytes32 nonce,uint32 runs,address client) view returns (bytes32)',
 'function TASK_TIMEOUT() view returns (uint64)',
 'function COMMIT_BLOCKS() view returns (uint64)',
 'function REVEAL_BLOCKS() view returns (uint64)',
 'function DISPUTE_BLOCKS() view returns (uint64)',
 'struct Result { bytes32 execDigest; bytes32 execRoot; }',
 'function protocolVersion() view returns (uint256)',
 'function profileMaxInDegree(bytes32) view returns (uint32)',
 'function sessionState(bytes32) view returns (uint8 state,uint64 commitDeadline,uint64 revealDeadline,uint64 totalDeadline)',
 'function setReadyBySig(address host,bool ready,uint64 expiry,uint256 nonce,bytes sig)',
 'function readinessDigest(address host,bool ready,uint64 expiry,uint256 nonce) view returns (bytes32)',
 'function commitResult(bytes32 id,address host,bytes32 commitment,bytes sig)',
 'function commitmentDigest(bytes32 id,address host,bytes32 commitment) view returns (bytes32)',
 'function revealResult(bytes32 id,address host,Result r,bytes32 salt,bytes sig)',
 'function resultDigest(bytes32 id,address host,bytes32 execDigest,bytes32 execRoot) view returns (bytes32)',
 'function resultCommitment(bytes32 id,address host,bytes32 execDigest,bytes32 execRoot,bytes32 salt) view returns (bytes32)',
 'function expire(bytes32 id)',
 'function ready(address) view returns (bool)',
 'function readinessNonce(address) view returns (uint256)',
 'function pendingTask(address) view returns (bytes32)',
 'function commitments(bytes32,address) view returns (bytes32)',
]);
export const SynchronousDisputeAbi=parseAbi([
 'function forwardMove(bytes32 id,address host,uint8 phase,uint256 round,uint256 nonce,uint64 expiry,bytes data,bytes sig)',
 'function moveDigest(bytes32 id,address host,uint8 phase,uint256 round,uint256 nonce,uint64 expiry,bytes32 dataHash) view returns (bytes32)',
 'struct Party { bytes32 execRoot; bytes32[] actRoots; bool revealed; bytes32 node; bytes32[2] pair; bool posted; bytes32 leaf; uint32 act; uint64[] sums; bool rowPosted; }',
 'struct State { int32 v; int32 g; uint16 refr; uint16 flags; uint32 count; }',
 'struct LifParty { bytes32[] stepRoots; bool refined; State state; int64[] sums; bool rowPosted; }',
 'function disputes(bytes32) view returns (bytes32 mepId,uint32 neurons,uint32 synapses,uint32 steps,uint32 stimulusSeed,bytes32 synapseRoot,uint8 phase,uint32 step,bytes32 prevRoot,uint32 level,uint32 idx,uint32 neuron,uint64 deadline,bool exists,address loser)',
 'function lifs(bytes32) view returns (bool lif,uint32 stride,uint32 segments,uint32 seg,bytes32 initStateRoot,uint32 wUnit)',
 'function batches(bytes32) view returns (uint32 runs,uint32 level,uint32 idx)',
 'function partyState(bytes32,address) view returns (Party)',
 'function lifPartyState(bytes32,address) view returns (LifParty)',
 'function roundNonce(bytes32 id) view returns (uint256)',
 'function moveNonce(bytes32 id,address host) view returns (uint256)',
]);
export async function verifyDeployment(dep,probe) {
 const mode=verificationMode(dep);let version;
 try{version=await probe();}catch(error){if(mode!=='legacy'||!unsupportedGetter(error))throw Error('synchronous capability unavailable',{cause:error});return false;}
 if(mode!=='synchronous-v1'||Number(version)!==1)throw Error('deployment verification capability does not match the market');
 return true;
}
export function normalizeSession(raw) {
 return {phase:Number(raw[0]),commitDeadline:String(raw[1]),revealDeadline:String(raw[2]),totalDeadline:String(raw[3]),overallDeadline:String(raw[3])};
}
const address=x=>typeof x==='string'&&/^0x[0-9a-fA-F]{40}$/.test(x);
const bytes32=x=>typeof x==='string'&&/^0x[0-9a-fA-F]{64}$/.test(x);
const uint=x=>{if(!/^(0|[1-9][0-9]*)$/.test(String(x)))throw Error('invalid unsigned integer');return BigInt(x);};
// Offchain recovery selects the budget identity. Contract simulation additionally checks exact
// assignment, delegated-key expiry, nonces, signatures and immutable phase deadlines.
export async function prepareSyncMutation(kind,b,ch) {
 if(!['readiness','commit','reveal','move'].includes(kind))throw Error('unsupported synchronous method');
 if(kind==='move'&&(typeof b.data!=='string'||!/^0x([0-9a-fA-F]{2})*$/.test(b.data)||b.data.length>2+262144*2))throw Error('invalid or oversized proof calldata');
 if(!address(b.instance)||typeof b.signature!=='string')throw Error('invalid signature or instance');
 if(kind!=='readiness'&&!bytes32(b.taskId))throw Error('invalid taskId');
 let contract=ch.market,functionName,args,hash;
 if(kind==='readiness'){
  if(typeof b.ready!=='boolean')throw Error('ready must be boolean');
  const signed=[b.instance,b.ready,uint(b.expiry),uint(b.nonce)];
  hash=await contract.read.readinessDigest(signed);functionName='setReadyBySig';args=[...signed,b.signature];
 }else if(kind==='commit'){
  if(!bytes32(b.commitment))throw Error('invalid commitment');
  const signed=[b.taskId,b.instance,b.commitment];hash=await contract.read.commitmentDigest(signed);functionName='commitResult';args=[...signed,b.signature];
 }else if(kind==='reveal'){
  if(![b.execDigest,b.execRoot,b.salt].every(bytes32))throw Error('invalid reveal');
  hash=await contract.read.resultDigest([b.taskId,b.instance,b.execDigest,b.execRoot]);
  functionName='revealResult';args=[b.taskId,b.instance,{execDigest:b.execDigest,execRoot:b.execRoot},b.salt,b.signature];
 }else{
  contract=ch.disputes;const signed=[b.taskId,b.instance,Number(uint(b.phase)),uint(b.round),uint(b.nonce),uint(b.expiry)];
  hash=await contract.read.moveDigest([...signed,keccak256(b.data)]);functionName='forwardMove';args=[...signed,b.data,b.signature];
 }
 const signer=await recoverAddress({hash,signature:b.signature});
 const instance=await ch.instances.read.resolve([signer]);
 if(instance.toLowerCase()!==b.instance.toLowerCase())throw Error('signature does not authorize instance');
 return {instance,contract,functionName,args,taskId:kind==='readiness'?null:b.taskId};
}

import {ReadCache} from './rpc-budget.mjs';
export async function readFinalized(pub,read){
 const block=await pub.getBlock({blockTag:'finalized'});
 if(block.number===null||block.number===undefined||!block.hash)throw Error('finalized snapshot unavailable');
 const value=await read({blockNumber:block.number},block);
 const check=await pub.getBlock({blockNumber:block.number});
 if(check.hash!==block.hash)throw Error('finalized snapshot changed during read');
 return value;
}
export function syncReader(ch,{ttl=2000,max=256}={}) {
 const cache=new ReadCache({ttl,max});
 return {
  session:async id=>{
   if(!bytes32(id))throw Error('invalid taskId');
   return cache.get('task:'+id.toLowerCase(),()=>readFinalized(ch.pub,async(options,block)=>{
    const state=normalizeSession(await ch.market.read.sessionState([id],options));
    const executors=await ch.market.read.executors([id],options);
    if(executors.length>2)throw Error('synchronous assignment exceeds bounded pair');
    const commitments=await Promise.all(executors.map(a=>ch.market.read.commitments([id,a],options)));
    const result={...state,...sessionOutcome(state),block:String(options.blockNumber),blockHash:block.hash,executors,commitments};
    if(state.phase>=2){result.results=await Promise.all(executors.map(async a=>await ch.market.read.submitted([id,a],options)?await ch.market.read.resultOf([id,a],options):null));}
    if(state.phase===3){const d=ch.disputes.read;result.dispute={state:await d.disputes([id],options),lif:await d.lifs([id],options),batch:await d.batches([id],options),round:String(await d.roundNonce([id],options)),parties:await Promise.all(executors.map(async a=>({instance:a,party:await d.partyState([id,a],options),lif:await d.lifPartyState([id,a],options),nonce:String(await d.moveNonce([id,a],options))})))};}
    return result;
   }));
  },
  pending:async instance=>{
   if(!address(instance))throw Error('invalid instance');
   return cache.get('host:'+instance.toLowerCase(),()=>readFinalized(ch.pub,async(options,block)=>({instance,block:String(options.blockNumber),blockHash:block.hash,taskId:await ch.market.read.pendingTask([instance],options),ready:await ch.market.read.ready([instance],options),nonce:String(await ch.market.read.readinessNonce([instance],options))})));
  },
 };
}

import {recoverMessageAddress} from 'viem';
export const finalizeMessage=(dep,b)=>`PoRW synchronous expiry\nchain:${dep.chainId}\nmarket:${dep.addresses.market.toLowerCase()}\ntask:${b.taskId.toLowerCase()}\ninstance:${b.instance.toLowerCase()}\nexpiry:${b.expiry}`;
export async function prepareSyncFinalize(dep,b,ch) {
 if(!bytes32(b.taskId)||!address(b.instance))throw Error('invalid task or instance');
 const expiry=uint(b.expiry),head=await ch.pub.getBlockNumber({cacheTime:0});
 if(head>expiry||expiry>head+256n)throw Error('expired or excessive authorization lifetime');
 const signer=await recoverMessageAddress({message:finalizeMessage(dep,b),signature:b.signature});
 const instance=await ch.instances.read.resolve([signer]);
 if(instance.toLowerCase()!==b.instance.toLowerCase())throw Error('signature does not authorize instance');
 return {instance,contract:ch.market,functionName:'expire',args:[b.taskId],taskId:b.taskId};
}

export async function acceptedSession(market,id,options={}) {
 const state=normalizeSession(await market.read.sessionState([id],options));
 if(!sessionOutcome(state).accepted)throw Error('session is not completed');
 const ref=await market.read.settledRef([id],options),execDigest=await market.read.settledDigest([id],options);
 const [digest,execRoot]=await market.read.resultOf([id,ref],options);
 if(BigInt(execDigest)===0n||digest.toLowerCase()!==execDigest.toLowerCase())throw Error('completed session has no bound accepted digest');
 const assigned=await market.read.executors([id],options),executors=[];
 for(const instance of assigned){const result=await market.read.resultOf([id,instance],options);if(result[0].toLowerCase()===execDigest.toLowerCase()&&result[1].toLowerCase()===execRoot.toLowerCase())executors.push(instance);}
 return {execDigest,execRoot,executors};
}

// Exact-profile certification changes independently of residency. Coalesce readers and
// refresh at most once a minute per served identity, never once per browser poll.
export function verificationSupportReader(ch,options={}) {
 const cache=new ReadCache({ttl:60000,max:1024,...options});
 return async mepId=>{
  if(!bytes32(mepId))throw Error('invalid MEP identity');
  return cache.get(mepId.toLowerCase(),async()=>{const maxInDegree=Number(await ch.market.read.profileMaxInDegree([mepId]));return {supported:maxInDegree>0&&maxInDegree<=16384,maxInDegree};});
 };
}

export function assignmentReady(state,head,finalized,postedAt) {
 if(Number(state.phase)!==1 || BigInt(head)>BigInt(state.commitDeadline))return 'closed';
 return BigInt(finalized)>=BigInt(postedAt)?'ready':'wait';
}

export function sponsorAdmission(gas,epochRemaining,dayRemaining) {
 const g=BigInt(gas);
 if(g>16777216n)return {ok:false,why:'transaction exceeds bounded gas limit'};
 if(g>BigInt(epochRemaining))return {ok:false,why:'predicted gas exceeds remaining epoch sponsorship budget'};
 if(g>BigInt(dayRemaining))return {ok:false,why:'predicted gas exceeds remaining daily sponsorship budget'};
 return {ok:true};
}
export function syncSponsorReady(epoch,day,balance,gasPrice) {
 return Number.isSafeInteger(epoch)&&Number.isSafeInteger(day)&&epoch>=160000000&&day>=350000000&&BigInt(balance)>=350000000n*BigInt(gasPrice);
}
