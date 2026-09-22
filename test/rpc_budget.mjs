import {test} from 'node:test';import assert from 'node:assert/strict';
import {ReadCache,UnboundBackoff,ensureAggregator,mapBounded} from '../relayer/rpc-budget.mjs';
test('coalesces concurrent reads, expires, separates epoch and bounds memory',async()=>{
 let now=0,n=0;const c=new ReadCache({ttl:5,max:2,now:()=>now});const read=async()=>++n;
 assert.deepEqual(await Promise.all([c.get('e1',read),c.get('e1',read)]),[1,1]);
 assert.equal(await c.get('e1',read),1);now=6;assert.equal(await c.get('e1',read),2);
 await c.get('e2',read);await c.get('e3',read);assert.equal(c.size,2);
});
test('failed reads are retried, never cached as successful values',async()=>{const c=new ReadCache();await assert.rejects(c.get('x',async()=>{throw Error('RPC');}));assert.equal(await c.get('x',async()=>7),7);});
test('only missing epoch aggregators read challenge; new MEP and epoch load immediately',async()=>{
 const m={aggregators:new Map()};let reads=0;const read=async()=>{reads++;return 'challenge';};const make=(e,c)=>m.aggregators.set(e,c);
 for(let i=0;i<100;i++)await ensureAggregator(m,1,read,make);
 assert.equal(reads,1);await ensureAggregator(m,2,read,make);assert.equal(reads,2);
 await ensureAggregator({aggregators:new Map()},2,read,()=>{});assert.equal(reads,3);
});
test('unbound scans back off, remain bounded and clear on registration',()=>{const b=new UnboundBackoff(20n);assert(b.due('a',0n));b.miss('a',0n);assert(!b.due('a',19n));assert(b.due('a',20n));b.miss('a',20n);assert(!b.due('a',59n));for(let i=0;i<10;i++)b.miss('a',100n);assert(b.due('a',260n));b.clear('a');assert(b.due('a',100n));});

test('large host reads have at most four in flight and preserve order',async()=>{let active=0,peak=0;const ids=Array.from({length:205},(_,i)=>i);const got=await mapBounded(ids,async i=>{peak=Math.max(peak,++active);await new Promise(r=>setTimeout(r,1));active--;return i*2;});assert.equal(peak,4);assert.deepEqual(got,ids.map(i=>i*2));});
