import test from 'node:test'; import assert from 'node:assert/strict';
import { readyCapacity } from '../gateway/capacity.mjs';
const warm = { epoch: 1, beacon: true, providers: 2 };
const opts = { timeoutMs: 100, pollMs: 5, redundancy: 2, wake: async () => {} };
test('cold epoch waits through beacon recovery until hosts regain eligibility', async () => {
  const states = [{ ...warm, beacon: false, providers: 0 }, { ...warm, epoch: 2, providers: 0 }, { ...warm, epoch: 3 }]; const wakes = []; let announced = 0;
  const result = await readyCapacity({ ...opts, read: async () => states.shift(), wake: async (e) => wakes.push(e), onCold: () => announced++ });
  assert.equal(result.epoch, 3); assert.deepEqual(wakes, [1, 2, 3]); assert.equal(announced, 1);
});
test('warm but under-capacity model refuses immediately without wake', async () => {
  await assert.rejects(readyCapacity({ ...opts, read: async () => ({ ...warm, providers: 1 }), wake: () => assert.fail('no demand admitted') }), { type: 'model_cold' });
});
test('absolute deadline covers a stalled RPC', async () => {
  const keep = setInterval(() => {}, 1000);
  try { await assert.rejects(readyCapacity({ ...opts, read: () => new Promise(() => {}) }), { type: 'epoch_cold' }); }
  finally { clearInterval(keep); }
});
test('disconnect does not cancel another waiter sharing a wake', async () => {
  const a = new AbortController(); let release; const waking = new Promise((r) => { release = r; });
  const reader = () => { let first = true; return async () => { const cold = first; first = false; return { ...warm, beacon: !cold }; }; };
  const one = readyCapacity({ ...opts, read: reader(), wake: () => waking, signal: a.signal });
  const two = readyCapacity({ ...opts, read: reader(), wake: () => waking });
  await new Promise((r) => setTimeout(r, 5));
  a.abort(new Error('disconnected')); await assert.rejects(one, /disconnected/); release(); assert.equal((await two).providers, 2);
});
test('a failed optional renewal does not reject an already warm request', async () => {
  const result = await readyCapacity({ ...opts, read: async () => warm, wake: async () => { throw new Error('wake endpoint unavailable'); } });
  assert.equal(result.providers, 2);
});
