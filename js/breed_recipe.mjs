// Pairing-as-entropy v1. This is NOT cross-connectome anatomical inheritance.
// FlyCollection's seed commits both parent delta hashes, token IDs and the seed block hash.
// Sample the maternal base with the maternal recipe's population parameters and low 64 seed bits.
import {decodeDelta3,encodeDelta3,fitName} from '../contracts/lib/aigg-porw/web/porw-browser/delta.js';
export function deriveBreedRecipe({maternalRecipe,baseModelId,seed,tokenId}){
 if(!/^0x[0-9a-fA-F]{64}$/.test(seed)||BigInt(seed)===0n)throw Error('Hatched chain seed required');
 if(!/^0x[0-9a-fA-F]{64}$/.test(baseModelId)||!Number.isSafeInteger(tokenId)||tokenId<1)throw Error('Invalid base/token');
 const bytes=typeof maternalRecipe==='string'?Buffer.from(maternalRecipe.replace(/^0x/,''),'hex'):maternalRecipe;
 const d=decodeDelta3(bytes);
 if('0x'+Buffer.from(d.baseModelId).toString('hex')!==baseModelId.toLowerCase())throw Error('Maternal base mismatch');
 return encodeDelta3({...d,parentA:new Uint8Array(32),parentB:new Uint8Array(32),seed:BigInt(seed)&((1n<<64n)-1n),name:d.layout===1?fitName(`fly-${tokenId}`,Buffer.byteLength(d.name)):`fly-${tokenId}`,baseDA:'',ops:[]});
}
