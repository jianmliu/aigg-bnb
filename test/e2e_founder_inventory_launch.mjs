// All 200 published profiles through the exact resumable launch flow, on local Anvil only.
import fs from 'node:fs';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
import {getContractAddress,stringToHex,parseEther,hexToBytes,toHex} from 'viem';
import {withBase,withTerms} from '../contracts/lib/aigg-porw/web/porw-browser/mep.js';
import * as H from './harness.mjs';
import {launchInventory} from '../js/launch_founder_inventory.mjs';
const baseEnrollment=process.env.TEST_BASE_ENROLMENT==='1';
const legacyJournal=fileURLToPath(new URL('../deployments/founder-inventory-97.json',import.meta.url));
const rejected=spawnSync(process.execPath,[fileURLToPath(new URL('../js/launch_founder_inventory.mjs',import.meta.url)),'--broadcast','--base-enrollment','--journal',legacyJournal],{encoding:'utf8',env:{...process.env,PORW_DEPLOYER_KEY:''}});
assert.notEqual(rejected.status,0);
assert.match(rejected.stderr,/base-enrollment launch requires a separate journal/);
H.forgeBuild();
const anvil=await H.startAnvil(8579), journal='/tmp/aigg-inventory-launch-anvil.json';
try {
 fs.rmSync(journal,{force:true});
 const dep=await H.deployMesh(anvil.rpc),c=H.clientsFor(dep,H.KEYS[0]);
 for(const unit of [7209,18022])await H.sendTo(c,dep.addresses.meps,'MEPRegistry','declareLifKind',[unit]);
 const treasury=await H.create(c,'TreasuryRouter',[c.account.address,c.account.address]);
 const whitelist=await H.create(c,'CollectionWhitelist',[c.account.address]);
 const cfg={chainId:31337,treasury,whitelist,meps:dep.addresses.meps,instances:dep.addresses.instances,market:dep.addresses.market,owner:c.account.address};
 // An outsider pre-registers the exact future terms with a wrong location hint.
 const ps=JSON.parse(fs.readFileSync(new URL('../flybnb/genesis/founder-profiles-v2.json',import.meta.url)));
 if(baseEnrollment){
  await H.sendTo(c,cfg.instances,'InstanceRegistry','setMEPRegistry',[cfg.meps]);
  for(const b of ps.bases)await H.sendTo(c,cfg.meps,'MEPRegistry','registerMEP',[{...b,weightsDA:stringToHex(b.weightsDA)}]);
  const capacity=await H.create(c,'HostCapacity');
  await H.sendTo(c,capacity,'HostCapacity','setMarket',[cfg.market,true]);
  await H.sendTo(c,cfg.market,'TaskMarket','setHostCapacity',[capacity]);
  cfg.baseEnrollment=true;
 }
 const expected=getContractAddress({from:c.account.address,nonce:BigInt(await c.pub.getTransactionCount({address:c.account.address}))});
 const p=ps.founders[0],outsider=H.clientsFor(dep,H.KEYS[1]);
 await H.sendTo(outsider,cfg.meps,'MEPRegistry',baseEnrollment?'registerDerivedMEPWithTerms':'registerMEPWithTerms',[{...p,weightsDA:stringToHex('https://invalid.example/front-run')},...(baseEnrollment?[ps.bases.find(b=>b.sex===p.sex).mepId]:[]),expected,1000]);
 const rawSend=c.wallet.sendRawTransaction;let dropFirst=true;
 c.wallet.sendRawTransaction=async request=>{if(dropFirst){dropFirst=false;throw Error('pre-broadcast interruption');}return rawSend(request);};
 await assert.rejects(launchInventory({c,cfg,journal,activate:false,smoke:false}),/pre-broadcast interruption/);
 assert(JSON.parse(fs.readFileSync(journal)).transactions.collection.serializedTransaction);
 const staged=await launchInventory({c,cfg,journal,activate:false,smoke:false});
 assert.equal(await H.readFrom(c,staged.addresses.sale,'TreasuryInventorySale','paused'),true);
 assert(!staged.transactions['activate-sale']);assert(!staged.transactions['test-adoption']);
 assert.equal(await H.readFrom(c,staged.addresses.collection,'FlyCollection','BASE_ENROLMENT'),baseEnrollment);
 for(const row of staged.founders){
  const profile=ps.founders[row.index],base=ps.bases.find(b=>b.sex===profile.sex);
  const raw={mepId:hexToBytes(profile.mepId)};
  const expectedMep=toHex(withTerms(baseEnrollment?withBase(raw,base.mepId):raw,staged.addresses.collection,1000).mepId);
  assert.equal(row.mepId,expectedMep);
  if(baseEnrollment){
   assert.equal(await H.readFrom(c,cfg.meps,'MEPRegistry','baseOf',[row.mepId]),base.mepId);
   assert.equal(await H.readFrom(c,cfg.instances,'InstanceRegistry','enrollmentMep',[row.mepId]),base.mepId);
  }
 }
 const stagedNonce=await c.pub.getTransactionCount({address:c.account.address});
 await launchInventory({c,cfg,journal,activate:false,smoke:false});
 assert.equal(await c.pub.getTransactionCount({address:c.account.address}),stagedNonce,'paused resume must not send transactions');
 const opened=await launchInventory({c,cfg,journal,smoke:false});
 assert.equal(await H.readFrom(c,opened.addresses.sale,'TreasuryInventorySale','paused'),false);
 assert(!opened.transactions['test-adoption']);
 const result=await launchInventory({c,cfg,journal});
 assert(result.transactions['test-adoption'].status==='success');
 assert.equal(result.addresses.collection.toLowerCase(),expected.toLowerCase());
 assert.equal(result.verifiedCount,200);
 // Activation was mined but its success flag was not saved; a public adoption follows.
 const interrupted=JSON.parse(fs.readFileSync(journal));interrupted.transactions['activate-sale'].status='submitted';fs.writeFileSync(journal,JSON.stringify(interrupted));
 await H.sendTo(outsider,result.addresses.sale,'TreasuryInventorySale','buy',[2n,parseEther('0.01'),1n,BigInt(result.expiresAt)],parseEther('0.01'));
 const nonce=await c.pub.getTransactionCount({address:c.account.address});
 const again=await launchInventory({c,cfg,journal});
 assert.equal(again.addresses.collection,result.addresses.collection);
 assert.equal(await c.pub.getTransactionCount({address:c.account.address}),nonce,'resume must not send duplicate transactions');
 console.log('PASS 200 Founders, exact MEP terms/DA, sale, treasury receipt, inventory restoration and idempotent resume');
} finally {anvil.stop();}
