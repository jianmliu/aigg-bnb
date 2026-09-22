// Cache only successful reads. Pending reads coalesce; failures are always retryable.
export class ReadCache {
 constructor({ttl=5000,max=256,now=Date.now}={}){Object.assign(this,{ttl,max,now});this.entries=new Map();this.hits=0;this.misses=0;}
 get size(){return this.entries.size;}
 async get(key,read){
  const old=this.entries.get(key);
  if(old&&(old.pending||old.until>this.now())){this.hits++;return old.promise;}
  this.misses++;const entry={pending:true,until:0};
  entry.promise=Promise.resolve().then(read).then(value=>{entry.pending=false;entry.until=this.now()+this.ttl;return value;},err=>{if(this.entries.get(key)===entry)this.entries.delete(key);throw err;});
  this.entries.delete(key);this.entries.set(key,entry);
  while(this.entries.size>this.max)this.entries.delete(this.entries.keys().next().value);
  return entry.promise;
 }
}
export class UnboundBackoff {
 constructor(interval){this.interval=interval;this.entries=new Map();}
 due(key,block){return !this.entries.has(key)||block>=this.entries.get(key).next;}
 miss(key,block){const factor=Math.min((this.entries.get(key)?.factor||0)*2||1,8);this.entries.set(key,{factor,next:block+this.interval*BigInt(factor)});}
 clear(key){this.entries.delete(key);}
}
export async function ensureAggregator(m,epoch,read,make){if(!m.aggregators.has(epoch))make(epoch,await read());}
export async function mapBounded(values,read,limit=4){
 const out=new Array(values.length);let next=0,failure;
 await Promise.all(Array.from({length:Math.min(limit,values.length)},async()=>{while(!failure&&next<values.length){const i=next++;try{out[i]=await read(values[i]);}catch(e){failure=e;}}}));
 if(failure)throw failure;return out;
}
