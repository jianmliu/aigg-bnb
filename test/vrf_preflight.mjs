import test from 'node:test';
import assert from 'node:assert/strict';
import { checkVrfDeployment, BSC_TESTNET_VRF } from '../js/check_vrf_deployment.mjs';
const addr=n=>'0x'+n.toString(16).padStart(40,'0');
const market=addr(1),controller=addr(2),capacity=addr(3),registry=addr(4),disputes=addr(5);
function fixture(overrides={}) {
 const values={
  [`${market}:admissionVersion`]:2n,[`${market}:protocolVersion`]:1n,[`${market}:admission`]:controller,
  [`${market}:hostCapacity`]:capacity,[`${market}:instances`]:registry,[`${market}:disputes`]:disputes,
  [`${controller}:MARKET`]:market,[`${controller}:instances`]:registry,[`${disputes}:market`]:market,[`${disputes}:instances`]:registry,
  [`${controller}:coordinator`]:BSC_TESTNET_VRF.coordinator,[`${controller}:keyHash`]:BSC_TESTNET_VRF.keyHash,
  [`${controller}:subId`]:123n,[`${controller}:requestConfirmations`]:3,[`${controller}:callbackGasLimit`]:150000,
  [`${controller}:nativePayment`]:false,[`${controller}:WAIT_BLOCKS`]:100n,[`${controller}:ACTIVATION_BLOCKS`]:10n,
  [`${controller}:READY_TTL`]:100n,[`${controller}:feeRecipient`]:addr(6),[`${controller}:admissionFee`]:100n,
  ...overrides,
 };
 const calls=[];
 const client={getChainId:async()=>97,getBlock:async()=>({number:400n,hash:'0x'+'12'.repeat(32)}),getBytecode:async args=>{calls.push(args);return '0x1234';},
  readContract:async args=>{calls.push(args);const key=`${args.address}:${args.functionName}`;
   if(key in values)return values[key];
   if(args.functionName==='authorizedMarkets'||args.functionName==='slasher')return true;
   throw Error('unexpected read '+key);
  }};
 return {client,calls,run:()=>checkVrfDeployment({client,market,chainId:97,abis:{}})};
}
test('valid deployment reports config only, snapshot and explicit external checks',async()=>{
 const f=fixture(),r=await f.run();assert.equal(r.configurationValid,true);assert.equal(r.liveProofVerified,false);
 assert.equal(r.subscription.status,'external-check-required');assert.equal(r.blockNumber,'400');
 assert.ok(f.calls.every(c=>c.blockNumber===400n));assert.ok(f.calls.length<45);
 for(const target of [market,controller])assert.ok(f.calls.some(c=>c.address===capacity&&c.functionName==='authorizedMarkets'&&c.args[0]===target));
 for(const target of [controller,disputes])assert.ok(f.calls.some(c=>c.address===registry&&c.functionName==='slasher'&&c.args[0]===target));
 assert.equal(r.config.subId,'123');assert.equal(r.config.nativeAdmissionFee,'100');
});
for(const [label,key,value] of [
 ['old admission',`${market}:admissionVersion`,1n],['wrong protocol',`${market}:protocolVersion`,2n],
 ['controller binding',`${controller}:MARKET`,addr(99)],['registry binding',`${controller}:instances`,addr(99)],
 ['dispute binding',`${disputes}:market`,addr(99)],['coordinator',`${controller}:coordinator`,addr(99)],
 ['key hash',`${controller}:keyHash`,'0x'+'00'.repeat(32)],['subscription',`${controller}:subId`,0n],
 ['fee',`${controller}:admissionFee`,0n],['wait deadline',`${controller}:WAIT_BLOCKS`,0n],
 ['capacity authorization',`${capacity}:authorizedMarkets`,false],['slasher',`${registry}:slasher`,false],
])test(`rejects ${label}`,async()=>assert.equal((await fixture({[key]:value}).run()).configurationValid,false));
test('rejects unknown chain before reads',async()=>{
 const f=fixture();f.client.getChainId=async()=>56;const r=await f.run();assert.equal(r.configurationValid,false);assert.equal(f.calls.length,0);
});
test('missing deployed bytecode fails closed',async()=>{
 const f=fixture();f.client.getBytecode=async()=>undefined;assert.equal((await f.run()).configurationValid,false);
});
test('transport errors never expose endpoint credentials',async()=>{
 const f=fixture();f.client.readContract=async()=>{throw Error('https://private:secret@rpc.example');};
 const r=await f.run();assert.equal(r.configurationValid,false);assert.doesNotMatch(JSON.stringify(r),/secret|rpc.example/);
});
for(const value of [1,2,201])test(`rejects unsupported confirmations ${value}`,async()=>{
 assert.equal((await fixture({[`${controller}:requestConfirmations`]:value}).run()).configurationValid,false);
});
test('rejects callback gas above network maximum',async()=>{
 assert.equal((await fixture({[`${controller}:callbackGasLimit`]:2500001}).run()).configurationValid,false);
});
for(const [confirmations,gas] of [[3,100000],[200,2500000]])test(`accepts supported boundaries ${confirmations}/${gas}`,async()=>{
 assert.equal((await fixture({[`${controller}:requestConfirmations`]:confirmations,[`${controller}:callbackGasLimit`]:gas}).run()).configurationValid,true);
});
test('uses finalized block and verifies its hash after every state read',async()=>{
 const f=fixture(),order=[];const read=f.client.readContract;
 f.client.readContract=async args=>{order.push('read');return read(args);};
 f.client.getBlock=async args=>{order.push(args);return {number:400n,hash:'0x'+'12'.repeat(32)};};
 const r=await f.run();assert.equal(r.configurationValid,true);assert.equal(r.blockHash,'0x'+'12'.repeat(32));
 assert.equal(order[0].blockTag,'finalized');assert.equal(order.at(-1).blockNumber,400n);
});
test('rejects snapshot reorganization',async()=>{
 const f=fixture();let calls=0;
 f.client.getBlock=async()=>({number:400n,hash:'0x'+(++calls===1?'12':'34').repeat(32)});
 const r=await f.run();assert.equal(r.configurationValid,false);assert.ok(r.errors.includes('snapshot-block-changed'));
});
test('fails closed when finalized block is unavailable',async()=>{
 const f=fixture();f.client.getBlock=async()=>{throw Error('unsupported finalized');};
 const r=await f.run();assert.equal(r.configurationValid,false);assert.equal(f.calls.length,0);
});
test('rejects malformed finalized block',async()=>{
 const f=fixture();f.client.getBlock=async()=>({number:null,hash:null});
 assert.equal((await f.run()).configurationValid,false);assert.equal(f.calls.length,0);
});

test('v3 checks round bounds as well as the existing VRF configuration',async()=>{
 const f=fixture({[`${market}:admissionVersion`]:3n,[`${controller}:ROUND_BLOCKS`]:20n,[`${controller}:MAX_ROUND_TASKS`]:8});
 const result=await f.run();assert.equal(result.configurationValid,true);assert.equal(result.config.ROUND_BLOCKS,'20');assert.equal(result.admissionVersion,3);
 assert.equal((await fixture({[`${market}:admissionVersion`]:3n,[`${controller}:ROUND_BLOCKS`]:0n,[`${controller}:MAX_ROUND_TASKS`]:8}).run()).configurationValid,false);
});
