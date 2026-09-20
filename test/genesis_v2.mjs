import test from 'node:test';
import assert from 'node:assert/strict';
import {keccak256} from 'viem';
import {build} from '../flybnb/genesis/build_genesis_v2.mjs';
import {build as female,leafOf,verify} from '../flybnb/genesis/build_genesis.mjs';
test('mixed genesis preserves measured female founders and verifies every male recipe and opening',()=>{
 const g=build();assert.equal(g.size,200);assert.deepEqual(g.sexes,{female:100,male:100});
 assert.deepEqual(g.individuals.slice(0,100).map(x=>x.deltaHash),female().individuals.map(x=>x.deltaHash));
 assert.equal(new Set(g.individuals.map(x=>x.deltaHash)).size,200);
 for(const x of g.individuals){assert.equal(keccak256(x.recipe),x.deltaHash);assert(verify(x.proof,g.root,leafOf(x.index,x.sex,x.deltaHash)));assert.equal(x.baseModelId,x.sex?g.baseMale:g.baseModelId);}
 assert.notEqual(g.baseModelId,g.baseMale);
});
