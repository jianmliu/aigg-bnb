import test from 'node:test'; import assert from 'node:assert/strict';
import { hostStats } from '../relayer/providers.mjs';
const A = '0x' + '11'.repeat(20), B = '0x' + '22'.repeat(20);
test('host totals count paid executors only and mirror royalty/rounding math', async () => {
  const ranges = [];
  const ch = { pub: {
    getBlockNumber: async () => 6000n,
    getLogs: async (p) => { ranges.push([p.fromBlock, p.toBlock]); return p.fromBlock === 1001n ? [
      { args: { taskId: 'paid', executors: [A, B] } }, { args: { taskId: 'refund', executors: [] } },
    ] : []; },
    readContract: async ({ args }) => { assert.equal(args[0], 'paid'); return [{ mepId: 'brain', fee: 101n }]; },
  }, meps: { read: { termsOf: async () => [B, 1500] } } };
  const get = hostStats(ch, A);
  assert.deepEqual(await get(A), { instance: A, fromBlock: 1001, toBlock: 6000, requestsServed: 1, earnedWei: '43' });
  assert.equal((await get(B)).earnedWei, '43'); assert.equal(ranges.length, 5, 'shared cache serves all addresses');
  assert.deepEqual(ranges.at(-1), [5001n, 6000n]);
});
test('scan errors cannot turn into zero earnings', async () => {
  const get = hostStats({ pub: { getBlockNumber: async () => 5n, getLogs: async () => { throw new Error('RPC unavailable'); } } }, A);
  await assert.rejects(get(A), /RPC unavailable/); await assert.rejects(get(B), /RPC unavailable/);
});
