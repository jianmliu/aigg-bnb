import test from 'node:test';import assert from 'node:assert/strict';
import fs from 'node:fs';
import {deriveBreedRecipe} from '../js/breed_recipe.mjs';
import {decodeDelta3} from '../contracts/lib/aigg-porw/web/porw-browser/delta.js';
const g=JSON.parse(fs.readFileSync(new URL('../flybnb/genesis/genesis-v2.json',import.meta.url)));
const mother=g.individuals[0],seed='0x'+'ab'.repeat(32);
test('cross-sex pairing uses maternal base and on-chain entropy, without incompatible parent projections',()=>{
 const b=deriveBreedRecipe({maternalRecipe:mother.recipe,baseModelId:mother.baseModelId,seed,tokenId:201});
 const d=decodeDelta3(b),p=decodeDelta3(Buffer.from(mother.recipe.slice(2),'hex'));
 assert.equal('0x'+Buffer.from(d.baseModelId).toString('hex'),mother.baseModelId);
 assert.equal(d.seed,BigInt(seed)&((1n<<64n)-1n));assert.equal(d.neurons,p.neurons);
 if(d.layout===1)assert.equal(Buffer.byteLength(d.name),Buffer.byteLength(p.name));
 assert(d.parentA.every(x=>x===0)&&d.parentB.every(x=>x===0));
 assert.deepEqual(d.rTable,p.rTable);assert.equal(d.meanRatioQ16,p.meanRatioQ16);
 assert.deepEqual(b,deriveBreedRecipe({maternalRecipe:mother.recipe,baseModelId:mother.baseModelId,seed,tokenId:201}));
 assert.throws(()=>deriveBreedRecipe({maternalRecipe:mother.recipe,baseModelId:g.baseMale,seed,tokenId:201}));
 assert.throws(()=>deriveBreedRecipe({maternalRecipe:mother.recipe,baseModelId:mother.baseModelId,seed:'0x'+'00'.repeat(32),tokenId:201}));
});
