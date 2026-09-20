// Chain state is authoritative. A process restart repeats observations, never invents a second active payment.
import fs from 'node:fs';
import path from 'node:path';
export const stringify = x => JSON.stringify(x, (_,v)=>typeof v==='bigint'?v.toString():v,2);
export function atomic(file, value) {
  fs.mkdirSync(path.dirname(file),{recursive:true});
  const tmp=file+'.tmp'; const fd=fs.openSync(tmp,'w',0o600);
  try { fs.writeFileSync(fd,stringify(value));fs.fsyncSync(fd); } finally {fs.closeSync(fd);}
  fs.renameSync(tmp,file);
}
export class BatteryQueue {
  constructor(adapter,dir){this.a=adapter;this.dir=dir;this.running=false;}
  save(id,state){atomic(path.join(this.dir,id+'.json'),{id,updatedAt:new Date().toISOString(),...state});}
  async tick(){
    if(this.running)return;this.running=true;
    try {for(const id of await this.a.jobs()) {
      try {
        const s=await this.a.observe(id);
        if(s.closed){this.save(id,{status:s.delivered?'delivered':'closed',...s});continue;}
        if(!s.hasTask && s.expired){this.save(id,{...s,status:'refund_available'});continue;}
        if(!s.modelReady){this.save(id,{...s,status:'waiting_model'});continue;}
        if(!s.hasTask || (s.final&&!s.accepted)){
          if(s.expired||s.exhausted){this.save(id,{...s,status:s.expired?'refund_available':'budget_exhausted'});continue;}
          await this.a.validate(id,s); // validate before spending; missing local data must not prevent settling an active task
          if(!await this.a.capacity(id,s)){this.save(id,{...s,status:'waiting_capacity'});continue;}
          this.save(id,{...s,status:'posting'});await this.a.post(id,s);
          this.save(id,{status:'posted'});continue; // re-read task identity from chain next pass
        }
        if(s.disputed){this.save(id,{...s,status:'in_dispute'});continue;}
        if(!s.settled){this.save(id,{...s,status:'executing'});await this.a.execute(id,s);await this.a.settle(id,s);continue;}
        if(!s.final){this.save(id,{...s,status:'awaiting_finality'});continue;}
        this.save(id,{...s,status:'verifying_outputs'});
        await this.a.validate(id,s);
        const artifact=await this.a.archive(id,s); // durable file before recording on-chain delivery
        await this.a.deliver(id,s,artifact);
        this.save(id,{...s,status:'delivered',artifact});
      } catch(e){this.save(id,{status:e.code==='MODEL_DATA_MISSING'?'waiting_model_data':'needs_attention',error:e.message});}
    }}finally{this.running=false;}
  }
}
