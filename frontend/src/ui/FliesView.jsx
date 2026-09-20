// The colony and the pairing (docs/BREEDING.md §6). A fly here is a lineage record first and a brain second, and
// the page says so at the one moment it matters: "Breed" produces a recipe, not an animal. What it can show that a
// trait card cannot is the egg -- one block after breeding the page already knows what the child will be, from the
// hash of its seed block, and says so while the chain catches up.
//
// No trait badges anywhere: what a fly is gets measured by experiments against it, not declared at birth.
import { useState } from "react";
import { formatEther, formatUnits } from "viem";
import * as C from "../core/controller.js";
import * as F from "../core/flies.js";
import { loadPhenotypes, phenotypesOf, standing } from "../core/phenotypes.js";
import { Panel, Button } from "./primitives.jsx";
import { Portrait } from "./Portrait.jsx";
import { SOLO } from "./mode.js";

// what reaches the owner, in basis points of the FEE: the royalty, less the base's part of it. Shown as it is, never rounded up
const ownerBps = (f) => f.royaltyBps * (10000 - (f.baseShareBps || 0)) / 10000; const pct = (bps) => String(Math.round(bps) / 100);
const bnb = (wei) => formatEther(wei);
const STAGE = {
  egg: { tone: "idle", text: "egg" },
  unborn: { tone: "wait", text: "unborn · needs gestation" },
  unregistered: { tone: "idle", text: "born · no MEP yet" },
  registered: { tone: "ok", text: "registered" },
};

/** What the battery measured about this individual, and where that puts it among the hundred founders. Nothing is
 *  invented: a fly whose runs do not exist has no line here, and says so, because that is the state of the world
 *  until somebody runs its battery. */
function Phenotypes({ fly, stage }) {
  const p = stage === "egg" || stage === "unborn" ? null : phenotypesOf(fly.deltaHash);
  if (!p) return (
    <div className="pheno" id={`pheno-${fly.id}`}>
      <span className="counts">{stage === "egg" ? "an egg has no phenotype: it has no seed yet, so there is nothing to run"
        : "not measured yet — running its battery (13 stimuli × 3 seeds) is what says whether it is unusual"}</span>
    </div>);
  return (
    <div className="pheno" id={`pheno-${fly.id}`}>
      <span className="counts">{p.standout.length ? `${p.standout.length} of ${p.phenotypes} phenotypes stand out among the founders` : `${p.phenotypes} phenotypes measured, none unusual`}</span>
      {p.standout.slice(0, 4).map((r) => { const s = standing(r.percentile); return (
        <div className="kv" key={r.name}><span className="why">{r.name}</span>
          <span className="amt" data-tone={s.high ? "high" : "low"}>{r.value} · {s.text}</span></div>); })}
    </div>);
}

