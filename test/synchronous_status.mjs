import test from 'node:test';import assert from 'node:assert/strict';
import {sessionStatus} from '../frontend/src/core/synchronous_status.js';
const zero='0x'+'00'.repeat(32);
const closed={phase:'completed',confirmedBlock:100,safeToClose:true,ready:false,pendingTask:zero};
test('safe close needs a confirmed drained terminal snapshot',()=>{assert.equal(sessionStatus(closed).safe,true);for(const change of [{ready:true},{pendingTask:'0x'+'12'.repeat(32)},{confirmedBlock:0},{error:'RPC unavailable'},{phase:'verifying'},{safeToClose:false},{draining:true}])assert.equal(sessionStatus({...closed,...change}).safe,false,JSON.stringify(change));});
test('missing state never invites closing while reconciling',()=>{assert.equal(sessionStatus(null).safe,false);assert.match(sessionStatus(null).label,/Checking/);});
test('inconclusive stays distinct from successful scientific output',()=>{const s=sessionStatus({...closed,phase:'inconclusive'});assert(s.safe);assert.match(s.label,/Inconclusive/);assert.match(s.detail,/not accepted/);});
test('all online verification phases remain unfinished',()=>{for(const phase of ['reconciling','computing','committed','waiting for peer','verifying','awaiting finalization'])assert.equal(sessionStatus({...closed,phase}).safe,false);});
