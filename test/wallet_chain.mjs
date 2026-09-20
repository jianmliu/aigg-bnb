import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import vm from 'node:vm';
const source=fs.readFileSync(new URL('../frontend/src/core/controller.js',import.meta.url),'utf8').replace(/^import .*;\n/gm,'').replace(/^export /gm,'');
function fixture(chain='0x61',account='0x'+'11'.repeat(20)){
 const sent=[];const context=vm.createContext({WASM32_MAX_BYTES:2**32,window:{ethereum:{request:async({method,params})=>{
  if(method==='eth_chainId')return chain;if(method==='eth_accounts')return [account];if(method==='eth_sendTransaction'){sent.push(params[0]);return '0x123';}if(method==='eth_getTransactionReceipt')return {status:'0x1'};throw Error(method);
 }}},document:{getElementById:()=>({textContent:''})},setInterval:()=>{},encode:()=> '0x',Date});
 vm.runInContext(source+'\nglobalThis.subject={state,send};',context);const {state,send}=context.subject;state.deployment={chainId:97};state.wallet='0x'+'11'.repeat(20);state.chainOk=true;
 return {state,send,sent};
}
test('rejects a chain changed after approval before any payable send',async()=>{const f=fixture('0x38');await assert.rejects(f.send('0x'+'22'.repeat(20),'breed()',[],1n),/chain/i);assert.equal(f.sent.length,0);});
test('rejects a changed wallet account',async()=>{const f=fixture('0x61','0x'+'33'.repeat(20));await assert.rejects(f.send('0x'+'22'.repeat(20),'breed()',[],1n),/account/i);assert.equal(f.sent.length,0);});
test('every send binds the expected chain in the wallet transaction',async()=>{const f=fixture();await f.send('0x'+'22'.repeat(20),'breed()',[],1n);assert.equal(f.sent[0].chainId,'0x61');});
