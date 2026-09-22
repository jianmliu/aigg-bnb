import fs from 'node:fs';
import assert from 'node:assert/strict';
import {createPublicClient,createWalletClient,http,defineChain,stringToHex,parseAbi} from 'viem';
import {privateKeyToAccount} from 'viem/accounts';
import * as H from './harness.mjs';
import {deployVrfSubscription} from '../js/deploy_vrf_subscription.mjs';
const synchronous=true;
const anvil=await H.startAnvil(8597),journal='/tmp/aigg-vrf-subscription-test.json';
try {
 fs.rmSync(journal,{force:true});fs.rmSync(journal+'.mesh.json',{force:true});
 const chain=defineChain({id:31337,name:'Anvil',nativeCurrency:{name:'ETH',symbol:'ETH',decimals:18},rpcUrls:{default:{http:[anvil.rpc]}}});
 const account=privateKeyToAccount(H.KEYS[0]),c={account,pub:createPublicClient({chain,transport:http(anvil.rpc)}),wallet:createWalletClient({account,chain,transport:http(anvil.rpc)})};
 const bases=JSON.parse(fs.readFileSync('flybnb/genesis/founder-profiles-v2.json')).bases.map(b=>({mepId:b.mepId,wUnitQ16:b.wUnitQ16,profile:{...b,weightsDA:stringToHex(b.weightsDA)}}));
 const cfg={chainId:31337,owner:account.address,bases,params:{unit:'5000000000000000',exitDelay:200,epochBlocks:200,commitBlocks:40,revealBlocks:40,beaconDeposit:'5000000000000000',openingWindow:200,openingDeposit:'2000000000000000',slashAmount:'10000000000000000',taskTimeout:400,roundBlocks:400,claimValidity:6,challengeWindow:200,challengeDeposit:'20000000000000000',challengeSink:account.address,relayBond:'1000000000000000'}};
 if(synchronous){for(const b of bases)b.maxInDegree=b.profile.sex===0?8861:10167;cfg.protocol="synchronous-v1";Object.assign(cfg.params,{sessionCommitBlocks:40,sessionRevealBlocks:40,sessionDisputeBlocks:1000,roundBlocks:10});}
 const a=JSON.parse(fs.readFileSync('contracts/out/SubscriptionCoordinator.sol/SubscriptionCoordinator.json'));
 const hash=await c.wallet.deployContract({abi:a.abi,bytecode:a.bytecode.object});
 const coordinator=(await c.pub.waitForTransactionReceipt({hash})).contractAddress;
 cfg.protocol='synchronous-vrf-v1';
 cfg.vrf={coordinator,keyHash:'0x'+'11'.repeat(32),requestConfirmations:3,callbackGasLimit:200000,nativePayment:true,waitBlocks:200,activationBlocks:100,readyTTL:400,feeRecipient:account.address};
 cfg.fundingWei='10000000000000000';cfg.admissionFeeWei='1000000000000000';
 await assert.rejects(deployVrfSubscription({c,cfg:{...cfg,vrf:{...cfg.vrf,requestConfirmations:1}},journal}),/confirmations/);
 await assert.rejects(deployVrfSubscription({c,cfg:{...cfg,vrf:{...cfg.vrf,callbackGasLimit:2500001}},journal}),/callback gas/);
 const send=c.wallet.sendRawTransaction,getTransaction=c.pub.getTransaction;let sends=0,unavailable=false;
 c.wallet.sendRawTransaction=async args=>{const h=await send(args);sends++;if(sends===1)throw Error('lost broadcast response');if(sends===2){unavailable=true;throw Error('funding response lost');}return h;};
 c.pub.getTransaction=async args=>{if(unavailable){unavailable=false;throw Error('temporary RPC outage');}return getTransaction(args);};
 await assert.rejects(deployVrfSubscription({c,cfg,journal}),/funding response lost/);
 const d=await deployVrfSubscription({c,cfg,journal});
 assert(d.verifiedAt);assert.equal(d.subscription.nativeBalance,cfg.fundingWei);assert.equal(d.subscription.consumers.length,1);
 assert.equal(d.subscription.consumers[0].toLowerCase(),d.consumer.toLowerCase());
 const nonce=await c.pub.getTransactionCount({address:account.address});
 await deployVrfSubscription({c,cfg,journal});assert.equal(await c.pub.getTransactionCount({address:account.address}),nonce);
 await assert.rejects(deployVrfSubscription({c,cfg:{...cfg,fundingWei:'1'},journal}),/mismatch/);
 await assert.rejects(deployVrfSubscription({c,cfg:{...cfg,chainId:56},journal}),/chain/);
 console.log('PASS create/fund/enroll, response loss, restart without duplicate funding, config and chain protection');
}finally{anvil.stop();}
process.exit(0);
