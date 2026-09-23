import {VrfAdmissionAbi,normalizeAdmission,normalizeRoundAdmission} from '../../../relayer/vrf-admission.mjs';
import {unsupportedGetter} from '../../../relayer/enrollment.mjs';
import {createPublicClient,http,parseAbi,encodeFunctionData,keccak256} from 'viem';
export const SynchronousMarketAbi=parseAbi([
 'struct Result { bytes32 execDigest; bytes32 execRoot; }',
 'function executors(bytes32) view returns (address[])',
 'function submitted(bytes32,address) view returns (bool)',
 'function protocolVersion() view returns (uint256)',
 'function admissionVersion() view returns (uint256)',
 'function admission() view returns (address)',
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
 'function pendingTasks(address) view returns (bytes32[])',
 'function hasPendingTask(bytes32,address) view returns (bool)',
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
 'function hasOpenedRun(bytes32 id,address host) view returns (bool)',
]);

// Finalized snapshots are read from the configured RPC, never the sponsored transport.
export function createSynchronousChain({deployment,instance,client}) {
 if(!['synchronous-v1','synchronous-vrf-v1','synchronous-vrf-rounds-v1'].includes(deployment.verification?.mode))throw Error('unsupported synchronous capability');
 const rounds=deployment.verification.mode==='synchronous-vrf-rounds-v1',vrf=rounds||deployment.verification.mode==='synchronous-vrf-v1';
 client ||= createPublicClient({transport:http(deployment.rpc,{retryCount:1,timeout:15000})});
 const market=deployment.addresses.market,disputes=deployment.addresses.disputes;
 const read=(functionName,args=[],blockNumber,address=market,abi=SynchronousMarketAbi)=>client.readContract({address,abi,functionName,args,...(blockNumber!==undefined?{blockNumber}:{})});
 const finalized=async()=>{
  if(await client.getChainId()!==Number(deployment.chainId))throw Error('synchronous RPC chain mismatch');
  const block=await client.getBlock({blockTag:'finalized'});
  if(block.number===null||!block.hash)throw Error('finalized chain snapshot unavailable');
  if(Number(await read('protocolVersion',[],block.number))!==1)throw Error('synchronous protocol version mismatch');
  let version=1;try{const v=await read('admissionVersion',[],block.number);if(v!==undefined)version=Number(v);}catch(error){if(!unsupportedGetter(error))throw error;}
  if(version!==(rounds?3:vrf?2:1))throw Error('synchronous admission version mismatch');
  return block;
 };
 const roundPending=async()=>{
  const block=await finalized(),b=block.number;
  const [taskIds,ready,nonce,controller]=await Promise.all([read('pendingTasks',[instance],b),read('ready',[instance],b),read('readinessNonce',[instance],b),read('admission',[],b)]);
  if(taskIds.length>64)throw Error('round pending task bound exceeded');
  const tasks=await Promise.all(taskIds.map(async taskId=>{
   const [session,info,roundId]=await Promise.all([read('sessionState',[taskId],b),read('requestInfo',[taskId],b,controller,VrfAdmissionAbi),read('taskRound',[taskId],b,controller,VrfAdmissionAbi)]);
   const raw=await read('roundInfo',[roundId],b,controller,VrfAdmissionAbi);
   return {taskId,phase:Number(session[0]),commitDeadline:session[1],revealDeadline:session[2],totalDeadline:session[3],admission:normalizeRoundAdmission(normalizeAdmission(info),roundId,raw)};
  }));
  const check=await client.getBlock({blockNumber:b});if(check.hash!==block.hash)throw Error('chain reorganized during pending reconciliation');
  return {taskId:taskIds[0],taskIds,tasks,ready,nonce,blockNumber:b,confirmed:true};
 };
 const pending=async()=>{const block=await finalized();const [taskId,ready,nonce]=await Promise.all([read('pendingTask',[instance],block.number),read('ready',[instance],block.number),read('readinessNonce',[instance],block.number)]);let phase,admission;
  if(vrf&&!/^0x0{64}$/.test(taskId)){
   phase=Number((await read('sessionState',[taskId],block.number))[0]);
   const controller=await read('admission',[],block.number);
   admission=normalizeAdmission(await read('requestInfo',[taskId],block.number,controller,VrfAdmissionAbi));
  }
  const check=await client.getBlock({blockNumber:block.number});if(check.hash!==block.hash)throw Error('chain reorganized during pending reconciliation');
  return {taskId,ready,nonce,phase,admission,blockNumber:block.number,confirmed:true};};
 const snapshot=async record=>{
  const block=await finalized(),b=block.number,id=record.taskId;
  const [session,pendingTask,ready,commitment,revealed,executors,readinessNonce]=await Promise.all([read('sessionState',[id],b),rounds?read('hasPendingTask',[id,instance],b).then(found=>found?id:'0x'+'00'.repeat(32)):read('pendingTask',[instance],b),read('ready',[instance],b),read('commitments',[id,instance],b),read('submitted',[id,instance],b),read('executors',[id],b),read('readinessNonce',[instance],b)]);
  if(executors.length!==2||!executors.some(x=>x.toLowerCase()===instance.toLowerCase()))throw Error('synchronous assignment mismatch');
  const state={confirmed:true,blockNumber:b,chainId:deployment.chainId,market,instance,taskId:id,state:Number(session[0]),commitDeadline:session[1],revealDeadline:session[2],totalDeadline:session[3],pendingTask,ready,readinessNonce,committed:!/^0x0{64}$/.test(commitment),revealed};
  if(state.state===3){
   const dr=(fn,args=[id])=>read(fn,args,b,disputes,SynchronousDisputeAbi),other=executors.find(x=>x.toLowerCase()!==instance.toLowerCase());
   const [d,l,batch,party,lifParty,otherLifParty,round,nonce,runOpened]=await Promise.all([dr('disputes'),dr('lifs'),dr('batches'),dr('partyState',[id,instance]),dr('lifPartyState',[id,instance]),dr('lifPartyState',[id,other]),dr('roundNonce'),dr('moveNonce',[id,instance]),dr('hasOpenedRun',[id,instance])]);
   state.dispute={phase:Number(d[6]),neurons:Number(d[1]),step:Number(d[7]),level:Number(d[9]),idx:Number(d[10]),neuron:Number(d[11]),deadline:d[12],lif:{seg:Number(l[3])},batch:{runs:Number(batch[0]),level:Number(batch[1]),idx:Number(batch[2])},party,lifParty,otherLifParty,round,nonce,runOpened};
  }
  const check=await client.getBlock({blockNumber:b});if(check.hash!==block.hash)throw Error('chain reorganized during synchronous reconciliation');
  return state;
 };
 return {client,read,pending:rounds?roundPending:pending,snapshot,hashes:{
  result:r=>read('resultDigest',[r.taskId,instance,r.result.execDigest,r.result.execRoot]),
  commitment:r=>read('resultCommitment',[r.taskId,instance,r.result.execDigest,r.result.execRoot,r.salt]),
  commit:r=>read('commitmentDigest',[r.taskId,instance,r.commitment]),
 },moveHash:b=>read('moveDigest',[b.taskId,instance,b.phase,BigInt(b.round),BigInt(b.nonce),BigInt(b.expiry),keccak256(b.data)],undefined,disputes,SynchronousDisputeAbi)};
}
export const SynchronousProofAbi=parseAbi([
 'function revealRoots(bytes32 taskId,bytes32[] roots)',
 'function postStepRoots(bytes32 taskId,bytes32[] roots)',
 'function postChildren(bytes32 taskId,bytes32 left,bytes32 right)',
 'function openRun(bytes32 taskId,bytes32 root,uint32 seed,bytes32 initStateRoot,bytes32[] proof)',
 'function postRowLifChunk(bytes32 taskId,uint32 offset,uint32 total,int32 v,int32 g,uint16 refr,uint16 flags,uint32 count,int64[] sums)',
 'function postRowLif(bytes32 taskId,int32 v,int32 g,uint16 refr,uint16 flags,uint32 count,int64[] sums)',
 'function proveSynapseTermLif(bytes32 taskId,(uint32,bytes32,bytes32,(uint32,bytes32[],uint32,bytes32[]),(uint32,bytes,bytes32[]),(int32,int32,uint16,uint16,uint32,bytes32[]),(int32,int32,uint16,uint16,uint32,bytes32[])) proof)',
]);
export const encodeSynchronousProof=move=>encodeFunctionData({abi:SynchronousProofAbi,...move});
