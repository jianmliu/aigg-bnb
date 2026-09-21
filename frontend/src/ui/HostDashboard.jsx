import HostCapacity from './HostCapacity.jsx';
import { useEffect, useState } from 'react';
import { Panel, Button } from './primitives.jsx';
import * as C from '../core/controller.js';
import {decodeAddress,decodeUint} from '../core/abi.js';

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
  const [asset,setAsset]=useState(null),[assetError,setAssetError]=useState(null),[saving,setSaving]=useState(false);
  useEffect(()=>{let live=true;setAsset(null);setAssetError(null);
   if(active&&instance&&s.chainOk&&deployment?.addresses?.tokenBatteryBudget){(async()=>{try{
    const token=decodeAddress(await C.call(deployment.addresses.tokenBatteryBudget,'paymentToken()'));
    const accepted=decodeUint(await C.call(deployment.addresses.market,'acceptedToken(address,address)',[instance,token]))!==0n;
    if(live)setAsset({token,accepted,key});
   }catch(e){if(live)setAssetError(e.message);}})();}return()=>{live=false;};
  },[active,key,s.chainOk,deployment?.addresses?.tokenBatteryBudget]);
  const toggleAsset=async()=>{if(!asset||asset.key!==key||!s.chainOk)throw Error('Connect on the deployment chain');
   setSaving(true);try{const chain=await C.eth().request({method:'eth_chainId'});if(Number(chain)!==Number(deployment.chainId))throw Error('Wrong wallet chain');
    const r=await C.send(deployment.addresses.market,'setAcceptedToken(address,bool)',[asset.token,asset.accepted?0:1]);if(r.status!=='0x1')throw Error('Preference transaction reverted');
    setAsset({...asset,accepted:!asset.accepted});
   }finally{setSaving(false);}};
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
      {s.meps.some(m=>m.enrollmentMepId && m.enrollmentMepId!==m.mepId) && <p className="hint">Stake and residency claims cover a base pool. On family-enabled deployments, assigned descendants load automatically from verified delta recipes.</p>}
      <HostCapacity active={active} />
      <div className="host-metrics">
        <div><span className="metric-label">{s.deployment?.familyHosting ? 'Model families online' : 'Models online in this tab'}</span><strong id="host-online">{online.length}</strong></div>
        <div><span className="metric-label">Requests served · settled</span><strong id="host-served">{stats ? stats.requestsServed : '—'}</strong></div>
        <div><span className="metric-label">Earned · paid to your wallet</span><strong id="host-earned">{stats ? bnb(stats.earnedWei) : '—'}</strong></div>
      </div>
      {stats?.tokenEarnings && <ul>{Object.entries(stats.tokenEarnings).map(([token,units])=><li key={token}>{units} base units earned · token {token}</li>)}</ul>}
      {s.deployment?.familyHosting && <div id="family-activity"><h3>On-demand tasks</h3>
        {!s.familyTasks.length ? <p className="hint">Waiting for assigned tasks. Base models stay resident; descendant payloads are built only when needed.</p> : <ul>{s.familyTasks.map(t=><li key={t.taskId}>{t.mepId.slice(0,12)}… · {t.phase}{t.error ? ` · ${t.error}` : ''}{['journaled','replayed'].includes(t.phase) && <Button onClick={C.wrap(async()=>{await C.replayFamilyTask(t.taskId);C.log(`Replay verified: ${t.taskId}`);})}>Verify replay</Button>}</li>)}</ul>}
        <p className="hint">Verified task recipes and results are saved in this browser for replay. Do not clear site data while results remain challengeable. Automatic on-chain dispute responses are not enabled.</p>
      </div>}
      {asset?.key===key && <p className="hint">BNB tasks remain enabled. AIGG token: {asset.token}. <Button disabled={saving} onClick={C.wrap(toggleAsset)}>{asset.accepted?'Stop accepting new AIGG tasks':'Accept AIGG tasks'}</Button> Changing this applies to new assignments only.</p>}
      {assetError && <p className="hint">Token preference unavailable: {assetError}</p>}
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
