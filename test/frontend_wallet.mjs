import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';
const source = fs.readFileSync(new URL('../frontend/src/core/controller.js', import.meta.url), 'utf8').replace(/^import .*;\n/gm, '').replace(/^export /gm, '');
const address = '0x1111111111111111111111111111111111111111';
function page({ injected, announced = [] } = {}) {
  const events = new EventTarget();
  const win = { ethereum: injected, addEventListener: events.addEventListener.bind(events), dispatchEvent: events.dispatchEvent.bind(events) };
  win.addEventListener('eip6963:requestProvider', () => announced.forEach(detail => { const e = new Event('eip6963:announceProvider'); e.detail = detail; win.dispatchEvent(e); }));
  const elements = new Map();
  const ctx = vm.createContext({ window: win, Event, Date, WASM32_MAX_BYTES: 2**32, setInterval:()=>{}, document:{getElementById:id=>{if(!elements.has(id)) elements.set(id,{textContent:'',value:''}); return elements.get(id);}}, decodeUint:()=>0n, encode:()=> '0x' });
  vm.runInContext(source+'\nglobalThis.api={state,connect,eth};',ctx);
  ctx.api.state.deployment={chainId:97,addresses:{instances:address}};
  return {...ctx.api,win};
}
function provider(fail) { const calls=[]; return {calls,request:async({method})=>{calls.push(method);if(method==='eth_requestAccounts'){if(fail) return fail();return [address];}if(method==='eth_chainId')return '0x61';return '0x0';}}; }
test('connect chooses announced MetaMask instead of a competing window.ethereum and pins it',async()=>{
  const wrong=provider(()=>{throw Error('wrong wallet');}), meta=provider();
  const p=page({injected:wrong,announced:[{info:{uuid:'trust',rdns:'com.trustwallet.app',name:'Trust'},provider:wrong},{info:{uuid:'meta',rdns:'io.metamask',name:'MetaMask'},provider:meta}]});
  await p.connect(); assert.equal(wrong.calls.length,0); assert.equal(p.state.wallet,address);
  p.win.ethereum=wrong;assert.equal(p.eth(),meta);
});
test('legacy injected wallets still connect',async()=>{const w=provider();const p=page({injected:w});await p.connect();assert.equal(p.state.wallet,address);});
test('pending connection is visible and repeated clicks do not create another request',async()=>{
  let done;const w=provider(()=>new Promise(r=>{done=r;}));const p=page({injected:w});const pending=p.connect();
  assert.equal(p.state.walletConnecting,true);await p.connect();assert.equal(w.calls.filter(m=>m==='eth_requestAccounts').length,1);
  done([address]);await pending;assert.equal(p.state.walletConnecting,false);
});
test('a rejected or already pending request gives an actionable visible error',async()=>{
  for(const code of [4001,-32002]){const p=page({injected:provider(()=>{throw Object.assign(Error('opaque'),{code});})});
    await assert.rejects(p.connect());assert.match(p.state.walletError,code===4001?/reject|cancel/i:/pending|extension/i);assert.equal(p.state.walletConnecting,false);}
});
test('missing extension tells the visitor how to connect',async()=>{const p=page();await assert.rejects(p.connect());assert.match(p.state.walletError,/install|MetaMask|wallet browser/i);});
