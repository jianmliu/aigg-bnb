// M3: a task client's signed demand wakes a lazy epoch; waits never spend a task fee.
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import * as H from './harness.mjs';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-wake-'));
const anvil = await H.startAnvil(8572); const stop = [];
const wait = async (fn) => { const until = Date.now() + 20000; while (Date.now() < until) { if (await fn()) return; await H.sleep(100); } throw new Error('condition timed out'); };
try {
  const dep = await H.deploy(anvil.rpc, { EPOCH_BLOCKS: '100' });
  const { mepId } = await H.registerSyntheticMep(dep, H.KEYS[0]);
  const G = H.clientsFor(dep, H.KEYS[4]), other = H.clientsFor(dep, H.KEYS[2]);
  const R = await H.startRelayer(dep, H.KEYS[3], [mepId], { env: { PORW_BEACON_LAZY: '1', PORW_TASK_CLIENTS: G.account.address } }); stop.push(() => R.stop());
  await wait(async () => Number((await R.api('/status')).block) > 0);
  const deployment = await R.api('/deployment');
  const message = (epoch, chain = dep.chainId) => ['aigg-bnb:wake:v1', String(chain), dep.addresses.claims.toLowerCase(), dep.addresses.market.toLowerCase(), deployment.relayer.toLowerCase(), String(epoch)].join('\n');
  const epoch = (await R.api('/epoch')).epoch;
  const signed = { client: G.account.address, epoch, signature: await G.account.signMessage({ message: message(epoch) }) };
  const forged = await R.api('/wake', { ...signed, signature: await other.account.signMessage({ message: message(epoch) }) });
  assert.ok(forged.error, 'forged wake refused');
  const valid = await R.api('/wake', signed);
  assert.equal(valid.ok, true, 'allowlisted task wallet can wake without a bond');
  assert.equal(valid.wakeUntil, epoch + 2);
  assert.ok((await R.api('/wake', { ...signed, signature: await G.account.signMessage({ message: message(epoch, 56) }) })).error, 'wrong domain refused even while warm');
  assert.ok((await R.api('/wake', { ...signed, epoch: epoch + 3 })).error, 'future epoch refused');
  assert.ok((await R.api('/wake', { client: other.account.address, epoch, signature: await other.account.signMessage({ message: message(epoch) }) })).error, 'unlisted task wallet refused');
  const env = { GATEWAY_BEARER: 'test', GATEWAY_MODELS: `brain=${mepId}`, GATEWAY_STATE: path.join(tmp, 'calls.json'), GATEWAY_WAKE_TIMEOUT_MS: '1200', GATEWAY_POLL_MS: '100', GATEWAY_KEEPALIVE_MS: '50' };
  let gateway = await H.startGateway(R, H.KEYS[4], env); stop.push(() => gateway.stop());
  const call = (body, signal) => fetch(gateway.url + '/v1/responses', { method: 'POST', headers: { authorization: 'Bearer test', 'content-type': 'application/json' }, body: JSON.stringify({ model: 'brain', max_output_tokens: 2, ...body }), signal });
  const balance = await G.pub.getBalance({ address: G.account.address });
  let start = Date.now(); const stream = await call({ stream: true });
  assert.ok(Date.now() - start < 1000, 'SSE headers arrive before cold wait finishes');
  const text = await stream.text();
  assert.match(text, /: waiting on the chain/); assert.match(text, /event: response.failed/); assert.match(text, /epoch_cold/);
  assert.ok(Date.now() - start >= 1000 && Date.now() - start < 5000, 'cold wait has an absolute bound');
  assert.equal(await G.pub.getBalance({ address: G.account.address }), balance, 'timeout spends nothing');
  const response = await call({}); assert.equal(response.status, 503); assert.equal(response.headers.get('retry-after'), '30');
  assert.equal((await response.json()).error.type, 'epoch_cold');
  const abort = new AbortController(); const cancelled = await call({ stream: true }, abort.signal); abort.abort(); await cancelled.body.cancel().catch(() => {});
  const to = async (b) => { const n = await anvil.block(); if (b > n) await anvil.mine(b - n); };
  // Another waiter survives the disconnected request and observes the next epoch's beacon.
  await gateway.stop(); gateway = await H.startGateway(R, H.KEYS[4], { ...env, GATEWAY_WAKE_TIMEOUT_MS: '10000' });
  const pending = call({}); await H.sleep(100);
  await to(95); await wait(async () => (await R.api('/status')).commits.includes(1));
  await to(102); await wait(async () => (await R.api('/status')).reveals.includes(1));
  await to(112); await wait(async () => (await R.api('/status')).epochsRolled.includes(1));
  const cold = await pending; assert.equal(cold.status, 503); assert.equal((await cold.json()).error.type, 'model_cold');
  assert.equal(await G.pub.getBalance({ address: G.account.address }), balance, 'no hosts means no task fee after waking either');
  // /meps now performs capacity reads too: a hung model lookup is part of the same deadline.
  const stalled = http.createServer(async (req, res) => {
    if (req.url === '/meps') return;
    const upstream = await fetch(R.apiBase + req.url); res.writeHead(upstream.status, { 'content-type': 'application/json' }); res.end(await upstream.text());
  });
  await new Promise((r) => stalled.listen(0, '127.0.0.1', r));
  stop.push(() => { stalled.closeAllConnections(); stalled.close(); });
  const hung = await H.startGateway({ apiBase: `http://127.0.0.1:${stalled.address().port}` }, H.KEYS[4], { ...env, GATEWAY_STATE: path.join(tmp, 'hung.json') }); stop.push(() => hung.stop());
  start = Date.now();
  const bounded = await fetch(hung.url + '/v1/responses', { method: 'POST', headers: { authorization: 'Bearer test', 'content-type': 'application/json' }, body: JSON.stringify({ model: 'brain' }) });
  assert.equal(bounded.status, 503); assert.ok(Date.now() - start < 5000, 'model lookup cannot bypass cold deadline');
  assert.equal(await G.pub.getBalance({ address: G.account.address }), balance);
  console.log('gateway wake: all checks passed');
} finally { for (const f of stop.reverse()) await f(); anvil.stop(); fs.rmSync(tmp, { recursive: true, force: true }); }
