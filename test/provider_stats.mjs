import test from 'node:test'; import assert from 'node:assert/strict';
import { hostStats } from '../relayer/providers.mjs';
const A = '0x' + '11'.repeat(20), B = '0x' + '22'.repeat(20);
test('host totals count paid executors only and mirror royalty/rounding math', async () => {
  const ranges = [];
  const ch = { pub: {
    getBlockNumber: async () => 6000n,
    getLogs: async (p) => { if(p.event.name==='TaskAsset')return [];ranges.push([p.fromBlock, p.toBlock]); return p.fromBlock === 1001n ? [
      { args: { taskId: 'paid', executors: [A, B] } }, { args: { taskId: 'refund', executors: [] } },
    ] : []; },
    readContract: async ({ args }) => { assert.equal(args[0], 'paid'); return [{ mepId: 'brain', fee: 101n },A,1n,1000n]; },
  }, meps: { read: { termsOf: async () => [B, 1500] } } };
  const get = hostStats(ch, A);
  assert.deepEqual(await get(A), { instance: A, fromBlock: 1001, toBlock: 6000, requestsServed: 1, earnedWei: '43' });
  assert.equal((await get(B)).earnedWei, '43'); assert.equal(ranges.length, 5, 'shared cache serves all addresses');
  assert.deepEqual(ranges.at(-1), [5001n, 6000n]);
});
test('scan errors cannot turn into zero earnings', async () => {
  const get = hostStats({ pub: { getBlockNumber: async () => 5n, getLogs: async () => { throw new Error('RPC unavailable'); } } }, A);
  await assert.rejects(get(A), /RPC unavailable/); await assert.rejects(get(B), /RPC unavailable/);
});

test('token payouts never inflate native BNB earnings',async()=>{
 const ch={pub:{getBlockNumber:async()=>5n,getLogs:async p=>p.event.name==='TaskAsset'?[{args:{token:B}}]:[{args:{taskId:'token-paid',executors:[A]}}],readContract:async()=>[{mepId:'brain',fee:100n},A,1n,1n]},meps:{read:{termsOf:async()=>[B,1000]}}};
 const result=await hostStats(ch,A)(A);assert.equal(result.earnedWei,'0');assert.equal(result.tokenEarnings[B],'90');assert.equal(result.requestsServed,1);
});

test('a 200-model catalog bounds concurrent RPC reads',async()=>{
 const {providerModels}=await import('../relayer/providers.mjs');
 let active=0,peak=0;
 const ch={claims:{read:{currentEpoch:async()=>7n,beacon:async()=>1n}},instances:{read:{eligibleVotes:async()=>{
  active++;peak=Math.max(peak,active);await new Promise(r=>setTimeout(r,1));active--;return [A,A,B];
 }}}};
 const models=new Map(Array.from({length:200},(_,i)=>[String(i),{info:{mepId:String(i)}}]));
 const rows=await providerModels(ch,models);
 assert(peak<=4,`RPC fan-out reached ${peak}`);assert.equal(rows.length,200);
 assert.equal(rows[199].mepId,'199');assert.equal(rows[0].providers,2);assert.equal(rows[0].votes,3);
});

test('catalog requests share a scan and cache, refresh membership, and retry failures',async()=>{
 const {providerModelReader}=await import('../relayer/providers.mjs');
 let calls=0,fail=false;
 const ch={claims:{read:{currentEpoch:async()=>7n,beacon:async()=>1n}},instances:{read:{eligibleVotes:async()=>{
  calls++;await new Promise(r=>setTimeout(r,2));if(fail)throw Error('RPC limited');return [A];
 }}}};
 const models=new Map([['a',{info:{mepId:'a'}}]]),get=providerModelReader(ch,models,{cacheMs:10000});
 const rows=await Promise.all([get(),get(),get()]);assert.equal(calls,1);assert.equal(rows[0].length,1);
 await get();assert.equal(calls,1);
 models.set('b',{info:{mepId:'b'}});assert.equal((await get()).length,2);assert.equal(calls,3);
 models.set('c',{info:{mepId:'c'}});fail=true;await assert.rejects(get(),/RPC limited/);
 fail=false;assert.equal((await get()).length,3,'failure must not cache missing providers or poison the next scan');
});
