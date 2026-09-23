import {admissionAction} from '../../../relayer/vrf-admission.mjs';
import {hashMessage} from 'viem';
import {SynchronousSession,SynchronousJournal} from './synchronous-session.js';
import {createSynchronousChain,encodeSynchronousProof} from './synchronous-chain.js';
const nonzero=id=>id&&!/^0x0{64}$/.test(id);
const salt=()=> '0x'+Array.from(crypto.getRandomValues(new Uint8Array(32)),x=>x.toString(16).padStart(2,'0')).join('');
// The controller supplies the wallet-free session signer and worker RPC. This object owns
// all synchronization: relay envelopes can wake it, but never authorize an assignment.
export class SynchronousHost {
 constructor({deployment,instance,delegation,ask,sign,resolve,transport,onChange=()=>{},locks=globalThis.navigator?.locks,chain,journal}) {
  Object.assign(this,{deployment,instance,delegation,ask,sign,resolve,transport,onChange,locks});
  this.namespace=`${deployment.chainId}:${deployment.addresses.market}:${instance}`.toLowerCase();
  this.chain=chain||createSynchronousChain({deployment,instance});this.journal=journal||new SynchronousJournal(this.namespace);this.draining=false;this.admitting=false;
  this.session=new SynchronousSession({journal:this.journal,chain:this.chain,transport:{send:(k,p)=>this.send(k,p)},signer:{sign},hashes:this.chain.hashes,
   execute:async r=>(await ask('syncExecute',{taskId:r.taskId,manifest:r.manifest,expectedResult:r.result})).result,
   proof:(r,s)=>this.prove(r,s),randomSalt:salt,onChange:s=>{if(s.safeToClose)this.draining=false;onChange({...s,draining:this.draining});}});
 }
 async start(){
  if(!this.locks?.request)throw Error('exclusive browser session lock unavailable');
  if(!this.unlock)await new Promise((resolve,reject)=>{this.lockTask=this.locks.request('porw-sync:'+this.namespace,{ifAvailable:true},async lock=>{
   if(!lock){reject(Error('another tab owns this synchronous host'));return;}
   resolve();await new Promise(done=>{this.unlock=done;});
  }).catch(reject);});
  await this.session.restore();
  if(this.session.record?.idle){this.idleRecord=this.session.record;this.session.record=null;}
  if(this.session.record)await this.ask('syncPin',{taskId:this.session.record.taskId});
  this.initialized=true;await this.tick();
 }
 async send(kind,payload){
  if(kind==='reveal')payload={taskId:payload.taskId,instance:payload.instance,...payload.result,salt:payload.salt,signature:payload.resultSignature};
  if(kind==='finalize'||kind==='allocate'||kind==='sealRound'){
   const head=await this.chain.client.getBlockNumber({cacheTime:0});payload={...payload,instance:this.instance,expiry:String(head+128n)};
   const message=`PoRW synchronous ${kind==='allocate'?'allocation':kind==='sealRound'?'round sealing':'expiry'}\nchain:${this.deployment.chainId}\nmarket:${this.deployment.addresses.market.toLowerCase()}\ntask:${payload.taskId.toLowerCase()}\ninstance:${this.instance.toLowerCase()}\nexpiry:${payload.expiry}`;
   payload.signature=await this.sign(hashMessage(message));
  }
  return this.transport(kind,payload);
 }
 async assignment(env){
  if(this.admitting){if(this.admittingTask===env.payload.taskId)return;throw Error('another active assignment is being validated');}this.admitting=true;this.admittingTask=env.payload.taskId;
  try{
   if(this.session.record){if(this.session.record.taskId.toLowerCase()!==env.payload.taskId.toLowerCase())throw Error('another active synchronous task owns this tab');return this.tick();}
   const record={taskId:env.payload.taskId.toLowerCase(),instance:this.instance,chainId:this.deployment.chainId,market:this.deployment.addresses.market};
   const chain=await this.chain.snapshot(record);
   if(chain.state!==1||!nonzero(chain.pendingTask)||chain.pendingTask.toLowerCase()!==record.taskId)throw Error('task is not assigned for commitment');
   if(BigInt(this.delegation.expiry)<chain.totalDeadline)throw Error('delegation does not cover verification deadline');
   const manifest=await this.resolve(env);
   if(manifest.mep.exec!=='int-lif')throw Error('synchronous responder requires int-lif');
   // Capture full base bytes, exact recipe graph and normalized inputs before starting execution.
   const captured=await this.ask('syncManifest',{manifest});
   await this.ask('syncPin',{taskId:record.taskId});
   await this.session.begin({...record,commitDeadline:chain.commitDeadline,revealDeadline:chain.revealDeadline,totalDeadline:chain.totalDeadline,manifest:captured.manifest});
   await this.tick();
  } finally{this.admitting=false;this.admittingTask=null;}
 }
 async prove(record,snapshot){
  await this.ask('syncExecute',{taskId:record.taskId,manifest:record.manifest,expectedResult:record.result});
  const d=snapshot.dispute;if(!d)throw Error('confirmed dispute state unavailable');
  if(snapshot.blockNumber>d.deadline)return; // closure is inconclusive at expiry, never a proof of correctness
  const key=`${d.phase}:${d.round}:${d.nonce}`;
  let payload=record.moves[key];
  if(!payload){
   const {move}=await this.ask('syncProof',{taskId:record.taskId,state:d});if(!move)return;
   payload={taskId:record.taskId,instance:this.instance,phase:d.phase,round:String(d.round),nonce:String(d.nonce),expiry:String(d.deadline),data:encodeSynchronousProof(move)};
   payload.signature=await this.sign(await this.chain.moveHash(payload));record.moves[key]=payload;
  }
  await this.journal.save(record);await this.send('move',payload);
 }
 tick(){
  if(this.changingReadiness)return Promise.resolve();
  if(this.ticking)return this.ticking;
  const run=this._tick();this.ticking=run.finally(()=>{this.ticking=null;});return this.ticking;
 }
 async _tick(){
  this.onChange({...this.session.status,safeToClose:false,draining:this.draining});
  try{
   if(this.session.record){
    await this.session.tick();
    if(this.session.status.phase==='inconclusive')await this.ask('syncRefuse',{taskId:this.session.record.taskId,reason:'verification ended inconclusive'});
    if(this.session.snapshot?.revealed){const r=this.session.record;await this.ask('syncExecute',{taskId:r.taskId,manifest:r.manifest,expectedResult:r.result});await this.ask('syncPublish',{taskId:r.taskId,signature:r.resultSignature,confirmedReveal:true});}
   }
   else{
    const p=await this.chain.pending(),pendingAuthorization=(this.idleRecord?.readiness||[]).some(r=>BigInt(r.nonce)>=p.nonce);this.session.update(p.phase===6?'awaiting randomness':nonzero(p.taskId)?'waiting for task manifest':p.ready?'waiting for assignment':'idle',{
     ready:p.ready,pendingTask:p.taskId,taskId:nonzero(p.taskId)?p.taskId:undefined,admission:p.admission,totalDeadline:p.admission?.maxSessionEnd,confirmedBlock:p.blockNumber,safeToClose:!pendingAuthorization&&!p.ready&&!nonzero(p.taskId),error:null});
    if(p.phase===6&&p.admission){const action=admissionAction(p.admission,p.blockNumber);if(action)await this.send(action==='expire'?'finalize':'allocate',{taskId:p.taskId});}
   }
  }catch(error){this.session.update('reconciling',{error:error.message,safeToClose:false});throw error;}
 }
 async readiness(ready){
  if(this.changingReadiness||this.admitting)throw Error('session transition already in progress');
  this.changingReadiness=true;
  try{
  if(this.ticking)await this.ticking;
  if(ready&&this.session.record){
   await this._tick();
   if(!this.session.status.safeToClose||!['completed','inconclusive'].includes(this.session.status.phase))throw Error('active session must reach confirmed drained terminal state before re-arm');
   const old=this.session.record;await this.journal.archive(old);
   await this.ask('syncRelease',{taskId:old.taskId,confirmedTerminal:true});
   this.session.record=null;this.session.snapshot=null;this.idleRecord=null;
  }
  this.draining=!ready;this.session.update('reconciling',{safeToClose:false});
  const p=await this.chain.pending();if(ready&&nonzero(p.taskId))throw Error('pending assignment must finish before readiness');
  const head=this.chain.client?await this.chain.client.getBlockNumber({cacheTime:0}):p.blockNumber;
  const expiry=String(head+128n),nonce=String(p.nonce),payload={instance:this.instance,ready,expiry,nonce};
  payload.signature=await this.sign(await this.chain.read('readinessDigest',[this.instance,ready,BigInt(expiry),BigInt(nonce)]));
  // A readiness signature is replayable until its nonce is consumed. Keep it durable before delivery.
  const record=this.session.record||(this.idleRecord||={version:1,idle:true,readiness:[]});record.readiness||=[];record.readiness.push(payload);await this.journal.save(record);
  await this.send('readiness',payload);await this._tick();
  if(this.session.status.safeToClose)this.draining=false;
  }finally{this.changingReadiness=false;}
 }
}

