import fs from 'node:fs';
// A lifetime spending authorization, separate from the prunable call history.
// Reserve durably before broadcast. Uncertain/failed submissions keep their reservation;
// retrying the same immutable task never consumes a second allowance.
export class AdmissionBudget {
 constructor(file,limit){
  this.file=file;this.limit=BigInt(limit);if(this.limit<=0n)throw Error('positive GATEWAY_VRF_ADMISSION_BUDGET_WEI required');
  this.entries=fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')):{};
  this.used=Object.values(this.entries).reduce((n,v)=>{if(!/^[1-9][0-9]*$/.test(v))throw Error('invalid admission ledger');return n+BigInt(v);},0n);
 }
 reserve(id,fee){
  fee=BigInt(fee);if(fee<=0n)throw Error('invalid admission fee');
  if(Object.hasOwn(this.entries,id)){if(BigInt(this.entries[id])!==fee)throw Error('admission fee changed');return;}
  if(this.used+fee>this.limit)throw Error('VRF admission budget exhausted');
  const next={...this.entries,[id]:String(fee)},tmp=this.file+'.tmp';
  fs.writeFileSync(tmp,JSON.stringify(next),{mode:0o600});fs.renameSync(tmp,this.file);
  this.entries=next;this.used+=fee;
 }
}
