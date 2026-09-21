import test from 'node:test';import assert from 'node:assert/strict';
import {maxInDegree} from '../js/witness_profile.mjs';
test('certificate measures exact CSR offsets including empty and maximum rows',()=>{assert.equal(maxInDegree(new Uint32Array([0,0,8861,9000]),9000),8861);assert.equal(maxInDegree(new Uint32Array([0,0]),0),0);});
test('certificate rejects malformed bounds and witnesses exceeding protocol limit',()=>{for(const [rows,n] of [[[1,2],2],[[0,3,2],2],[[0,2],3],[[0,16385],16385]])assert.throws(()=>maxInDegree(Uint32Array.from(rows),n));});
