// BSC testnet only: node --env-file=.env.bsc-testnet js/launch_founder_inventory.mjs --broadcast
// A journal is mandatory. Pending/uncertain transactions are never replaced automatically.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
import {createPublicClient,createWalletClient,http,defineChain,encodeDeployData,encodeFunctionData,encodePacked,keccak256,parseEther,stringToHex,zeroAddress,decodeEventLog} from 'viem';
import {privateKeyToAccount} from 'viem/accounts';
const root=fileURLToPath(new URL('../',import.meta.url));
const artifact=name=>JSON.parse(fs.readFileSync(path.join(root,`contracts/out/${name}.sol/${name}.json`)));
const json=x=>JSON.stringify(x,(_,v)=>typeof v==='bigint'?v.toString():v,2)+'\n';
const same=(a,b)=>assert.equal(a.toLowerCase(),b.toLowerCase());
const g=JSON.parse(fs.readFileSync(path.join(root,'flybnb/genesis/genesis-v2.json')));
const profiles=JSON.parse(fs.readFileSync(path.join(root,'flybnb/genesis/founder-profiles-v2.json')));
const price=parseEther('0.01');
const mep=p=>({schemeDigest:p.schemeDigest,modelId:p.modelId,execKind:p.execKind,neurons:p.neurons,synapses:p.synapses,synapseRoot:p.synapseRoot,weightsDA:stringToHex(p.weightsDA)});
const terms=(p,collection,baseEnrollment)=>{
 const profileId=baseEnrollment?keccak256(encodePacked(['bytes32','bytes32','bytes32'],[keccak256(stringToHex('aigg:mep:base:v1')),p.mepId,profiles.bases.find(b=>b.sex===p.sex).mepId])):p.mepId;
 return keccak256(encodePacked(['bytes32','address','uint16'],[profileId,collection,1000]));
};

