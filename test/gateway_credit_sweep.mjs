import test from 'node:test';
import assert from 'node:assert/strict';
import { CreditSweeper } from '../gateway/credit-sweep.mjs';

test('sweeps only above threshold and combines concurrent requests', async () => {
  let credit = 9n, calls = 0;
  const sweep = new CreditSweeper({ threshold: 10n, read: async () => credit,
    withdraw: async () => { calls++; await new Promise(resolve => setTimeout(resolve, 5)); credit = 0n; return '0x1'; },
    wait: async hash => ({ hash, status: 'success' }) });
  assert.equal(await sweep.maybeSweep(), null);
  credit = 10n;
  const [a, b] = await Promise.all([sweep.maybeSweep(), sweep.maybeSweep()]);
  assert.equal(a, '0x1'); assert.equal(b, '0x1'); assert.equal(calls, 1);
  assert.equal(await sweep.maybeSweep(), null);
});

test('failed withdrawal can retry on the next task or restart', async () => {
  let calls = 0;
  const sweep = new CreditSweeper({ threshold: 1n, read: async () => 3n,
    withdraw: async () => { calls++; return '0x1'; },
    wait: async () => calls === 1 ? { status: 'reverted' } : { status: 'success' } });
  await assert.rejects(sweep.maybeSweep(), /reverted/);
  assert.equal(await sweep.maybeSweep(), '0x1');
  assert.equal(calls, 2);
});

test('a credit arriving during withdrawal gets another threshold check', async () => {
  let credit = 10n, calls = 0, release;
  const firstReceipt = new Promise(resolve => { release = resolve; });
  const sweep = new CreditSweeper({ threshold: 10n, read: async () => credit,
    withdraw: async () => { calls++; credit = 0n; return `0x${calls}`; },
    wait: async hash => { if (hash === '0x1') await firstReceipt; return { status: 'success' }; } });
  const first = sweep.maybeSweep();
  while (calls === 0) await new Promise(resolve => setTimeout(resolve, 0));
  credit = 12n;
  const second = sweep.maybeSweep();
  release();
  assert.equal(await first, '0x2');
  assert.equal(await second, '0x2');
  assert.equal(calls, 2);
});
