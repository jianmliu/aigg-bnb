import { setTimeout as delay } from 'node:timers/promises';
export class CapacityError extends Error {
  constructor(type, capacity) {
    super(type === 'epoch_cold' ? `epoch ${capacity?.epoch ?? '?'} has no beacon yet` : `${capacity.providers} eligible provider(s): the model is cold`);
    this.status = 503; this.type = type;
    this.extra = { providers: capacity?.providers ?? 0, retry_after: type === 'epoch_cold' ? 30 : 60 };
  }
}
export async function abortable(fn, signal) {
  signal.throwIfAborted();
  let abort;
  const cancelled = new Promise((_, reject) => { abort = () => reject(signal.reason); signal.addEventListener('abort', abort, { once: true }); });
  try { return await Promise.race([Promise.resolve().then(() => { signal.throwIfAborted(); return fn(); }), cancelled]); }
  finally { signal.removeEventListener('abort', abort); }
}
// A hung RPC/fetch is bounded too. Abort stops this waiter, never a shared wake or another request.
export async function readyCapacity({ read, wake, redundancy, timeoutMs, pollMs, signal, onCold = () => {}, onCapacity = () => {} }) {
  const timer = AbortSignal.timeout(timeoutMs);
  const stop = signal ? AbortSignal.any([signal, timer]) : timer;
  let last = null, cold = false;
  const bounded = (fn) => abortable(fn, stop);
  try {
    for (;;) {
      last = await bounded(read); onCapacity(last);
      if (!cold && last.beacon && last.providers < redundancy) throw new CapacityError('model_cold', last);
      if (!last.beacon && !cold) { cold = true; onCold(last); }
      stop.throwIfAborted();
      if (last.beacon && last.providers >= redundancy) {
        // Renewal is optional once this epoch can serve. It must not turn availability into an outage.
        Promise.resolve().then(() => wake(last.epoch)).catch(() => {});
        return last;
      }
      await bounded(() => wake(last.epoch));
      await delay(pollMs, undefined, { signal: stop });
    }
  } catch (error) {
    if (signal?.aborted) throw signal.reason;
    if (timer.aborted) throw new CapacityError(last?.beacon ? 'model_cold' : 'epoch_cold', last);
    throw error;
  }
}