function FlyCard({ fly, byId, slot, onPick }) {
  const stage = F.stageOf(fly); const st = STAGE[stage]; const left = F.blocksLeft(fly);
  const pickable = F.canBreed(fly);
  return (
    <div className="brain fly" data-active={!!slot} data-dim={!fly.mine} role={pickable ? "button" : undefined} tabIndex={pickable ? 0 : undefined}
         id={`fly-${fly.id}`} onClick={pickable ? onPick : undefined}
         onKeyDown={(e) => { if (pickable && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); onPick(); } }}>
      {/* an egg is drawn as an egg; everything else from what pins it -- its delta, or until it has one, its seed */}
      <div className="photo"><Portrait egg={stage === "egg"} seed={stage === "egg" ? "0x" + fly.seedBlock.toString(16).padStart(16, "0") : stage === "unborn" ? fly.seed : fly.deltaHash} label={`portrait of fly #${fly.id}`} /></div>
      <div className="about">
      <div className="name">
        <span>{F.lineage(fly, byId)}</span>
        {slot && <span className="exec">{slot}</span>}
      </div>
      <div className="counts">
        {stage === "egg" ? `seed block ${fly.seedBlock}` : stage === "unborn" ? `seed ${fly.seed.slice(0, 12)}… · no delta yet` : `delta ${fly.deltaHash.slice(0, 12)}…`} · base {fly.baseModelId.slice(0, 10)}…{fly.mine ? "" : " · not yours"}
      </div>
      <div className="state" data-tone={st.tone}>{st.text}</div>
      <Phenotypes fly={fly} stage={stage} />
      {fly.pending > 0n && (
        <div className="egg" id={`royalty-${fly.id}`}>
          <div className="foot"><span className="counts">{bnb(fly.pending)} BNB earned, not yet settled to {fly.mine ? "you" : "its owner"}</span>
            <Button id={`btnSettle-${fly.id}`} tone="money" onClick={(e) => { e.stopPropagation(); C.wrap(() => F.settle(fly.id))(); }} title="Moves it to the owner's credit. Anyone may press this; the money goes to the owner either way">Settle</Button></div>
        </div>
      )}
      {stage === "egg" && (
        <div className="egg" id={`egg-${fly.id}`}>
          {fly.preview
            ? <span className="will">will be <b>{F.sexMark(fly.preview.sex)}</b> · seed {fly.preview.seed.slice(0, 12)}… · on-chain once hatched</span>
            : left > 0 ? <span className="will">waiting for block {fly.seedBlock}…</span> : null}
          {left > 0
            ? <div className="foot"><span className="counts">{left} blocks left to hatch</span>
                <Button id={`btnHatch-${fly.id}`} tone="chain" disabled={!fly.preview} onClick={C.wrap(() => F.hatch(fly.id))} title="Anyone may hatch; whoever does is paid the bounty">Hatch</Button></div>
            : <div className="foot"><span className="counts" style={{ color: "var(--pink)" }}>seed block expired unhatched</span>
                <Button id={`btnRearm-${fly.id}`} tone="money" onClick={C.wrap(() => F.rearm(fly.id))} title="A new block is a new draw, priced like the breeding it replaces">Re-arm</Button></div>}
        </div>
      )}
      </div>
    </div>
  );
}

