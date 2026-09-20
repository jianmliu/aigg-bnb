// All 200 published profiles through the exact resumable launch flow, on local Anvil only.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import {getContractAddress,stringToHex,parseEther} from 'viem';
import * as H from './harness.mjs';
import {launchInventory} from '../js/launch_founder_inventory.mjs';
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
 const expected=getContractAddress({from:c.account.address,nonce:BigInt(await c.pub.getTransactionCount({address:c.account.address}))});
 const p=ps.founders[0],outsider=H.clientsFor(dep,H.KEYS[1]);
 await H.sendTo(outsider,cfg.meps,'MEPRegistry','registerMEPWithTerms',[{...p,weightsDA:stringToHex('https://invalid.example/front-run')},expected,1000]);
 const result=await launchInventory({c,cfg,journal});
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
