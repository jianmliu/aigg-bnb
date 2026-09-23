import test from 'node:test';
import assert from 'node:assert/strict';
import {linkLibraries} from '../js/link_bytecode.mjs';

test('external fee library is linked at every compiler reference',()=>{
 const artifact={bytecode:{object:'0x6000'+('_'.repeat(40))+'6001'+('_'.repeat(40)),linkReferences:{'src/RoundFeeAccounting.sol':{RoundFeeAccounting:[{start:2,length:20},{start:24,length:20}]}}}};
 const address='0x'+'ab'.repeat(20),linked=linkLibraries(artifact,{RoundFeeAccounting:address});
 assert.equal(linked,'0x6000'+('ab'.repeat(20))+'6001'+('ab'.repeat(20)));
 assert.throws(()=>linkLibraries(artifact,{}),/missing.*RoundFeeAccounting/);
});
