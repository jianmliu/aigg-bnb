import { useEffect, useState } from 'react';
import { Panel } from './primitives.jsx';
import * as C from '../core/controller.js';

// Keep money as integers through formatting: a small payout must not round down to a misleading zero.
const bnb = (wei) => {
  const n = BigInt(wei), unit = 10n ** 18n;
  const fraction = (n % unit).toString().padStart(18, '0').replace(/0+$/, '');
  return `${n / unit}${fraction ? '.' + fraction : ''} BNB`;
};
export default function HostDashboard({ active }) {
  const s = C.state, instance = s.wallet, deployment = s.deployment;
  const base = deployment ? C.relayer() : null;
  const key = `${base}:${deployment?.chainId}:${deployment?.addresses?.market}:${instance}`;
  const [snapshot, setSnapshot] = useState(null);
  const [failure, setFailure] = useState(null);
  useEffect(() => {
    if (!active || !instance || !deployment || !s.chainOk) return;
    let live = true, timer; const controller = new AbortController();
    const update = async () => {
      if (document.hidden) { timer = setTimeout(update, 5000); return; }
      try {
        const get = async (p) => { const r = await fetch(base + p, { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]) }); const j = await r.json(); if (!r.ok || j.error) throw new Error(j.error || `HTTP ${r.status}`); return j; };
        const [stats, models] = await Promise.all([get('/hosts?instance=' + instance), get('/meps')]);
        if (live) { setSnapshot({ key, stats, models }); setFailure(null); }
      } catch (e) { if (live) setFailure({ key, message: e.message }); }
      if (live) timer = setTimeout(update, 5000);
    };
    update();
    return () => { live = false; clearTimeout(timer); controller.abort(); };
  }, [active, key, s.chainOk]);
  const data = snapshot?.key === key ? snapshot : null;
  const error = failure?.key === key ? failure.message : null;
  const stats = !error && s.chainOk ? data?.stats : null;
  const online = [...(s.node?.models.keys() || [])];
  return <div id="provider-dashboard">
    <Panel title="Your hosting" note="provider dashboard">
      <div className="host-metrics">
        <div><span className="metric-label">Models online in this tab</span><strong id="host-online">{online.length}</strong></div>
        <div><span className="metric-label">Requests served · settled</span><strong id="host-served">{stats ? stats.requestsServed : '—'}</strong></div>
        <div><span className="metric-label">Earned · paid to your wallet</span><strong id="host-earned">{stats ? bnb(stats.earnedWei) : '—'}</strong></div>
      </div>
      {!instance ? <p className="hint">Connect your wallet to see settled requests and earnings.</p>
        : !s.chainOk ? <p className="hint">Switch to this mesh’s chain to see your hosting activity.</p>
        : error ? <p className="hint" role="status">Hosting activity is unavailable. Retrying…</p>
        : !stats ? <p className="hint" role="status">Loading hosting activity…</p>
        : <p className="hint">Paid requests and earnings in blocks {stats.fromBlock.toLocaleString()}–{stats.toBlock.toLocaleString()} (up to the latest 5,000 blocks). Earnings exclude royalties and your gas costs; settled results may still be challenged.</p>}
      {online.length ? <ul className="host-models">{online.map((id) => {
        const m = data?.models.find((m) => m.mepId === id) || C.mepById(id);
        return <li key={id}><span>{m?.name || id.slice(0, 14) + '…'}</span><span>Resident · {stats ? stats.eligibleModels.includes(id) ? (stats.beacon ? 'eligible for requests' : 'waiting for beacon') : 'waiting for a valid claim' : 'eligibility unavailable'}</span><span>{!error && data ? `${m?.providers ?? 0} eligible host(s) on mesh` : '—'}</span></li>;
      })}</ul> : <p className="hint">No models are running in this tab. Complete the steps below to start hosting.</p>}
    </Panel>
  </div>;
}
