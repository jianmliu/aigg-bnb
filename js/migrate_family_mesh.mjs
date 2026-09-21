// Resumable fresh-mesh deployment. Does not alter legacy contracts, move bonds, or cut over services.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
import {createPublicClient,createWalletClient,http,defineChain,encodeDeployData,encodeFunctionData,keccak256,stringToHex} from 'viem';
import {privateKeyToAccount} from 'viem/accounts';
const root=fileURLToPath(new URL('../',import.meta.url));
const artifact=n=>JSON.parse(fs.readFileSync(path.join(root,`contracts/out/${n}.sol/${n}.json`)));
const json=x=>JSON.stringify(x,(_,v)=>typeof v==='bigint'?v.toString():v,2)+'\n';
export async function deployFamilyMesh({c,cfg,journal}) {
 assert([97,31337].includes(cfg.chainId));assert.equal(await c.pub.getChainId(),cfg.chainId);
 assert.equal(c.account.address.toLowerCase(),cfg.owner.toLowerCase());
 assert(cfg.protocol===undefined || cfg.protocol==='synchronous-v1','unknown deployment protocol');
 const synchronous=cfg.protocol==='synchronous-v1';
 const type=n=>synchronous?({MultiAssetTaskMarket:'SynchronousTaskMarket',ExecutionDisputes:'SynchronousExecutionDisputes'}[n]||n):n;
 const names=['PorwVerifierKeccak','MEPRegistry','InstanceRegistry','CommitRevealBeacon','PoRWClaimManager','MultiAssetTaskMarket','ExecutionDisputes','RelayRegistry','CollectionWhitelist','HostCapacity'].map(type);
 const configHash=keccak256(stringToHex(json({cfg,artifacts:names.map(n=>keccak256(artifact(n).bytecode.object))})));
 const state=fs.existsSync(journal)?JSON.parse(fs.readFileSync(journal)):{version:1,configHash,chainId:cfg.chainId,owner:cfg.owner,addresses:{},transactions:{}};
 assert.equal(state.configHash,configHash,'migration journal mismatch');
 const save=()=>{fs.mkdirSync(path.dirname(journal),{recursive:true});fs.writeFileSync(journal+'.tmp',json(state),{mode:0o600});fs.renameSync(journal+'.tmp',journal);};save();
 const read=(address,name,functionName,args=[])=>c.pub.readContract({address,abi:artifact(type(name)).abi,functionName,args});
 async function tx(label,to,data) {
  let row=state.transactions[label];
  if(!row){
   const nonce=await c.pub.getTransactionCount({address:cfg.owner,blockTag:'latest'});
   assert.equal(await c.pub.getTransactionCount({address:cfg.owner,blockTag:'pending'}),nonce,'pending deployer nonce');
   const gasPrice=await c.pub.getGasPrice();assert(gasPrice<=3_000_000_000n,'gas ceiling');
   const gas=(await c.pub.estimateGas({account:c.account,to,data}))*120n/100n;assert(gas<15_000_000n,'gas limit');
   assert(await c.pub.getBalance({address:cfg.owner})>gas*gasPrice+20_000_000_000_000_000n,'reserve for remaining migration');
   const req=await c.wallet.prepareTransactionRequest({account:c.account,to,data,nonce,gas,gasPrice,type:'legacy'});
   const signed=await c.wallet.signTransaction(req),hash=keccak256(signed);
   row=state.transactions[label]={hash,nonce,status:'prepared',serializedTransaction:signed};save();
  }
  if(row.status!=='success'){
   assert(row.serializedTransaction && keccak256(row.serializedTransaction)===row.hash,'missing or corrupt signed transaction');
   // Re-submit exactly the same signed bytes; never create a replacement nonce or transaction.
   try{await c.wallet.sendRawTransaction({serializedTransaction:row.serializedTransaction});}
   catch(error){try{await c.pub.getTransaction({hash:row.hash});}catch{throw error;}}
   row.status='submitted';save();
  }
  const receipt=await c.pub.waitForTransactionReceipt({hash:row.hash,confirmations:cfg.chainId===97?3:1,timeout:180000});
  assert.equal(receipt.status,'success',label+' reverted');
  Object.assign(row,{status:'success',blockNumber:String(receipt.blockNumber),gasUsed:String(receipt.gasUsed),contractAddress:receipt.contractAddress});save();console.log(label,row.hash);return receipt;
 }
 const deploy=async(key,name,args=[])=>{const a=artifact(type(name)),r=await tx(key,undefined,encodeDeployData({abi:a.abi,bytecode:a.bytecode.object,args}));state.addresses[key]=r.contractAddress;save();return r.contractAddress;};
 const call=(label,key,name,fn,args)=>tx(label,state.addresses[key],encodeFunctionData({abi:artifact(type(name)).abi,functionName:fn,args}));
 const p=cfg.params,d=state.addresses;
 await deploy('verifier','PorwVerifierKeccak');await deploy('meps','MEPRegistry');
 await deploy('instances','InstanceRegistry',[BigInt(p.unit),p.exitDelay]);
 await deploy('beacon','CommitRevealBeacon',[p.epochBlocks,p.commitBlocks,p.revealBlocks,BigInt(p.beaconDeposit)]);
 await deploy('claims','PoRWClaimManager',[d.meps,d.instances,d.verifier,p.epochBlocks,p.openingWindow,BigInt(p.openingDeposit),BigInt(p.slashAmount),d.beacon]);
 await deploy('market','MultiAssetTaskMarket',synchronous?[d.meps,d.instances,d.claims,p.sessionCommitBlocks,p.sessionRevealBlocks,p.sessionDisputeBlocks]:[d.meps,d.instances,d.claims,p.taskTimeout]);
 await deploy('disputes','ExecutionDisputes',[d.meps,d.instances,d.market,p.roundBlocks,BigInt(p.slashAmount)]);
 await deploy('relays','RelayRegistry',[BigInt(p.relayBond),p.exitDelay]);
 await deploy('whitelist','CollectionWhitelist',[cfg.owner]);await deploy('hostCapacity','HostCapacity');
 await call('wire-claims','instances','InstanceRegistry','setClaimManager',[d.claims,p.claimValidity]);
 await call('wire-slasher','instances','InstanceRegistry','setSlasher',[d.disputes,true]);
 await call('wire-disputes','market','MultiAssetTaskMarket','setDisputes',[d.disputes]);
 if(synchronous)await call('wire-task-holds','instances','InstanceRegistry','setSlasher',[d.market,true]);
 else await call('wire-challenges','market','MultiAssetTaskMarket','setChallengeParams',[BigInt(p.challengeDeposit),p.challengeWindow,p.challengeSink]);
 await call('wire-base-enrollment','instances','InstanceRegistry','setMEPRegistry',[d.meps]);
 await call('authorize-capacity','hostCapacity','HostCapacity','setMarket',[d.market,true]);
 await call('wire-capacity','market','MultiAssetTaskMarket','setHostCapacity',[d.hostCapacity]);
 for(const unit of [...new Set(cfg.bases.map(x=>x.wUnitQ16))])await call('lif-'+unit,'meps','MEPRegistry','declareLifKind',[unit]);
 for(const b of cfg.bases)await call('base-'+b.mepId,'meps','MEPRegistry','registerMEP',[b.profile]);
 assert.equal((await read(d.instances,'InstanceRegistry','mepRegistry')).toLowerCase(),d.meps.toLowerCase());
 assert.equal((await read(d.market,'MultiAssetTaskMarket','hostCapacity')).toLowerCase(),d.hostCapacity.toLowerCase());
 assert(await read(d.hostCapacity,'HostCapacity','authorizedMarkets',[d.market]));
 for(const b of cfg.bases){const m=await read(d.meps,'MEPRegistry','getMEP',[b.mepId]);assert.equal(m.modelId.toLowerCase(),b.profile.modelId.toLowerCase());assert.equal((await read(d.instances,'InstanceRegistry','enrollmentMep',[b.mepId])).toLowerCase(),b.mepId.toLowerCase());}
 const checks=[
  ['instances','InstanceRegistry','owner',[],cfg.owner],['instances','InstanceRegistry','claimManager',[],d.claims],
  ['instances','InstanceRegistry','claimValidityEpochs',[],p.claimValidity],['instances','InstanceRegistry','UNIT',[],p.unit],['instances','InstanceRegistry','EXIT_DELAY',[],p.exitDelay],
  ['instances','InstanceRegistry','slasher',[d.claims],true],['instances','InstanceRegistry','slasher',[d.disputes],true],
  ['market','MultiAssetTaskMarket','disputes',[],d.disputes],['market','MultiAssetTaskMarket','claimManager',[],d.claims],['market','MultiAssetTaskMarket','instances',[],d.instances],['market','MultiAssetTaskMarket','meps',[],d.meps],
  ['market','MultiAssetTaskMarket','TASK_TIMEOUT',[],p.taskTimeout],['market','MultiAssetTaskMarket','challengeWindow',[],p.challengeWindow],['market','MultiAssetTaskMarket','challengeDepositWei',[],p.challengeDeposit],['market','MultiAssetTaskMarket','challengeSink',[],p.challengeSink],
  ['beacon','CommitRevealBeacon','EPOCH_BLOCKS',[],p.epochBlocks],['beacon','CommitRevealBeacon','COMMIT_BLOCKS',[],p.commitBlocks],['beacon','CommitRevealBeacon','REVEAL_BLOCKS',[],p.revealBlocks],['beacon','CommitRevealBeacon','DEPOSIT',[],p.beaconDeposit],
  ['claims','PoRWClaimManager','OPENING_WINDOW',[],p.openingWindow],['claims','PoRWClaimManager','OPENING_DEPOSIT',[],p.openingDeposit],['claims','PoRWClaimManager','SLASH_AMOUNT',[],p.slashAmount],
  ['disputes','ExecutionDisputes','ROUND_BLOCKS',[],p.roundBlocks],['disputes','ExecutionDisputes','SLASH_AMOUNT',[],p.slashAmount],
  ['relays','RelayRegistry','BOND',[],p.relayBond],['whitelist','CollectionWhitelist','curator',[],cfg.owner],['hostCapacity','HostCapacity','owner',[],cfg.owner]
 ];
 if(synchronous){
  const replaced=new Set(['TASK_TIMEOUT','challengeWindow','challengeDepositWei','challengeSink']);
  for(let i=checks.length-1;i>=0;i--)if(checks[i][0]==='market'&&replaced.has(checks[i][2]))checks.splice(i,1);
  checks.push(['market','SynchronousTaskMarket','protocolVersion',[],1],['market','SynchronousTaskMarket','challengeWindow',[],0],
   ['market','SynchronousTaskMarket','COMMIT_BLOCKS',[],p.sessionCommitBlocks],['market','SynchronousTaskMarket','REVEAL_BLOCKS',[],p.sessionRevealBlocks],
   ['market','SynchronousTaskMarket','DISPUTE_BLOCKS',[],p.sessionDisputeBlocks],['market','SynchronousTaskMarket','TASK_TIMEOUT',[],p.sessionCommitBlocks+p.sessionRevealBlocks+p.sessionDisputeBlocks],
   ['instances','InstanceRegistry','slasher',[d.market],true]);
 }
 for(const [key,name,fn,args,value] of checks)assert.equal(String(await read(d[key],name,fn,args)).toLowerCase(),String(value).toLowerCase(),key+'.'+fn);
 for(const b of cfg.bases)assert.equal(Number(await read(d.meps,'MEPRegistry','lifWeightUnit',[b.profile.execKind])),b.wUnitQ16);
 if(synchronous){
  for(let i=0;i<cfg.bases.length;i+=32){const batch=cfg.bases.slice(i,i+32);for(const b of batch)assert(Number.isInteger(b.maxInDegree)&&b.maxInDegree>0&&b.maxInDegree<=16384,'missing measured base witness bound');
   await call(`certify-bases-${i}`,'market','MultiAssetTaskMarket','setProfileSupports',[batch.map(b=>b.mepId),batch.map(b=>b.maxInDegree)]);
  }
  for(const b of cfg.bases)assert.equal(await read(d.market,'MultiAssetTaskMarket','profileMaxInDegree',[b.mepId]),b.maxInDegree);
 }
 state.verifiedAt=new Date().toISOString();save();return state;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
 const args=process.argv.slice(2);assert(args.includes('--broadcast'),'explicit --broadcast required');
 const cfg=JSON.parse(fs.readFileSync(args[args.indexOf('--config')+1]));assert.equal(cfg.chainId,97);
 const account=privateKeyToAccount(process.env.PORW_DEPLOYER_KEY);assert.equal(account.address.toLowerCase(),'0xfe560af8f5cfc209794b3df7dc7e281d4ef81eda');
 const chain=defineChain({id:97,name:'BSC Testnet',nativeCurrency:{name:'tBNB',symbol:'tBNB',decimals:18},rpcUrls:{default:{http:[cfg.rpc]}}});
 const c={account,pub:createPublicClient({chain,transport:http(cfg.rpc)}),wallet:createWalletClient({account,chain,transport:http(cfg.rpc)})};
 await deployFamilyMesh({c,cfg,journal:path.join(root,cfg.protocol==='synchronous-v1'?'deployments/synchronous-mesh-97.json':'deployments/family-mesh-97.json')});
}
