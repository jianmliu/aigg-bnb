import fs from 'node:fs';
import assert from 'node:assert/strict';
import {createPublicClient,createWalletClient,http,defineChain,stringToHex,parseAbi} from 'viem';
import {privateKeyToAccount} from 'viem/accounts';
import * as H from './harness.mjs';
import {deployFamilyMesh} from '../js/migrate_family_mesh.mjs';
const synchronous=process.env.TEST_SYNCHRONOUS_DEPLOY==='1';
const anvil=await H.startAnvil(synchronous?8594:8593),journal=synchronous?'/tmp/aigg-synchronous-mesh-test.json':'/tmp/aigg-family-mesh-test.json';
try {
 fs.rmSync(journal,{force:true});
 const chain=defineChain({id:31337,name:'Anvil',nativeCurrency:{name:'ETH',symbol:'ETH',decimals:18},rpcUrls:{default:{http:[anvil.rpc]}}});
 const account=privateKeyToAccount(H.KEYS[0]),c={account,pub:createPublicClient({chain,transport:http(anvil.rpc)}),wallet:createWalletClient({account,chain,transport:http(anvil.rpc)})};
 const bases=JSON.parse(fs.readFileSync('flybnb/genesis/founder-profiles-v2.json')).bases.map(b=>({mepId:b.mepId,wUnitQ16:b.wUnitQ16,profile:{...b,weightsDA:stringToHex(b.weightsDA)}}));
 const cfg={chainId:31337,owner:account.address,bases,params:{unit:'5000000000000000',exitDelay:200,epochBlocks:200,commitBlocks:40,revealBlocks:40,beaconDeposit:'5000000000000000',openingWindow:200,openingDeposit:'2000000000000000',slashAmount:'10000000000000000',taskTimeout:400,roundBlocks:400,claimValidity:6,challengeWindow:200,challengeDeposit:'20000000000000000',challengeSink:account.address,relayBond:'1000000000000000'}};
 if(synchronous){for(const b of bases)b.maxInDegree=b.profile.sex===0?8861:10167;cfg.protocol="synchronous-v1";Object.assign(cfg.params,{sessionCommitBlocks:40,sessionRevealBlocks:40,sessionDisputeBlocks:1000,roundBlocks:10});}
 const send=c.wallet.sendRawTransaction;let interrupted=true;c.wallet.sendRawTransaction=async args=>{if(interrupted){interrupted=false;throw Error('simulated interruption before broadcast');}return send(args);};
 await assert.rejects(deployFamilyMesh({c,cfg,journal}),/simulated interruption/);
 const pending=JSON.parse(fs.readFileSync(journal));assert(pending.transactions.verifier.serializedTransaction,'signed bytes must survive pre-broadcast crash');
 const d=await deployFamilyMesh({c,cfg,journal});assert.equal(Object.keys(d.addresses).length,10);assert(d.verifiedAt);
 if(synchronous){assert.equal(await c.pub.readContract({address:d.addresses.market,abi:parseAbi(['function protocolVersion() view returns(uint256)']),functionName:'protocolVersion'}),1n);}
 const nonce=await c.pub.getTransactionCount({address:account.address});await deployFamilyMesh({c,cfg,journal});assert.equal(await c.pub.getTransactionCount({address:account.address}),nonce);
 await assert.rejects(deployFamilyMesh({c,cfg:{...cfg,params:{...cfg.params,unit:'1'}},journal}),/mismatch/);
 console.log('PASS fresh mesh wiring, real base registry and idempotent journal; changed config rejected');
}finally{anvil.stop();}
process.exit(0);