export default function FliesView() {
  const s = C.state; const flies = s.flies;
  const [breeding, setBreeding] = useState(false); const [dam, setDam] = useState(null); const [sire, setSire] = useState(null);

  if (!s.deployment) return <div className="main single"><Panel title="Flies"><p className="hint">{SOLO ? "Connecting to the network…" : <>Put a relayer’s address in the <b>Mesh</b> capsule above first: it names the collection this page reads.</>}</p></Panel></div>;
  if (!flies) return <div className="main single"><Panel title="Flies"><div className="row tight"><Button id="btnFlies" tone="chain" onClick={C.wrap(F.loadFlies)}>Load the colony</Button></div></Panel></div>;
  if (flies.missing) return <div className="main single"><Panel title="Flies"><p className="hint" id="noCollection">This deployment names no collection (the relayer has no <code>PORW_COLLECTION</code>), so there are no flies to read here.</p></Panel></div>;

  const byId = new Map(flies.all.map((f) => [f.id, f]));
  const mine = flies.all.filter((f) => f.mine); const others = flies.all.length - mine.length;
  const pick = (f) => { if (f.sex === F.FEMALE) setDam(dam === f.id ? null : f.id); else setSire(sire === f.id ? null : f.id); };
  const D = byId.get(dam), S = byId.get(sire); const problem = F.checkPair(D, S) || flies.battery?.error || (flies.battery?.tokenMode&&!flies.battery.quote?"get a BNB quote first":null);

  return (
    <div className="main single">
      <section className="hosthead">
        <p className="kicker">Your flies</p>
        <h2>A colony, and its pedigree.</h2>
        <p className="lede">Each individual is a real variant of a released brain. What one is worth is what has been measured about it — so there are no trait badges here, only lineage, and the experiments run against it.</p>
      </section>
      <Panel title="Colony" note={`${mine.length} yours · ${others} others`}>
        <div className="row tight center">
          <Button id="btnFlies" tone="chain" onClick={C.wrap(F.loadFlies)}>Refresh</Button>
          <span className="kv" id="fliesInfo">collection {flies.address.slice(0, 10)}… · block {flies.block}{s.wallet ? "" : " · connect your wallet (top right) to see which are yours"}</span>
        </div>
        {flies.royaltyBps > 0 && (
          <div className="row tight center" id="royaltyBar">
            <span className="kv strong" id="owed">{pct(ownerBps(flies))}% of every fee paid for an experiment on your flies is yours{flies.baseShareBps > 0 ? ` (a ${pct(flies.royaltyBps)}% royalty, of which ${pct(flies.baseShareBps)}% is the base brain’s)` : ""} · credited to you: {bnb(flies.owed)} BNB</span>
            <Button id="btnWithdraw" tone="money" disabled={!s.wallet || flies.owed === 0n} onClick={C.wrap(F.withdraw)}>Withdraw</Button>
          </div>
        )}
        {flies.all.length === 0 && <p className="hint">Nobody has adopted a fly from this collection yet.</p>}
        <div className="brains" id="colony">
          {flies.all.map((f) => <FlyCard key={f.id} fly={f} byId={byId} slot={f.id === dam ? "dam" : f.id === sire ? "sire" : null} onPick={() => pick(f)} />)}
        </div>
        {flies.truncated && <p className="hint">Showing the first 500 individuals; the rest need an indexer.</p>}
        <p className="hint">Click a fly of yours to put it in the pairing below. An egg or an unborn child cannot breed: its delta is not pinned yet.</p>
      </Panel>

      <Panel title="Adopt" note="treasury inventory · existing NFTs">
        <p className="lede">Adopt a fly already held by the AIGG treasury. Your BNB payment and the NFT transfer complete together. You receive the individual and its future holder rights; earnings accrued before transfer remain with the seller.</p>
        <p className="hint" id="adoptFee">The full listed price goes to the selling treasury. No Host bond, additional marketplace royalty, or liquidity deposit is included. Host participation requires a separate bond. Treasury liquidity management happens separately.</p>
        <Button id="btnGenesis" tone="chain" onClick={C.wrap(F.loadGenesis)}>Refresh treasury inventory</Button>
        {flies.sale?.unavailable && <p className="hint" role="status">{flies.sale.unavailable}</p>}
        {flies.sale?.treasury && <p className="hint">Seller / BNB recipient: <code>{flies.sale.treasury}</code></p>}
        {flies.sale && !flies.sale.unavailable && !flies.sale.open.length && <p className="hint">No treasury NFTs are currently available for adoption.</p>}
        <div className="listings adoptable" id="adoptable">
          {flies.sale?.open.map((g, i) => (
            <div className="brain listing" key={g.id} style={{ "--i": i }}>
              <div className="photo"><Portrait seed={g.deltaHash} label={`portrait of fly #${g.id}`} /></div>
              <div className="about">
                <div className="name"><span>fly #{g.id} {F.sexMark(g.sex)}</span><span className="exec">gen {g.generation}</span></div>
                <div className="counts">Listing expires {new Date(Number(g.expiresAt) * 1000).toLocaleString()}</div>
                <Button id={`btnAdopt-${g.id}`} tone="money" disabled={!s.wallet || !s.chainOk || g.pending || s.wallet?.toLowerCase() === flies.sale.treasury.toLowerCase()} onClick={C.wrap(() => F.adopt(g.id))}>{g.pending ? "Adoption pending…" : `Adopt · ${bnb(g.price)} BNB`}</Button>
              </div>
            </div>
          ))}
        </div>
        {flies.truncated && <p className="hint">Inventory checks cover the first 500 collection tokens. Additional inventory requires an indexer.</p>}
      </Panel>

      <Panel title="Breed" note="a recipe, not yet a brain">
        <div className="pairing">
          <div className="slot" data-filled={!!D} id="slotDam"><span className="legend">dam ♀</span>{D ? F.lineage(D, byId) : "—"}</div>
          <span className="times">×</span>
          <div className="slot" data-filled={!!S} id="slotSire"><span className="legend">sire ♂</span>{S ? F.lineage(S, byId) : "—"}</div>
        </div>
        <div className="kv" id="breedBase">
          {D ? `the child varies the dam's base ${D.baseModelId.slice(0, 14)}… (${D.baseModelId === flies.baseFemale ? "female" : D.baseModelId === flies.baseMale ? "male" : "unknown"} base) — one base, chosen by a rule, never a blend of two`
             : "the child will vary the dam's base — one base, never a blend of two"}
        </div>
        <dl className="fees" id="breedFee">
          <dt>breed fee</dt><dd className="amt">{bnb(flies.breedFee)} BNB</dd><dd className="why">collection fee, separate from the locked battery budget</dd>
          <dt className="part">hatch bounty</dt><dd className="amt">{bnb(flies.bounty)} BNB</dd><dd className="why">held by the collection, paid to whoever hatches the child</dd>
          <dt className="part">treasury</dt><dd className="amt">{bnb(flies.breedFee - flies.bounty)} BNB</dd><dd className="why">the relayer’s sponsorship budget</dd>
        </dl>
        {s.deployment.addresses.tokenBatteryBudget && <label>Host settlement <select id="batteryRoute" value={s.batteryRoute||'native'} disabled={breeding} onChange={e=>C.wrap(()=>F.selectBatteryRoute(e.target.value))()}><option value="native">BNB tasks</option><option value="token">AIGG tasks · pay BNB</option></select></label>}
        {flies.battery?.address && (flies.battery.tokenMode ? <div className="hint" id="batteryQuote">
          Battery budget: {formatUnits(flies.battery.budget,flies.battery.decimals)} AIGG ({flies.battery.paymentToken}). Unused execution reserves are refunded in AIGG.
          <Button id="btnBatteryQuote" disabled={breeding} onClick={C.wrap(F.quoteBattery)}>Get BNB quote</Button>
          {flies.battery.quote && <p>Maximum total: {bnb(flies.breedFee+flies.battery.quote.maxInput)} BNB plus gas · 1% swap slippage limit · quote valid for 10 minutes. Excess BNB is returned.</p>}
        </div> : <p className="hint" id="batteryQuote">Battery budget: {bnb(flies.battery.budget)} BNB locked in a dedicated job. Total: {bnb(flies.breedFee + flies.battery.budget)} BNB plus wallet transaction gas. Parent approvals may require separate transactions.</p>)}
        <div className="row tight center">
          <Button id="btnBreed" tone="money" disabled={!s.wallet || !!problem || breeding}
                  onClick={C.wrap(async () => { setBreeding(true); try { await F.breed(dam, sire); setDam(null); setSire(null); } finally { setBreeding(false); } })}>Breed + fund battery</Button>
          <span className="kv empty" id="breedProblem">{!s.wallet ? "connect your wallet (top right)" : problem || "ready"}</span>
        </div>
        <p className="hint">This creates the child’s lineage entry; it does not yet create its brain. The child’s seed — and its sex — is the hash of the block after this transaction, so nobody, including you, knows it when you press the button. The page shows it a block later; the chain records it when someone calls <code>hatch</code> (the relayer’s keeper does, for the bounty). After that the brain still has to be computed from the parents and the seed, and registered.</p>
      </Panel>
      <Panel title="Battery queue" note="funded experiments · rarity waits for measured results">
        <Button onClick={C.wrap(F.loadBattery)}>Refresh battery status</Button>
        {flies.battery?.error && <p className="hint">{flies.battery.error}</p>}
        {flies.all.map(f => {const j=flies.battery?.jobs?.[f.id];return <div key={f.id} className="row tight">
          <span>Fly #{f.id}: {j?.status || "not funded"}</span>
          {!j && f.mine && flies.battery?.address && !flies.battery.tokenMode && <Button onClick={C.wrap(()=>F.fundBattery(f.id))}>Fund battery · {bnb(flies.battery.budget)} BNB</Button>}
          {j?.artifactUrl && <a href={j.artifactUrl} target="_blank" rel="noreferrer">Experiment results</a>}
          {j?.refund && j.payer.toLowerCase()===s.wallet?.toLowerCase() && <Button onClick={C.wrap(()=>F.refundBattery(f.id))}>Recover unused budget</Button>}
        </div>;})}
        <p className="hint">Model generation and owner registration must finish before execution. Completion requires verified battery outputs; a rarity percentile additionally needs a versioned reference cohort. Expired, inactive jobs and completed jobs can return unused funds to the original payer.</p>
      </Panel>
    </div>
  );
}