export async function launchInventory({c,cfg,journal,activate=true,smoke=true}) {
 assert([97,31337].includes(cfg.chainId)); assert.equal(await c.pub.getChainId(),cfg.chainId);
 same(c.account.address,cfg.owner);
 assert(cfg.protocol===undefined||cfg.protocol==='synchronous-v1','unknown protocol');
 const synchronous=cfg.protocol==='synchronous-v1';
 assert.equal(g.size,200); assert.equal(profiles.founders.length,200); same(g.root,profiles.genesisRoot);
 const read=(address,name,functionName,args=[])=>c.pub.readContract({address,abi:artifact(name).abi,functionName,args});
 if(synchronous){assert.equal(await read(cfg.market,'SynchronousTaskMarket','protocolVersion'),1n);for(const p of profiles.founders)assert(Number.isInteger(p.maxInDegree)&&p.maxInDegree>0&&p.maxInDegree<=16384,'missing measured Founder witness bound');}
 for(const key of ['treasury','whitelist','meps','instances','market'])assert((await c.pub.getCode({address:cfg[key]}))?.length>2,`missing ${key} code`);
 same(await read(cfg.treasury,'TreasuryRouter','owner'),cfg.owner);
 same(await read(cfg.whitelist,'CollectionWhitelist','curator'),cfg.owner);
 if(cfg.baseEnrollment){
  same(await read(cfg.instances,'InstanceRegistry','mepRegistry'),cfg.meps);
  for(const p of profiles.bases){
   assert(await read(cfg.meps,'MEPRegistry','exists',[p.mepId]),'base must be preregistered');
   same(await read(cfg.meps,'MEPRegistry','baseOf',[p.mepId]),'0x'+'00'.repeat(32));
   const registered=await read(cfg.meps,'MEPRegistry','getMEP',[p.mepId]);
   for(const k of ['schemeDigest','modelId','execKind','synapseRoot'])same(registered[k],p[k]);
   assert.equal(registered.neurons,p.neurons);assert.equal(registered.synapses,p.synapses);
  }
 }
 for(const p of profiles.bases)assert.equal(await read(cfg.meps,'MEPRegistry','lifWeightUnit',[p.execKind]),p.wUnitQ16);
 for(const [i,p] of profiles.founders.entries()) {
  assert.equal(p.index,i); same(p.deltaHash,g.individuals[i].deltaHash); assert.equal(p.sex,g.individuals[i].sex);
  same(keccak256(g.individuals[i].recipe),p.deltaHash);
  same(p.mepId,keccak256(encodePacked(['bytes32','bytes32','bytes32','uint32','uint32','bytes32'],[p.schemeDigest,p.modelId,p.execKind,p.neurons,p.synapses,p.synapseRoot])));
  assert.equal(p.weightsDA,`https://aigg-founder-assets.pages.dev/deltas/${p.deltaHash}.delta`);
 }
 const configHash=keccak256(stringToHex(json({cfg,genesisRoot:g.root,profilesHash:keccak256(stringToHex(json(profiles))),artifacts:["TreasuryFounderCollection","FounderInventoryVault","FlyRenderer"].map(n=>keccak256(artifact(n).bytecode.object))})));
 const state=fs.existsSync(journal)?JSON.parse(fs.readFileSync(journal)):{version:1,chainId:cfg.chainId,configHash,owner:cfg.owner,addresses:{},transactions:{}};
 assert.equal(state.configHash,configHash,'journal configuration mismatch');
 const save=()=>{fs.mkdirSync(path.dirname(journal),{recursive:true});fs.writeFileSync(journal+'.tmp',json(state),{mode:0o600});fs.renameSync(journal+'.tmp',journal);};
 save();
 if(Object.keys(state.transactions).length===0){
  const requiredGas=150_000_000n*(await c.pub.getGasPrice());
  assert(await c.pub.getBalance({address:cfg.owner})>requiredGas+price+parseEther('0.002'),'insufficient balance for complete launch');
 }
 async function tx(label,{to,data,value=0n}) {
  let row=state.transactions[label];
  if(!row){
   const nonce=await c.pub.getTransactionCount({address:cfg.owner,blockTag:'latest'});
   assert.equal(await c.pub.getTransactionCount({address:cfg.owner,blockTag:'pending'}),nonce,'pending account transaction: stop and coordinate');
   const gasPrice=await c.pub.getGasPrice();assert(gasPrice<=3_000_000_000n,'gas price exceeds launch ceiling');
   const gas=(await c.pub.estimateGas({account:c.account,to,data,value}))*120n/100n;
   assert(gas<15_000_000n,'transaction too large');
   assert(await c.pub.getBalance({address:cfg.owner})>gas*gasPrice+value+parseEther('0.002'),'insufficient gas reserve');
   const request=await c.wallet.prepareTransactionRequest({account:c.account,to,data,value,nonce,gas,gasPrice,type:'legacy'});
   const signed=await c.wallet.signTransaction(request),hash=keccak256(signed);
   row=state.transactions[label]={hash,nonce,status:'prepared',serializedTransaction:signed,gas:gas.toString(),gasPrice:gasPrice.toString()};
   // Save the expected hash BEFORE broadcast. If interrupted here, investigate the hash/nonce, never silently redeploy.
   save();
  }
  if(['prepared','submitted'].includes(row.status) && row.serializedTransaction){
   assert.equal(keccak256(row.serializedTransaction),row.hash,'corrupt signed transaction');
   try{await c.wallet.sendRawTransaction({serializedTransaction:row.serializedTransaction});}
   catch(error){try{await c.pub.getTransaction({hash:row.hash});}catch{throw error;}}
   row.status='submitted';save();
  }
  const receipt=await c.pub.waitForTransactionReceipt({hash:row.hash,confirmations:cfg.chainId===97?3:1,timeout:180_000});
  if(label!=='test-adoption')assert.equal(receipt.status,'success',`transaction ${label} reverted`);
  row.status=receipt.status;row.blockNumber=receipt.blockNumber.toString();row.gasUsed=receipt.gasUsed.toString();
  if(receipt.contractAddress)row.contractAddress=receipt.contractAddress;
  save(); console.log(`${label}: ${row.hash}`);return receipt;
 }
 const call=(label,to,name,functionName,args=[],value=0n)=>tx(label,{to,data:encodeFunctionData({abi:artifact(name).abi,functionName,args}),value});
 async function deploy(label,name,args){
  const a=artifact(name),r=await tx(label,{data:encodeDeployData({abi:a.abi,bytecode:a.bytecode.object,args})});
  state.addresses[label]=r.contractAddress;save();assert((await c.pub.getCode({address:r.contractAddress}))?.length>2);return r.contractAddress;
 }
 const bases=profiles.bases;
 const collection=await deploy('collection','TreasuryFounderCollection',[{
  baseFemale:g.baseModelId,baseMale:g.baseMale,genesisRoot:g.root,genesisSize:200,
  breedFee:parseEther('0.005'),hatchBounty:parseEther('0.0001'),treasury:cfg.treasury,
  meps:cfg.meps,instances:cfg.instances,lineage:zeroAddress,baseMepFemale:bases.find(p=>p.sex===0).mepId,baseMepMale:bases.find(p=>p.sex===1).mepId,
  market:cfg.market,royaltyBps:1000,shares:{baseVendor:cfg.treasury,baseShareBps:1000,saleRoyaltyBps:500,owner:cfg.owner}
 }]);
 assert.equal(await read(collection,'FlyCollection','BASE_ENROLMENT'),!!cfg.baseEnrollment);
 const renderer=await deploy('renderer','FlyRenderer',[]);
 const vault=await deploy('vault','FounderInventoryVault',[collection,cfg.treasury,cfg.owner]);
 const sale=await read(vault,'FounderInventoryVault','sale');state.addresses.sale=sale;save();
 await call('pause-sale',vault,'FounderInventoryVault','setSalePaused',[true]);
 await call('bind-vault',collection,'TreasuryFounderCollection','setInventoryVault',[vault]);
 await call('set-renderer',collection,'FlyCollection','setRenderer',[renderer]);
 same(await read(collection,'TreasuryFounderCollection','inventoryVault'),vault);
 same(await read(vault,'FounderInventoryVault','recipient'),cfg.treasury);
 same(await read(sale,'TreasuryInventorySale','collection'),collection);
 same(await read(sale,'TreasuryInventorySale','treasury'),vault);
 if(!state.expiresAt){state.expiresAt=((await c.pub.getBlock()).timestamp+365n*86400n).toString();save();}
 const expiresAt=BigInt(state.expiresAt);
 for(let i=0;i<200;i+=10){
  const entries=profiles.founders.slice(i,i+10).map(p=>({index:p.index,sex:p.sex,deltaHash:p.deltaHash,proof:g.individuals[p.index].proof,mep:mep(p)}));
  await call(`stock-${i}-${i+9}`,vault,'FounderInventoryVault','stock',[entries,price,expiresAt]);
 }
 if(state.transactions['activate-sale'])await call('activate-sale',vault,'FounderInventoryVault','setSalePaused',[false]);
 const alreadyOpen=state.transactions['activate-sale']?.status==='success';
 if(!alreadyOpen)assert.equal(await read(collection,'FlyCollection','totalSupply'),200n);
 state.founders=[];
 for(let i=0;i<200;i+=5){
  const rows=await Promise.all(profiles.founders.slice(i,i+5).map(async p=>{
   const id=BigInt(p.index+1),mid=terms(p,collection,cfg.baseEnrollment);
   const [owner,ind,q,available,registered]=await Promise.all([
    read(collection,'FlyCollection','ownerOf',[id]),read(collection,'FlyCollection','individuals',[id]),
    read(sale,'TreasuryInventorySale','listings',[id]),read(sale,'TreasuryInventorySale','available',[id]),read(cfg.meps,'MEPRegistry','getMEP',[mid])]);
   if(cfg.baseEnrollment){
    const base=profiles.bases.find(b=>b.sex===p.sex).mepId;
    same(await read(cfg.meps,'MEPRegistry','baseOf',[mid]),base);
    same(await read(cfg.instances,'InstanceRegistry','enrollmentMep',[mid]),base);
   }
   if(!alreadyOpen)same(owner,vault);same(ind[0],p.baseModelId);same(ind[1],p.deltaHash);same(ind[2],p.modelId);same(ind[3],mid);assert.equal(ind[4],p.sex);
   if(!alreadyOpen){assert.equal(q[0],price);assert.equal(q[1],expiresAt);assert(!available,'sale must remain paused while stocking');}
   for(const k of ['schemeDigest','modelId','execKind','synapseRoot'])same(registered[k],p[k]);
   assert.equal(registered.neurons,p.neurons);assert.equal(registered.synapses,p.synapses);
   if(registered.weightsDA.toLowerCase()!==mep(p).weightsDA.toLowerCase()){
    const receipt=await c.pub.getTransactionReceipt({hash:state.transactions[`stock-${Math.floor(p.index/10)*10}-${Math.floor(p.index/10)*10+9}`].hash});
    const hint=receipt.logs.filter(l=>l.address.toLowerCase()===collection.toLowerCase()).some(l=>{
     try{const e=decodeEventLog({abi:artifact('FlyCollection').abi,...l});return e.eventName==='WeightsHint'&&e.args.id===id&&e.args.mepId.toLowerCase()===mid.toLowerCase()&&e.args.weightsDA.toLowerCase()===mep(p).weightsDA.toLowerCase();}catch{return false;}
    });assert(hint,'missing collection-authored delta hint');
   }
   return {tokenId:Number(id),index:p.index,sex:p.sex,mepId:mid,deltaHash:p.deltaHash,price:price.toString(),revision:q[2].toString()};
  }));state.founders.push(...rows);
 }
 if(synchronous){
  await call('allow-collection-token-royalties',cfg.market,'SynchronousTaskMarket','setTokenBeneficiaryAllowed',[collection,true]);
  for(let i=0;i<profiles.founders.length;i+=32){const batch=profiles.founders.slice(i,i+32);
   await call(`certify-founders-${i}`,cfg.market,'SynchronousTaskMarket','setProfileSupports',[batch.map(p=>terms(p,collection,cfg.baseEnrollment)),batch.map(p=>p.maxInDegree)]);
  }
  for(const p of profiles.founders)assert.equal(await read(cfg.market,'SynchronousTaskMarket','profileMaxInDegree',[terms(p,collection,cfg.baseEnrollment)]),p.maxInDegree);
  state.verification={mode:'synchronous-v1',certifiedFounders:profiles.founders.length,maxInDegree:Math.max(...profiles.founders.map(p=>p.maxInDegree))};
 }
 await call('whitelist',cfg.whitelist,'CollectionWhitelist','add',[collection,'FlyBnB genesis v2: 100 female + 100 male; treasury inventory; verified published deltas']);
 assert(await read(cfg.whitelist,'CollectionWhitelist','isWhitelisted',[collection]));
 state.verifiedCount=state.founders.length;state.verifiedAt=new Date().toISOString();save();
 if(!activate){
  assert.equal(await read(sale,'TreasuryInventorySale','paused'),true,'staged launch requires a paused sale');
  console.log(`Verified ${state.verifiedCount} paused Founders at ${collection}; sale ${sale}`);return state;
 }
 await call('activate-sale',vault,'FounderInventoryVault','setSalePaused',[false]);
 assert.equal(await read(sale,'TreasuryInventorySale','paused'),false);
 if(smoke){
 if(state.transactions['test-adoption'] || (await read(collection,'FlyCollection','ownerOf',[1n])).toLowerCase()===vault.toLowerCase()) {
 // A real purchase with the authorized deployment wallet, followed by return/relist, keeps all 200 for public adoption.
 if(!state.testTreasuryBefore){state.testTreasuryBefore=(await c.pub.getBalance({address:cfg.treasury})).toString();save();}
 let purchase;
 try { purchase=await call('test-adoption',sale,'TreasuryInventorySale','buy',[1n,price,1n,expiresAt],price); }
 catch(error){
  // Only an unsubmitted estimation race can be skipped. A prepared/submitted hash must be resolved.
  const ownerNow=await read(collection,'FlyCollection','ownerOf',[1n]);
  if(state.transactions['test-adoption']||[vault,cfg.owner].some(a=>a.toLowerCase()===ownerNow.toLowerCase()))throw error;
  state.testAdoptionSkipped='Public buyer acquired token 1 before smoke transaction';save();
 }
 if(purchase?.status==='reverted'){
  const ownerNow=await read(collection,'FlyCollection','ownerOf',[1n]);
  assert(![vault,cfg.owner].some(a=>a.toLowerCase()===ownerNow.toLowerCase()),'unexpected smoke purchase revert');
  state.testAdoptionSkipped='Confirmed reverted smoke purchase; token 1 adopted by a public buyer';save();
 }
 if(purchase?.status==='success') {
 if(!state.testTreasuryAfter){
  state.testTreasuryAfter=(await c.pub.getBalance({address:cfg.treasury,blockNumber:purchase.blockNumber})).toString();
  assert(BigInt(state.testTreasuryAfter)-BigInt(state.testTreasuryBefore)>=price,'treasury not paid');save();
 }
 await call('return-test-nft',collection,'FlyCollection','transferFrom',[cfg.owner,vault,1n]);
 await call('relist-test-nft',vault,'FounderInventoryVault','list',[1n,price,expiresAt]);
 state.founders[0].revision=(await read(sale,'TreasuryInventorySale','listings',[1n]))[2].toString();save();
 }

 } else {state.testAdoptionSkipped='Token 1 already adopted by a public buyer after activation';save();}

 }
 console.log(`Verified ${state.verifiedCount} Founders at ${collection}; sale ${sale}`);return state;
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
 if(!process.argv.includes('--broadcast'))throw Error('Requires --broadcast (chain 97 only) and explicit --env-file=.env.bsc-testnet');
 const legacyJournal=path.join(root,'deployments/founder-inventory-97.json');
 const baseEnrollment=process.argv.includes('--base-enrollment');
 const journalIndex=process.argv.indexOf('--journal');
 if(journalIndex!==-1)assert(process.argv[journalIndex+1]&&!process.argv[journalIndex+1].startsWith('--'),'--journal requires a path');
 const journal=journalIndex===-1?legacyJournal:path.resolve(process.argv[journalIndex+1]);
 if(baseEnrollment)assert(journal!==legacyJournal,'base-enrollment launch requires a separate journal');
 const e=process.env, account=privateKeyToAccount(e.PORW_DEPLOYER_KEY);
 same(account.address,'0xFE560Af8f5cFC209794b3Df7DC7E281D4Ef81EDa');
 const chain=defineChain({id:97,name:'BSC Testnet',nativeCurrency:{name:'tBNB',symbol:'tBNB',decimals:18},rpcUrls:{default:{http:[e.PORW_RPC]}}});
 const c={account,pub:createPublicClient({chain,transport:http(e.PORW_RPC)}),wallet:createWalletClient({chain,account,transport:http(e.PORW_RPC)})};
 const cfg={chainId:97,owner:account.address,treasury:e.PORW_TREASURY,whitelist:e.PORW_WHITELIST,meps:e.PORW_MEP_REGISTRY,instances:e.PORW_INSTANCES,market:e.PORW_MARKET};
 if(baseEnrollment)cfg.baseEnrollment=true;
 if(process.argv.includes('--synchronous'))cfg.protocol='synchronous-v1';
 await launchInventory({c,cfg,journal,activate:!process.argv.includes('--no-activate'),smoke:!process.argv.includes('--no-smoke')});
}
