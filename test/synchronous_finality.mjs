import test from 'node:test';import assert from 'node:assert/strict';import {readFinalized} from '../relayer/synchronous.mjs';
test('consumer accepts only finalized snapshot, even when latest is many blocks ahead',async()=>{
 const calls=[],pub={getBlock:async opts=>{calls.push(opts);return {number:40n,hash:'0x123'};},getBlockNumber:()=>{throw Error('latest is not finality');}};
 const value=await readFinalized(pub,async options=>{assert.equal(options.blockNumber,40n);return 'accepted';});
 assert.equal(value,'accepted');assert.deepEqual(calls,[{blockTag:'finalized'},{blockNumber:40n}]);
});
test('orphaned or unavailable finalized snapshots never become accepted',async()=>{
 let n=0;await assert.rejects(readFinalized({getBlock:async()=>({number:40n,hash:++n===1?'a':'b'})},async()=>true),/changed/);
 await assert.rejects(readFinalized({getBlock:async()=>({number:null,hash:null})},async()=>true),/unavailable/);
});