// Round tasks retain independent evidence. The host journal owns readiness authority;
// archiving a task must never erase a still-replayable host signature.
export class RoundSynchronousHost extends SynchronousHost {
 constructor(options){
  super(options);this.sessions=new Map();this.children=new Map();
  this.journalFactory=options.journalFactory||(id=>new SynchronousJournal(this.namespace+':round-task:'+id));
  this.hostRecord={version:3,readiness:[],taskIds:[],draining:false};
  this.maxTasks=Math.min(64,Number(options.deployment.verification?.maxRoundTasks||64));
  this.operations=Promise.resolve();
 }
 serial(fn){const run=this.operations.then(fn);this.operations=run.catch(()=>{});return run;}
 async start(){
  if(!this.locks?.request)throw Error('exclusive browser session lock unavailable');
  if(!this.unlock)await new Promise((resolve,reject)=>{this.lockTask=this.locks.request('porw-sync:'+this.namespace,{ifAvailable:true},async lock=>{if(!lock){reject(Error('another tab owns this synchronous host'));return;}resolve();await new Promise(done=>{this.unlock=done;});}).catch(reject);});
  this.hostRecord=await this.journal.load()||this.hostRecord;this.draining=this.hostRecord.draining;
  if(this.hostRecord.taskIds.length>this.maxTasks)throw Error('round journal exceeds task capacity');
  for(const id of this.hostRecord.taskIds){const child=this.child(id);await child.session.restore();if(child.session.record)await this.ask('syncPin',{taskId:id});}
  this.initialized=true;await this.tick();
 }
 child(id){
  if(this.children.has(id))return this.children.get(id);
  const child=new SynchronousHost({deployment:this.deployment,instance:this.instance,delegation:this.delegation,ask:this.ask,sign:this.sign,resolve:this.resolve,transport:(k,p)=>this.transport(k,p),chain:this.chain,journal:this.journalFactory(id)});
  this.children.set(id,child);this.sessions.set(id,child.session);return child;
 }
 assignment(env){return this.serial(async()=>{
  if(!this.initialized)throw Error('exclusive host lock must be acquired before assignment');
  const id=env.payload.taskId.toLowerCase();if(this.sessions.get(id)?.record)return this._roundTick(true);
  if(!this.children.has(id)&&this.children.size>=this.maxTasks)throw Error('round task capacity reached');
  const record={taskId:id,instance:this.instance,chainId:this.deployment.chainId,market:this.deployment.addresses.market};
  const state=await this.chain.snapshot(record);
  if(state.state!==1||state.pendingTask?.toLowerCase()!==id)throw Error('task is not assigned for commitment');
  if(BigInt(this.delegation.expiry)<state.totalDeadline)throw Error('delegation does not cover verification deadline');
  const manifest=await this.resolve(env);if(manifest.mep.exec!=='int-lif')throw Error('synchronous responder requires int-lif');
  const captured=await this.ask('syncManifest',{manifest});
  if(!this.hostRecord.taskIds.includes(id)){this.hostRecord.taskIds.push(id);await this.journal.save(this.hostRecord);}
  const child=this.child(id);await this.ask('syncPin',{taskId:id});
  await child.session.begin({...record,commitDeadline:state.commitDeadline,revealDeadline:state.revealDeadline,totalDeadline:state.totalDeadline,manifest:captured.manifest});
  await this._roundTick(true);
 });}
 tick(){if(this.ticking)return this.ticking;this.ticking=this.serial(()=>this._roundTick()).finally(()=>{this.ticking=null;});return this.ticking;}
 async _roundTick(admittedAssignment=false){
  this.onChange({...this.session.status,safeToClose:false,draining:this.draining});
  const failures=[];
  for(const [id,child] of this.children){
   if(!child.session.record)continue;
   try{
    await child.session.tick();const s=child.session,r=s.record;
    if(s.status.phase==='inconclusive')await this.ask('syncRefuse',{taskId:id,reason:'verification ended inconclusive'});
    if(s.snapshot?.revealed){await this.ask('syncExecute',{taskId:id,manifest:r.manifest,expectedResult:r.result});await this.ask('syncPublish',{taskId:id,signature:r.resultSignature,confirmedReveal:true});}
    if([4,5].includes(s.snapshot?.state)&&!nonzero(s.snapshot.pendingTask)){
     // Remove the index first: interrupted archival leaves durable active evidence,
     // never an indexed task whose journal was already deleted.
     this.hostRecord.taskIds=this.hostRecord.taskIds.filter(t=>t!==id);await this.journal.save(this.hostRecord);
     await child.journal.archive(r);await this.ask('syncRelease',{taskId:id,confirmedTerminal:true});
     this.children.delete(id);this.sessions.delete(id);
    }
   }catch(error){failures.push(error);}
  }
  try{
   const p=await this.chain.pending(),ids=p.taskIds||[],tasks=p.tasks||[];
   if(ids.length>this.maxTasks)throw Error('round reservation capacity exceeded');
   // A crash can leave an index before the first manifest transaction. Once its
   // finalized reservation is gone, no task signature or worker evidence exists.
   for(const [id,child] of this.children)if(!child.session.record&&!ids.includes(id)){
    this.hostRecord.taskIds=this.hostRecord.taskIds.filter(t=>t!==id);await this.journal.save(this.hostRecord);
    this.children.delete(id);this.sessions.delete(id);
   }
   for(const task of tasks){
    try{
     let action;
     if(task.phase===6&&task.admission)action=admissionAction(task.admission,p.blockNumber);
     else if(!this.sessions.get(task.taskId)?.record&&task.phase>=1&&task.phase<=3){
      // Allocation can be confirmed before a manifest ever arrives or persists.
      // Recover expiry from chain deadlines without inventing execution evidence.
      const deadline=task.phase===1?task.commitDeadline:task.phase===2?task.revealDeadline:task.totalDeadline;
      if((deadline!==undefined&&p.blockNumber>BigInt(deadline))||(task.totalDeadline!==undefined&&p.blockNumber>BigInt(task.totalDeadline)))action='expire';
     }
     if(action)await this.send(action==='expire'?'finalize':action,{taskId:task.taskId});
    }catch(error){failures.push(error);}
   }
   const authorization=this.hostRecord.readiness.some(r=>BigInt(r.nonce)>=p.nonce);
   if(this.draining){
    let payload=[...this.hostRecord.readiness].reverse().find(r=>!r.ready&&BigInt(r.nonce)===p.nonce&&BigInt(r.expiry)>=p.blockNumber);
    if(!payload&&(p.ready||authorization)){
     const head=this.chain.client?await this.chain.client.getBlockNumber({cacheTime:0}):p.blockNumber;
     payload={instance:this.instance,ready:false,expiry:String(head+128n),nonce:String(p.nonce)};
     payload.signature=await this.sign(await this.chain.read('readinessDigest',[this.instance,false,BigInt(payload.expiry),p.nonce]));
     this.hostRecord.readiness.push(payload);await this.journal.save(this.hostRecord);
    }
    if(payload)try{await this.journal.save(this.hostRecord);await this.send('readiness',payload);}catch(error){failures.push(error);}
   }
   const safe=!failures.length&&!authorization&&!p.ready&&!ids.length&&!this.sessions.size;
   if(safe&&this.draining){this.draining=false;this.hostRecord.draining=false;await this.journal.save(this.hostRecord);}
   const first=tasks.find(t=>t.phase===6),phase=failures.length?'reconciling':this.sessions.size?'verifying':first?.admission?.state===5?'collecting round':first?'awaiting randomness':ids.length?'waiting for task manifest':p.ready?'waiting for assignment':'idle';
   this.session.update(phase,{safeToClose:safe,ready:p.ready,pendingTask:ids[0],pendingTasks:ids,taskCount:ids.length,taskId:ids[0],tasks:Array.from(this.sessions,([taskId,s])=>({taskId,...s.status})),confirmedBlock:p.blockNumber,draining:this.draining,error:failures[0]?.message||null,admission:first?.admission});
  }catch(error){this.session.update('reconciling',{safeToClose:false,error:error.message,draining:this.draining});throw error;}
  // An admitted request must not receive a refusal caused by another task.
  // Polls still report these errors, with every task retaining its own retry state.
  if(failures.length&&!admittedAssignment)throw failures[0];
 }
 readiness(ready){return this.serial(async()=>{
  if(!this.initialized)throw Error('exclusive host lock must be acquired before readiness');
  const p=await this.chain.pending();if(ready&&((p.taskIds||[]).length||this.sessions.size))throw Error('pending assignments must finish before readiness');
  this.draining=!ready;this.hostRecord.draining=!ready;await this.journal.save(this.hostRecord);
  this.session.update('reconciling',{safeToClose:false,draining:this.draining});
  const head=this.chain.client?await this.chain.client.getBlockNumber({cacheTime:0}):p.blockNumber;
  const payload={instance:this.instance,ready,expiry:String(head+128n),nonce:String(p.nonce)};
  payload.signature=await this.sign(await this.chain.read('readinessDigest',[this.instance,ready,BigInt(payload.expiry),p.nonce]));
  this.hostRecord.readiness.push(payload);await this.journal.save(this.hostRecord);
  await this.send('readiness',payload);await this._roundTick();
 });}
}
