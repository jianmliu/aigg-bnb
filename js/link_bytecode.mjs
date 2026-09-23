import {isAddress} from 'viem';

export function linkLibraries(artifact, addresses={}) {
 let code=artifact.bytecode.object;
 for(const libraries of Object.values(artifact.bytecode.linkReferences||{}))for(const [name,refs] of Object.entries(libraries)){
  const address=addresses[name];
  if(!isAddress(address||'',{strict:false}))throw Error('missing or invalid library '+name);
  for(const {start,length} of refs){
   if(length!==20)throw Error('unsupported library reference width');
   const offset=2+start*2;
   code=code.slice(0,offset)+address.slice(2).toLowerCase()+code.slice(offset+length*2);
  }
 }
 if(!/^0x(?:[0-9a-fA-F]{2})*$/.test(code))throw Error('unresolved library bytecode');
 return code;
}
