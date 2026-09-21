import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fliesPageReader } from '../relayer/flies-page.mjs';
const collection='0x'+'1'.repeat(40), sale='0x'+'2'.repeat(40), treasury='0x'+'3'.repeat(40), owner='0x'+'4'.repeat(40);
function fixture() {
  let block=1n, reads=0, bought=false;
  const ch={chain:{id:31337},pub:{getBlockNumber:async()=>block,readContract:async({functionName:f,args=[]})=>{
    reads++;
    return f==='totalSupply'?200n:f==='collection'?collection:f==='treasury'?treasury:f==='ownerOf'?(bought&&args[0]===1n?owner:treasury):f==='individuals'?[0,0,0,0,args[0]<=100n?0:1]:f==='available'?!(bought&&args[0]===1n):undefined;
  }}};
  return {get:fliesPageReader(ch,{collection,inventorySale:sale}),buy(){bought=true;block=2n;},reads:()=>reads};
}
test('bounded pages, sex filtering, shared cache and receipt refresh',async()=>{
  const f=fixture(); const first=await f.get(new URLSearchParams());
  assert.equal(first.total,200);assert.deepEqual(first.ids,Array.from({length:12},(_,i)=>i+1));
  const n=f.reads(); const male=await f.get(new URLSearchParams('sex=male&page=2'));
  assert.equal(male.total,100);assert.equal(male.ids[0],113);assert.equal(f.reads(),n);
  assert.equal((await f.get(new URLSearchParams('page=999'))).page,17);
  f.buy();const mine=await f.get(new URLSearchParams(`view=mine&owner=${owner}&minBlock=2`));assert.deepEqual(mine.ids,[1]);
  assert.equal((await f.get(new URLSearchParams())).total,199);
});
test('reject invalid filters and missing owner before chain reads',async()=>{
 const f=fixture();for(const query of ['view=bad','view=mine','page=-1','sex=bad','minBlock=999']) await assert.rejects(f.get(new URLSearchParams(query)));
});
test('invalid future block does not poison concurrent ordinary readers',async()=>{
 const f=fixture();const [invalid,normal]=await Promise.allSettled([f.get(new URLSearchParams('minBlock=999')),f.get(new URLSearchParams())]);
 assert.equal(invalid.status,'rejected');assert.equal(normal.status,'fulfilled');assert.equal(normal.value.total,200);
});
test('a receipt joining an older scan starts a fresh snapshot',async()=>{
 let block=1n, release, started;
 const entered=new Promise(r=>{started=r;}); const barrier=new Promise(r=>{release=r;});
 const ch={chain:{id:31337},pub:{getBlockNumber:async()=>block,readContract:async({functionName})=>{
  if(functionName==='totalSupply'){if(block===1n){started();await barrier;}return 0n;}
 }}};
 const get=fliesPageReader(ch,{collection});
 const old=get(new URLSearchParams());await entered;block=2n;
 const fresh=get(new URLSearchParams('minBlock=2'));release();
 assert.equal((await old).block,1);assert.equal((await fresh).block,2);
});
test('missing sale still allows My flies; incomplete indices fail explicitly',async()=>{
 const pub={getBlockNumber:async()=>1n,readContract:async({functionName})=>functionName==='totalSupply'?1n:functionName==='ownerOf'?owner:[0,0,0,0,0]};
 const get=fliesPageReader({chain:{id:31337},pub},{collection});
 assert.match((await get(new URLSearchParams())).unavailable,/not configured/);
 assert.deepEqual((await get(new URLSearchParams(`view=mine&owner=${owner}`))).ids,[1]);
 const oversized=fliesPageReader({pub:{...pub,readContract:async()=>2001n}},{collection});
 await assert.rejects(oversized(new URLSearchParams()),/indexer upgrade/);
});
test('failed scans are not cached',async()=>{
 let fail=true;
 const get=fliesPageReader({pub:{getBlockNumber:async()=>1n,readContract:async()=>{if(fail)throw Error('RPC unavailable');return 0n;}}},{collection});
 await assert.rejects(get(new URLSearchParams()),/RPC unavailable/);fail=false;
 assert.equal((await get(new URLSearchParams())).total,0);
});
