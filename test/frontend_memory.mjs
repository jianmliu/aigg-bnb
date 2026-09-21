// Exercise the real page controller without a browser, chain, or large allocations.
//
// The controller is the page's only mutable state and is deliberately React-free, so it can be run here as plain
// source: its imports are stripped (one per line) and its exports unprefixed, leaving `state`, `startNode` and
// `hostOnNode` as ordinary bindings in a vm with a stub document and a stub Worker. The point is the memory
// arithmetic -- whether a tab agrees to hold 4.5 GiB of brain -- checked without allocating any of it.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { modelMemoryBytes, maxStepsWithin, WASM32_MAX_BYTES } from '../contracts/lib/aigg-porw/web/porw-browser/mem.js';
const source = fs.readFileSync(new URL('../frontend/src/core/controller.js', import.meta.url), 'utf8')
  .replace(/^import .*;\n/gm, '').replace(/^export /gm, '');
function page(reply = { ok: true, matches: true, neurons: 1 }, globals = {}) {
  const elements = new Map(); const calls = [];
  // the stub document mints an element the first time anything asks for it, so tests reach inputs through
  // `input(id)` rather than the map: the controller touches the DOM only when an action runs.
  const input = (id) => { if (!elements.has(id)) elements.set(id, { value: id === 'steps' ? '30000' : '', textContent: '' }); return elements.get(id); };
  const context = vm.createContext({ modelMemoryBytes, maxStepsWithin, WASM32_MAX_BYTES, window: {}, Date,
    document: { getElementById: input },
    Worker: class { postMessage(m) { calls.push(m); queueMicrotask(() => this.onmessage({ data: { reqId: m.reqId, ...reply } })); } },
    setInterval: () => {}, keypair: () => ({ priv: new Uint8Array(32) }), hex: () => '0x11', ...globals,
  });
  vm.runInContext(source + '\nglobalThis.test = {state, startNode, hostOnNode, loop, prepareEnrollmentBase};', context);
  const { state, startNode, hostOnNode, loop, prepareEnrollmentBase } = context.test;
  state.delegation = {}; state.deployment = { domains: {}, relay: 'unused' }; state.session = {priv: new Uint8Array(32)};
  const add = (id, neurons, synapses, nTiles) => { const m = { mepId: id, exec: 'int-lif' }; state.meps.push(m); state.hosted.add(id); state.prepared.add(id); state.loaded[id] = { name: id, neurons, synapses, bytes: nTiles * 4096 }; return m; };
  return { state, startNode, hostOnNode, loop, prepareEnrollmentBase, elements, input, calls, add };
}
let fails = 0;
async function check(name, fn) { try { await fn(); console.log('ok', name); } catch (e) { fails++; console.error('FAIL', name, e.message); } }
await check('reject combined 4.48 GiB before worker initialization', async () => {
  const p = page(); p.add('female',139255,2700513,6866); p.add('male',166700,6242118,15566);
  await assert.rejects(p.startNode(), /memory|GiB|GB/i); assert.equal(p.calls.length, 0);
});
await check('family mode reserves a separate derivation/execution budget before starting', async () => {
  const p = page(); p.state.deployment.familyHosting = true;
  p.add('female',139255,2700513,6866);
  await assert.rejects(p.startNode(), /memory|GiB|GB/i); assert.equal(p.calls.length,0);
});
await check('family hot-add retains the separate task budget', async () => {
  const p = page(); p.state.deployment.familyHosting = true;
  p.state.node = { models:new Map(), memoryBytes:0 };
  await assert.rejects(p.hostOnNode(p.add('female',139255,2700513,6866)), /memory|GiB|GB/i);
  assert.equal(p.calls.length,0);
});
await check('hot-add includes existing capacity even after input changes', async () => {
  const p = page(); const first = p.add('female',139255,2700513,6866); p.state.node = { models: new Map(), memoryBytes: 0 };
  await p.hostOnNode(first);
  assert.equal(p.state.node.models.get('female').maxSteps,30000);
  p.input('steps').value = '26000';
  const second = p.add('male',166700,6242118,15566);
  await assert.rejects(p.hostOnNode(second), /memory|GiB|GB/i); assert.equal(p.calls.length,1);
});
await check('small brains can both be hosted and keep their chosen capacities', async () => {
  const p = page(); const first = p.add('a',4000,60000,200); p.state.node = { models: new Map(), memoryBytes: 0 };
  p.input('steps').value = '100'; await p.hostOnNode(first);
  const before = p.state.node.memoryBytes;
  p.input('steps').value = '5000'; await p.hostOnNode(p.add('b',4000,60000,200));
  assert.equal(p.state.node.models.get('a').maxSteps,100); assert.equal(p.state.node.models.get('b').maxSteps,5000);
  assert.ok(p.state.node.memoryBytes > before); assert.equal(p.calls.length,2);
});
await check('leave headroom rather than filling the theoretical 4 GiB', async () => {
  const p = page(); p.add('female',139255,2700513,6866);
  p.input('steps').value = String(maxStepsWithin({ nTiles:6866, neurons:139255, synapses:2700513, exec:'lif' }, WASM32_MAX_BYTES));
  await assert.rejects(p.startNode(), /memory|GiB|GB/i); assert.equal(p.calls.length,0);
});
await check('failed hot-add retains its reservation because allocations are not rolled back', async () => {
  const p = page({ ok: false, error: 'load failed' }); const first = p.add('female',139255,2700513,6866);
  p.state.node = { models: new Map(), memoryBytes: 0 };
  await assert.rejects(p.hostOnNode(first), /load failed/);
  assert.ok(p.state.node.memoryBytes > 2 * 1024 ** 3);
  await assert.rejects(p.hostOnNode(p.add('male',166700,6242118,15566)), /memory|GiB|GB/i);
  assert.equal(p.calls.length,1);
});
// The node loop fires on a 3 s interval, and one pass can outlast that: a residency claim on the real brain is
// ~5 s of wasm, and a sponsored materialize waits for a receipt. A tick that lands mid-pass must join it, not
// start a second one -- a second pass re-announces the claim, and its materialize (which now reverts in the
// relayer's simulation) would overwrite the first one's success and retry every tick until the epoch ends.
await check('a tick that lands while a pass is in flight joins it instead of running a second one', async () => {
  const posts = [];
  const fetch = async (url, init) => {
    const path = url.replace('http://relayer', ''); let body = {};
    if (path.startsWith('/epoch')) body = { epoch: 5, rolled: true, challenge: '0x00' };
    else if (path.startsWith('/proof')) body = { posted: true };
    else if (path === '/tx/materialize') { posts.push(init.body); body = posts.length === 1 ? { ok: true, gasUsed: 1 } : { error: 'would revert' }; }
    return { json: async () => body };
  };
  const p = page({ ok: true, claimHash: '0xabc', slotMs: 1 }, { fetch });
  p.add('female',139255,2700513,6866);
  p.input('relayer').value = 'http://relayer'; p.input('auto').checked = true;
  p.state.node = { models: new Map([['female', {}]]), memoryBytes: 0 }; p.state.resolved = '0xme';
  p.state.claims.female = { 4: '0xprev' };
  await Promise.all([p.loop(), p.loop(), p.loop()]);
  assert.equal(p.calls.filter((m) => m.op === 'announce').length, 1);
  assert.equal(posts.length, 1);
  assert.equal(p.state.materialized.female[4], true);
  await p.loop(); // and the guard releases: a later tick runs again, with nothing left to do
  assert.equal(p.calls.filter((m) => m.op === 'announce').length, 1); assert.equal(posts.length, 1);
});
await check('two child executions share one base claim and materialization', async () => {
  const posts=[];const fetch=async(url,init)=>{const path=url.replace('http://relayer','');return {json:async()=>path.startsWith('/epoch')?{epoch:5,rolled:true,challenge:'0x00'}:path.startsWith('/proof')?{posted:true}:path==='/tx/materialize'?(posts.push(JSON.parse(init.body)),{ok:true,gasUsed:1}):{}};};
  const p=page({ok:true,claimHash:'0xabc',slotMs:1},{fetch});
  p.add('base',100,1000,4);for(const id of ['child1','child2'])p.add(id,100,1000,4).enrollmentMepId='base';
  p.input('relayer').value='http://relayer';p.input('auto').checked=true;p.state.resolved='0xme';
  p.state.node={models:new Map(['base','child1','child2'].map(id=>[id,{}])),memoryBytes:0};p.state.claims.base={4:'prior'};
  await p.loop();assert.deepEqual(p.calls.filter(m=>m.op==='announce').map(m=>m.mepId),['base']);assert.equal(posts.length,1);assert.equal(posts[0].mep,'base');
});
await check('preparing a derived model also prepares its base from held bytes',async()=>{
 const p=page({ok:true,held:true,modelId:'0xbase',neurons:100,synapses:1000,bytes:4096});
 const base={mepId:'base',modelId:'0xbase'};const child={mepId:'child',enrollmentMepId:'base'};p.state.meps.push(base,child);
 await p.prepareEnrollmentBase(child);assert(p.state.prepared.has('base'));assert(p.state.hosted.has('base'));assert.equal(p.calls.filter(m=>m.op==='prepare')[0].mepId,'base');
 await p.prepareEnrollmentBase(child);assert.equal(p.calls.filter(m=>m.op==='prepare').length,1);
});
if (fails) process.exitCode=1;
