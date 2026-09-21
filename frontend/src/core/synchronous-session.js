// A session follows confirmed chain state. Transport acknowledgements are never settlement.
// All dependencies are explicit so the same machine runs in the browser and in protocol tests.
const same = (a,b) => String(a).toLowerCase() === String(b).toLowerCase();
const pending = value => value && !/^0x0{64}$/.test(value);
export class SynchronousSession {
  constructor({journal,chain,transport,signer,hashes,execute,proof,randomSalt,onChange=()=>{}}) {
    Object.assign(this,{journal,chain,transport,signer,hashes,execute,proof,randomSalt,onChange});
    this.record=null;this.busy=false;this.status={phase:'reconciling',safeToClose:false};
  }
  update(phase,extra={}) { this.status={...this.status,phase,safeToClose:false,...extra};this.onChange(this.status); }
  async restore() { this.record=await this.journal.load();this.update('reconciling', {taskId:this.record?.taskId,totalDeadline:this.record?.totalDeadline});return this.record; }
  async begin(assignment) {
    if(this.record||this.busy)throw Error('an active session already owns this tab');
    this.busy=true;
    try {
      this.record=structuredClone({...assignment,version:1,moves:{}});this.update('computing',{taskId:assignment.taskId,commitDeadline:assignment.commitDeadline,revealDeadline:assignment.revealDeadline,totalDeadline:assignment.totalDeadline});
      // Persist the reconstruction manifest before any execution, and before any signature exists.
      await this.journal.save(this.record);
      await this.prepare();
    } finally {this.busy=false;}
  }
  async prepare() {
    const r=this.record;
    if(r.commitSignature){await this.journal.save(r);return;}
    if(!r.result){r.result=await this.execute(r);r.salt=this.randomSalt();await this.journal.save(r);}
    if(!r.resultSignature){r.resultSignature=await this.signer.sign(await this.hashes.result(r));await this.journal.save(r);}
    r.commitment=await this.hashes.commitment(r);
    r.commitSignature=await this.signer.sign(await this.hashes.commit(r));
    await this.journal.save(r);this.update('committed');
  }
  async tick() {
    if(this.busy)return;this.busy=true;
    // Revoke a previous safe-close assertion before each fresh read: read failures cannot preserve it.
    this.status.safeToClose=false;
    try {
      const r=this.record;if(!r)return;
      const s=await this.chain.snapshot(r);
      if(!s.confirmed)throw Error('session snapshot is not confirmed');
      for(const key of ['taskId','instance','market','chainId'])if(!same(s[key],r[key]))throw Error('session chain identity mismatch');
      this.snapshot=s;
      this.status={...this.status,ready:s.ready,pendingTask:s.pendingTask,commitDeadline:r.commitDeadline,revealDeadline:r.revealDeadline,totalDeadline:r.totalDeadline,confirmedBlock:s.blockNumber,error:null};
      if(s.state===4||s.state===5){
        r.terminal={state:s.state,blockNumber:s.blockNumber};await this.journal.save(r);
        this.update(s.state===4?'completed':'inconclusive',{ready:s.ready,pendingTask:s.pendingTask,safeToClose:!s.ready&&!pending(s.pendingTask)&&!(r.readiness||[]).some(a=>s.readinessNonce===undefined||BigInt(a.nonce)>=s.readinessNonce),confirmedBlock:s.blockNumber});return;
      }
      if(s.state<1||s.state>3)throw Error('assigned session is missing on the confirmed chain');
      // A reorg may remove terminal settlement: retain the evidence and resume the original session.
      if(s.blockNumber>r.totalDeadline || (s.state===1&&s.blockNumber>r.commitDeadline) || (s.state===2&&s.blockNumber>r.revealDeadline) || (s.state===3&&s.dispute&&s.blockNumber>s.dispute.deadline)) {
        this.update('awaiting finalization');await this.transport.send('finalize',{taskId:r.taskId});return;
      }
      await this.prepare();
      if(s.state===1){this.update(s.committed?'waiting for peer':'committed');if(!s.committed)await this.transport.send('commit',{taskId:r.taskId,instance:r.instance,commitment:r.commitment,signature:r.commitSignature});}
      if(s.state===2){this.update('waiting for peer');if(!s.revealed)await this.transport.send('reveal',{taskId:r.taskId,instance:r.instance,result:r.result,salt:r.salt,resultSignature:r.resultSignature});}
      if(s.state===3){this.update('verifying');if(!this.proof)throw Error('automatic proof responder unavailable');await this.proof(r,s);}
    } finally {this.busy=false;this.onChange(this.status);}
  }
}

// One active record per instance/chain/market. IDB transaction completion, not request
// success, is the durability boundary. Evidence is never automatically evicted.
export class SynchronousJournal {
  constructor(namespace,{indexedDB=globalThis.indexedDB}={}){this.indexedDB=indexedDB;this.name='porw-synchronous-v1:'+namespace;this.db=null;}
  async open(){
    if(!this.indexedDB)throw Error('persistent synchronous evidence storage unavailable');
    if(!this.db)this.db=new Promise((resolve,reject)=>{const req=this.indexedDB.open(this.name,1);req.onupgradeneeded=()=>req.result.createObjectStore('session');req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error);req.onblocked=()=>reject(Error('session evidence storage blocked'));});return this.db;
  }
  async load(){const db=await this.open();return new Promise((resolve,reject)=>{const tx=db.transaction('session','readonly'),req=tx.objectStore('session').get('active');let result;req.onsuccess=()=>{result=req.result;};tx.oncomplete=()=>resolve(result||null);tx.onabort=tx.onerror=()=>reject(tx.error||Error('session evidence read failed'));});}
  async archive(record){const db=await this.open();return new Promise((resolve,reject)=>{const tx=db.transaction('session','readwrite'),store=tx.objectStore('session');store.put(structuredClone(record),'task:'+record.taskId);store.delete('active');tx.oncomplete=()=>resolve();tx.onabort=tx.onerror=()=>reject(tx.error||Error('session evidence archive failed'));});}
  async save(record){const db=await this.open();return new Promise((resolve,reject)=>{const tx=db.transaction('session','readwrite');tx.objectStore('session').put(structuredClone(record),'active');tx.oncomplete=()=>resolve();tx.onabort=tx.onerror=()=>reject(tx.error||Error('session evidence write failed'));});}
}
