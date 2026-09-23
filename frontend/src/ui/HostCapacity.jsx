import { useEffect, useState } from 'react';
import { Button } from './primitives.jsx';
import * as C from '../core/controller.js';
import { saveBrowserCapacity, matchingHost } from '../core/host-capacity.js';

export default function HostCapacity({ active }) {
  const s = C.state, instance = s.wallet, chain = s.deployment?.chainId;
  const base = s.deployment ? C.relayer() : null;
  const supported = s.deployment?.capacity?.endpoint === '/capacity';
  const key = `${base}:${chain}:${s.deployment?.addresses.market}:${instance}`;
  const [snapshot, setSnapshot] = useState(null), [error, setError] = useState(null);
  const [roundSlots,setRoundSlots]=useState(1);
  const rounds=s.deployment?.verification?.mode==='synchronous-vrf-rounds-v1';
  const maxRoundTasks=Math.min(64,Number(s.deployment?.verification?.maxRoundTasks)||1);
  const [saving, setSaving] = useState(false), [revision, refresh] = useState(0);
  useEffect(() => {
    if (!active || !supported || !instance || !s.chainOk) return;
    let live = true, timer;
    const abort = new AbortController();
    const update = async () => {
      if (document.hidden) { timer = setTimeout(update, 5000); return; }
      try {
        const r = await fetch(`${base}/capacity?instance=${instance}`, { signal: AbortSignal.any([abort.signal, AbortSignal.timeout(15000)]) });
        const data = await r.json();
        if (!r.ok || data.error) throw Error(data.error || 'Capacity unavailable');
        if (live) { setSnapshot({ ...data, chainId: chain, key }); setError(null); }
      } catch (e) { if (live) setError({ key, message: e.message }); }
      if (live) timer = setTimeout(update, 5000);
    };
    update();
    return () => { live = false; clearTimeout(timer); abort.abort(); };
  }, [active, supported, key, s.chainOk, revision]);
  if (!active || !instance || !s.chainOk) return null;
  if (!supported) return <p className="hint">Capacity-based admission is not enabled on this deployment.</p>;
  if (error?.key === key) return <p className="hint" role="status">Capacity unavailable. Retrying…</p>;
  const data = snapshot?.key === key ? snapshot : null;
  if (!data) return <p className="hint">Loading task capacity…</p>;
  if (!data.enabled) return <p className="hint">Capacity-based admission requires the new task contracts; this deployment uses the existing draw.</p>;
  const save = async slots => {
    setSaving(true);
    try { await saveBrowserCapacity(C, data, slots); setSnapshot(null); refresh(x => x + 1); }
    finally { setSaving(false); }
  };
  return <div id="host-capacity">
    <h3>Task capacity</h3>
    <p><strong>{data.limit}</strong> committed slots · <strong>{data.active}</strong> active execution leases · <strong>{data.free}</strong> unreserved slots</p>
    <p className="hint">Slots are shared across models and payment tokens. Free capacity admits you to the draw; stake determines your weight. Availability is a recent snapshot, not a guaranteed assignment or a measurement of idle hardware.</p>
    <Button disabled={saving || data.limit === 0} onClick={C.wrap(() => save(0))}>Pause new assignments</Button>{' '}
    <Button disabled={saving || !data.authorized || !matchingHost(s.node, data) || data.limit === 1} onClick={C.wrap(() => save(1))}>Set 1 browser slot</Button>
    {rounds && <div className="row tight center"><label>Round task slots <input aria-label="Round task slots" type="number" min="1" max={maxRoundTasks} value={roundSlots} onChange={e=>setRoundSlots(Number(e.target.value))}/></label><Button disabled={saving || !data.authorized || !matchingHost(s.node,data) || !Number.isInteger(roundSlots) || roundSlots<1 || roundSlots>maxRoundTasks} onClick={C.wrap(()=>save(roundSlots))}>Set round capacity</Button></div>}
    {s.node?.models.size > 0 && !matchingHost(s.node, data) && <p className="hint">The running host belongs to another wallet or deployment. Restart it for this wallet before enabling capacity.</p>}
    {!data.authorized && <p className="hint">This market is not authorized to reserve slots.</p>}
    <p className="hint">{rounds?'Round capacity explicitly opts this tab into multiple tasks sharing a randomness request. Computation is serial; each task keeps independent verification evidence and deadlines. Choose only as many tasks as this device can finish in time.':'This tab executes one task at a time. Server operators with parallel executors can configure more slots on chain.'} Pausing or closing this tab does not cancel assigned tasks; pause on chain before stopping. Submitted results and expired execution leases free slots, but dispute data must still be retained.</p>
  </div>;
}
