// The colony and the pairing (docs/BREEDING.md §6). A fly here is a lineage record first and a brain second, and
// the page says so at the one moment it matters: "Breed" produces a recipe, not an animal. What it can show that a
// trait card cannot is the egg -- one block after breeding the page already knows what the child will be, from the
// hash of its seed block, and says so while the chain catches up.
//
// No trait badges anywhere: what a fly is gets measured by experiments against it, not declared at birth.
import { useState } from "react";
import * as C from "../core/controller.js";
import * as F from "../core/flies.js";
import { Panel, Button } from "./primitives.jsx";
import { Portrait } from "./Portrait.jsx";

const bnb = (wei) => { const s = (Number(wei) / 1e18).toFixed(5).replace(/0+$/, "").replace(/\.$/, ""); return s === "" ? "0" : s; };
const STAGE = {
  egg: { tone: "idle", text: "egg" },
  unborn: { tone: "wait", text: "unborn · needs gestation" },
  unregistered: { tone: "idle", text: "born · no MEP yet" },
  registered: { tone: "ok", text: "registered" },
};

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
  const [dam, setDam] = useState(null); const [sire, setSire] = useState(null);

  if (!s.deployment) return <div className="main single"><Panel title="Flies"><p className="hint">Put a relayer’s address in the <b>Mesh</b> capsule above first: it names the collection this page reads.</p></Panel></div>;
  if (!flies) return <div className="main single"><Panel title="Flies"><div className="row tight"><Button id="btnFlies" tone="chain" onClick={C.wrap(F.loadFlies)}>Load the colony</Button></div></Panel></div>;
  if (flies.missing) return <div className="main single"><Panel title="Flies"><p className="hint" id="noCollection">This deployment names no collection (the relayer has no <code>PORW_COLLECTION</code>), so there are no flies to read here.</p></Panel></div>;

  const byId = new Map(flies.all.map((f) => [f.id, f]));
  const mine = flies.all.filter((f) => f.mine); const others = flies.all.length - mine.length;
  const pick = (f) => { if (f.sex === F.FEMALE) setDam(dam === f.id ? null : f.id); else setSire(sire === f.id ? null : f.id); };
  const D = byId.get(dam), S = byId.get(sire); const problem = F.checkPair(D, S);

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
        {flies.all.length === 0 && <p className="hint">Nobody has adopted a fly from this collection yet.</p>}
        <div className="brains" id="colony">
          {flies.all.map((f) => <FlyCard key={f.id} fly={f} byId={byId} slot={f.id === dam ? "dam" : f.id === sire ? "sire" : null} onPick={() => pick(f)} />)}
        </div>
        {flies.truncated && <p className="hint">Showing the first 500 individuals; the rest need an indexer.</p>}
        <p className="hint">Click a fly of yours to put it in the pairing below. An egg or an unborn child cannot breed: its delta is not pinned yet.</p>
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
          <dt>breed fee</dt><dd className="amt">{bnb(flies.breedFee)} BNB</dd><dd className="why">what the button sends</dd>
          <dt className="part">hatch bounty</dt><dd className="amt">{bnb(flies.bounty)} BNB</dd><dd className="why">held by the collection, paid to whoever hatches the child</dd>
          <dt className="part">treasury</dt><dd className="amt">{bnb(flies.breedFee - flies.bounty)} BNB</dd><dd className="why">the relayer’s sponsorship budget</dd>
        </dl>
        <div className="row tight center">
          <Button id="btnBreed" tone="money" disabled={!s.wallet || !!problem}
                  onClick={C.wrap(async () => { await F.breed(dam, sire); setDam(null); setSire(null); })}>Breed</Button>
          <span className="kv empty" id="breedProblem">{!s.wallet ? "connect your wallet (top right)" : problem || "ready"}</span>
        </div>
        <p className="hint">This creates the child’s lineage entry; it does not yet create its brain. The child’s seed — and its sex — is the hash of the block after this transaction, so nobody, including you, knows it when you press the button. The page shows it a block later; the chain records it when someone calls <code>hatch</code> (the relayer’s keeper does, for the bounty). After that the brain still has to be computed from the parents and the seed, and registered.</p>
      </Panel>
    </div>
  );
}
