import fs from 'node:fs';
// A lifetime spending authorization, separate from the prunable call history.
// Reserve durably before broadcast. Uncertain/failed submissions keep their reservation;
// retrying the same immutable task never consumes a second allowance.
export class AdmissionBudget {
 constructor(file,limit){
  this.file=file;this.limit=BigInt(limit);if(this.limit<=0n)throw Error('positive GATEWAY_VRF_ADMISSION_BUDGET_WEI required');
  this.entries=fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')):{};
  this.pending=new Set();
  this.used=Object.values(this.entries).reduce((n,v)=>{
   const net=typeof v==='string'?v:v?.net;
   if(!/^(0|[1-9][0-9]*)$/.test(net)||typeof v==='object'&&(!/^[1-9][0-9]*$/.test(v.gross)||BigInt(net)>BigInt(v.gross)))throw Error('invalid admission ledger');
   return n+BigInt(net);
  },0n);
  for(const [id,row] of Object.entries(this.entries))if(typeof row==='string')this.pending.add(id);
 }
 reserve(id,fee){
  fee=BigInt(fee);if(fee<=0n)throw Error('invalid admission fee');
  if(Object.hasOwn(this.entries,id)){const row=this.entries[id];if(BigInt(typeof row==='string'?row:row.gross)!==fee)throw Error('admission fee changed');return;}
  if(this.used+fee>this.limit)throw Error('VRF admission budget exhausted');
  const next={...this.entries,[id]:String(fee)},tmp=this.file+'.tmp';
  fs.writeFileSync(tmp,JSON.stringify(next),{mode:0o600});fs.renameSync(tmp,this.file);
  this.entries=next;this.pending.add(id);this.used+=fee;
 }
 reconcile(id,net){
  if(!Object.hasOwn(this.entries,id))throw Error('admission reservation missing');
  const row=this.entries[id],gross=BigInt(typeof row==='string'?row:row.gross);
  net=BigInt(net);if(net<0n||net>gross)throw Error('admission charge exceeds deposit');
  if(typeof row==='object'){
   if(BigInt(row.net)!==net)throw Error('admission charge changed');
   return;
  }
  const next={...this.entries,[id]:{gross:String(gross),net:String(net)}},tmp=this.file+'.tmp';
  fs.writeFileSync(tmp,JSON.stringify(next),{mode:0o600});fs.renameSync(tmp,this.file);
  this.entries=next;this.pending.delete(id);this.used-=gross-net;
 }
}
