// Exercise the real page controller without a browser, chain, or large allocations.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { modelMemoryBytes, maxStepsWithin, WASM32_MAX_BYTES } from '../contracts/lib/aigg-porw/web/porw-browser/mem.js';
const source = fs.readFileSync(new URL('../frontend/app.js', import.meta.url), 'utf8').replace(/^import .*;\n/gm, '');
function page(reply = { ok: true, matches: true, neurons: 1 }) {
  const elements = new Map(); const calls = [];
  const context = vm.createContext({ modelMemoryBytes, maxStepsWithin, WASM32_MAX_BYTES, window: {}, Date,
    document: { getElementById: (id) => { if (!elements.has(id)) elements.set(id, { value: id === 'steps' ? '30000' : '', textContent: '' }); return elements.get(id); } },
    Worker: class { postMessage(m) { calls.push(m); queueMicrotask(() => this.onmessage({ data: { reqId: m.reqId, ...reply } })); } },
    setInterval: () => {}, keypair: () => ({ priv: new Uint8Array(32) }), hex: () => '0x11',
  });
  vm.runInContext(source + '\nglobalThis.test = {state, startNode, hostOnNode};', context);
  const { state, startNode, hostOnNode } = context.test;
  state.delegation = {}; state.deployment = { domains: {}, relay: 'unused' }; state.session = {priv: new Uint8Array(32)};
  const add = (id, neurons, synapses, nTiles) => { const m = { mepId: id, exec: 'int-lif' }; state.meps.push(m); state.hosted.add(id); state.prepared.add(id); state.loaded[id] = { name: id, neurons, synapses, bytes: nTiles * 4096 }; return m; };
  return { state, startNode, hostOnNode, elements, calls, add };
}
let fails = 0;
async function check(name, fn) { try { await fn(); console.log('ok', name); } catch (e) { fails++; console.error('FAIL', name, e.message); } }
await check('reject combined 4.48 GiB before worker initialization', async () => {
  const p = page(); p.add('female',139255,2700513,6866); p.add('male',166700,6242118,15566);
  await assert.rejects(p.startNode(), /memory|GiB|GB/i); assert.equal(p.calls.length, 0);
});
await check('hot-add includes existing capacity even after input changes', async () => {
  const p = page(); const first = p.add('female',139255,2700513,6866); p.state.node = { models: new Map(), memoryBytes: 0 };
  await p.hostOnNode(first);
  assert.equal(p.state.node.models.get('female').maxSteps,30000);
  p.elements.get('steps').value = '26000';
  const second = p.add('male',166700,6242118,15566);
  await assert.rejects(p.hostOnNode(second), /memory|GiB|GB/i); assert.equal(p.calls.length,1);
});
await check('small brains can both be hosted and keep their chosen capacities', async () => {
  const p = page(); const first = p.add('a',4000,60000,200); p.state.node = { models: new Map(), memoryBytes: 0 };
  p.elements.get('steps').value = '100'; await p.hostOnNode(first);
  const before = p.state.node.memoryBytes;
  p.elements.get('steps').value = '5000'; await p.hostOnNode(p.add('b',4000,60000,200));
  assert.equal(p.state.node.models.get('a').maxSteps,100); assert.equal(p.state.node.models.get('b').maxSteps,5000);
  assert.ok(p.state.node.memoryBytes > before); assert.equal(p.calls.length,2);
});
await check('leave headroom rather than filling the theoretical 4 GiB', async () => {
  const p = page(); p.add('female',139255,2700513,6866);
  p.elements.get('steps').value = String(maxStepsWithin({ nTiles:6866, neurons:139255, synapses:2700513, exec:'lif' }, WASM32_MAX_BYTES));
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
if (fails) process.exitCode=1;
