// The page's own documentation, for two readers who want different things and should not be made to read each other's.
//
//   "Playing"   somebody deciding whether to adopt, host or breed: what it costs, what it earns, what rarity means
//               here and why nobody can tell you before the runs exist.
//   "How it works"  somebody who wants the mechanism: the arithmetic the verification rests on, the fee, the dispute,
//               and the files to read next. It links into the repository rather than restating it badly.
//
// Every number here that could drift is read from the chain or from the files the page already loads -- the price of
// an adoption, the royalty, the count of founders -- so this view cannot quietly disagree with the rest of the page.
import { useEffect, useState } from "react";
import * as C from "../core/controller.js";
import * as F from "../core/flies.js";
import { Panel } from "./primitives.jsx";

const REPO = "https://github.com/jianmliu/aigg-bnb/blob/main";
const bnb = (wei) => { const s = (Number(wei) / 1e18).toFixed(5).replace(/0+$/, "").replace(/\.$/, ""); return s === "" ? "0" : s; };
const pct = (bps) => String(Math.round(bps) / 100);

export default function DocsView() {
  const [tab, setTab] = useState(() => (window.location.hash === "#/docs/how" ? "how" : "play"));
  const go = (t) => { setTab(t); history.replaceState(null, "", t === "how" ? "#/docs/how" : "#/docs"); };
  const s = C.state, f = s.flyTerms && !s.flyTerms.missing ? s.flyTerms : null; // a deployment without a collection has no prices to show
  // the prices are read when the page opens, not written into it: a document nobody re-reads is a document that goes stale
  useEffect(() => { if (s.deployment && !s.flyTerms) F.loadTerms().catch((e) => C.log("could not read the collection's terms: " + (e.message || e))); }, [s.deployment, s.flyTerms]);
  return (
    <div className="main single" id="docs">
      <section className="hero">
        <p className="kicker">Documentation</p>
        <h1>What this is, and <em>how it works</em>.</h1>
        <p className="lede">
          Two ways in. The first is for anyone thinking of adopting a fly, hosting a brain or breeding a line. The
          second is for anyone who wants to know what the verification actually rests on. Nothing in either is a
          promise: every number below is read from the chain or from published files, and where something has not been
          measured yet, it says so.
        </p>
        <div className="tabs" role="tablist">
          <button id="docsTabPlay" role="tab" aria-selected={tab === "play"} data-active={tab === "play"} onClick={() => go("play")}>Taking part</button>
          <button id="docsTabHow" role="tab" aria-selected={tab === "how"} data-active={tab === "how"} onClick={() => go("how")}>How it works</button>
        </div>
      </section>
      {tab === "play" ? <Playing s={s} f={f} /> : <HowItWorks s={s} f={f} />}
    </div>
  );
}

function Playing({ s, f }) {
  const ownerBps = f ? f.royaltyBps * (10000 - (f.baseShareBps || 0)) / 10000 : null;
  return (
    <div className="docs-body" id="docsPlay">
      <Panel title="What is here">
        <p>
          A <b>fly</b> is a real research subject: a variant of the FlyWire fruit-fly connectome, 139,255 neurons of it,
          written down as a recipe that anybody can apply to the published brain and get the same wiring, bit for bit.
          Adopting one makes that individual yours. It is not a picture with a number attached — the picture is drawn
          from its own id and encodes nothing about its worth.
        </p>
        <p>
          A <b>host</b> is a browser tab holding one of those brains in memory and proving, every epoch, that it is
          really there. When an experiment is run, the network draws hosts at random and pays the ones whose results
          agree.
        </p>
      </Panel>

      <Panel title="What it costs, and what comes back" note={f ? "read from the collection, now" : "connect to see this deployment's numbers"}>
        {f ? (
          <div className="terms-grid" id="docsCosts">
            <div className="kv"><span className="why">Adopt a founder</span><span className="amt">{bnb(f.mintPrice)} BNB</span></div>
            <div className="kv"><span className="why">…of which your own bond, and still yours</span><span className="amt">{bnb(f.mintBond)} BNB</span></div>
            <div className="kv"><span className="why">Breed two you hold</span><span className="amt">{bnb(f.breedFee)} BNB</span></div>
            <div className="kv"><span className="why">Your share of every fee paid for an experiment on your fly</span><span className="amt">{pct(ownerBps)}%</span></div>
            {f.baseShareBps > 0 && <div className="kv"><span className="why">…the rest of the {pct(f.royaltyBps)}% royalty goes to the base brain everybody varies</span><span className="amt">{pct(f.royaltyBps - ownerBps)}%</span></div>}
            {f.saleRoyaltyBps > 0 && <div className="kv"><span className="why">If you sell it on a marketplace that honours ERC-2981, to the treasury</span><span className="amt">{pct(f.saleRoyaltyBps)}%</span></div>}
          </div>
        ) : <p className="hint">The page reads these from the collection itself, so they are this deployment's and not a brochure's.</p>}
        <p className="fineprint">
          The adoption fee is not a donation and not a subscription: it is, almost exactly, what it costs the network to
          measure the individual it creates — thirteen stimuli, three seeds apiece, on two independent hosts. That is
          the deal. What you own afterwards is the individual and a claim on experiments other people run on it.
        </p>
      </Panel>

      <Panel title="Rarity, and why nobody can tell you yet" note="the one thing this page will not invent">
        <p>
          In most collections a trait is assigned at mint by a generator, and the rarity table exists before anything
          happens. Here there is no such table. <b>An individual's rarity is a measurement</b>: its brain is run through
          the standard battery, and its phenotypes — how much a named cell type fires under sound, whether the gate
          suppresses it, how far the activity spreads — are compared with the hundred founders.
        </p>
        <p>
          So a fly you bred a minute ago has <b>no</b> rarity. Not a low one: none, until somebody runs it. That is why
          the breeding fee is what it is, and why the Flies view says <i>“not measured yet”</i> rather than showing a
          score. When the runs exist, the same view says where it stands — <i>top 2% of the founders</i>, or
          <i> bottom 1%</i> — and anyone can recompute that from the published data.
        </p>
        <p className="fineprint">
          Two things worth knowing before you spend anything. Breeding is not a lottery — in the pilot, phenotypes were
          inherited well enough (realised heritability 0.77) that one generation of choosing parents left the high and
          low lines 2.09 founder standard deviations apart, so which two you pair matters. And earnings will be uneven:
          an individual nothing distinguishes attracts no experiments and will earn close to nothing. The scarce thing
          is a phenotype, not a token.
        </p>
      </Panel>

      <Panel title="Hosting: what you put in and what you can lose">
        <p>
          A tab downloads the brain, keeps it resident, and each epoch answers a challenge that can only be answered by
          a machine that really holds those weights. You also put down a bond{s.unit ? <> — <b>{bnb(s.unit)} BNB</b> a vote on this
          deployment</> : null}. When an experiment is drawn your way, you run it and submit a signed result; the fee is
          split between the hosts whose results agree.
        </p>
        <p className="fineprint">
          The bond is slashable if a result of yours loses a dispute, and returnable after the exit delay otherwise. The
          protocol never needs to trust you: the work is exact integer arithmetic, so two honest hosts on two different
          machines produce identical answers, and a dishonest one is provably wrong rather than merely outvoted.
        </p>
      </Panel>

      <Panel title="Where the money actually comes from" note="stated plainly, because it is unusual">
        <p>
          Today the experiments are the project's own: the atlas this network exists to produce. So a royalty you
          receive is, for now, funded by what adopters put in — a circle, not revenue. It opens when people outside pay
          for experiments, which is what the gateway is for, and that has not happened yet.
        </p>
        <p className="fineprint">
          The dataset itself is published free and always will be: every row is recomputable from a public recipe, and a
          thing anybody can recompute cannot be sold twice. What is paid for is what the dataset does <i>not</i> contain
          — a perturbation nobody has run, a pair of them, an individual bred after the atlas was built.
        </p>
      </Panel>
    </div>
  );
}

function HowItWorks({ s, f }) {
  const d = s.deployment;
  return (
    <div className="docs-body" id="docsHow">
      <Panel title="The claim, in one paragraph">
        <p>
          A result is trustworthy here because it is <b>reproducible bit for bit</b> and because independent parties with
          money at stake agreed on it. The execution kind is integer fixed point (<code>aigg:exec:int-lif:v1</code>), so
          sums are exact and order-independent: the same run on another machine, another core count, another kernel —
          even a GPU — gives the identical state. That is what makes redundancy meaningful, and it is the property a
          floating-point model does not have, which is why this protocol can verify a connectome simulation and cannot
          verify an LLM's output.
        </p>
      </Panel>

      <Panel title="The three names">
        <div className="terms-grid">
          <div className="kv"><span className="why"><b>aigg</b></span><span className="amt wide">the protocol: resident-weight proofs, sortition, redundancy, disputes</span></div>
          <div className="kv"><span className="why"><b>aigg-bnb</b></span><span className="amt wide">this deployment: contracts, relayer, page, gateway</span></div>
          <div className="kv"><span className="why"><b>FlyBnB</b></span><span className="amt wide">a dataset — the fly atlas being produced on it</span></div>
        </div>
        <p className="fineprint">The protocol's subject is any model whose arithmetic is exact. A mouse atlas would be another dataset, on the same protocol, with another name.</p>
      </Panel>

      <Panel title="What happens to one experiment">
        <ol className="steps">
          <li><b>Posted.</b> A client puts the task on chain with its fee: which brain, which stimulus set, which neurons are silenced, how many steps, and how many independent executors it wants.</li>
          <li><b>Drawn.</b> The chain picks those executors by sortition, weighted by bond, from the instances whose residency claim for that brain is current. The client cannot choose them, and nobody can volunteer.</li>
          <li><b>Run.</b> Each executor runs the model and commits to the state at fixed intervals — a Merkle root per segment — then signs the result.</li>
          <li><b>Settled.</b> Equal roots are paid; the fee splits between them, less the royalty, which the collection forwards to whoever owns the fly at that moment.</li>
          <li><b>Disputed.</b> Unequal roots open a bisection: the disagreement is narrowed segment by segment, step by step, to one neuron and finally to a single synapse term that the chain itself evaluates. The loser is slashed.</li>
        </ol>
      </Panel>

      <Panel title="What a call costs" note="one unit, one rate, every difference in the count">
        <p>
          A token is a fixed amount of work. A call is <code>steps × executors × the brain's factor × the stimulus
          set's factor</code> tokens, and the fee is that count times one rate. The factors are measured, not guessed:
          across the battery's thirteen stimuli a run spans <b>9.4×</b> — one that barely wakes the brain against one
          that ignites it — and the denser export costs <b>1.54×</b> the sparser one for the same number of steps.
        </p>
        <p className="fineprint">
          Putting those factors in the count rather than in the rate is what makes a bill exact: a platform charges
          price × tokens, so a factor that reaches the fee but not the count is one the gateway would pay for itself,
          and a factor applied to both would be charged twice. The gas of posting and settling is counted in the same
          unit, for the same reason.
        </p>
      </Panel>

      <Panel title="This deployment" note={d ? `chain ${d.chainId}` : "not connected"}>
        {d ? (
          <div className="terms-grid" id="docsDeployment">
            <div className="kv"><span className="why">Task market</span><span className="amt mono">{d.addresses.market}</span></div>
            <div className="kv"><span className="why">Instances (bonds, sortition)</span><span className="amt mono">{d.addresses.instances}</span></div>
            <div className="kv"><span className="why">Collection</span><span className="amt mono">{d.addresses.collection || "—"}</span></div>
            <div className="kv"><span className="why">Whitelist of collections</span><span className="amt mono">{d.addresses.whitelist || "—"}</span></div>
            <div className="kv"><span className="why">Brains served</span><span className="amt">{s.meps.length}</span></div>
            {d.challenge && <div className="kv"><span className="why">A settled result can be challenged for</span><span className="amt">{d.challenge.windowBlocks} blocks</span></div>}
          </div>
        ) : <p className="hint">Connect to read the addresses from the relayer rather than from this page.</p>}
      </Panel>

      <Panel title="Read the source">
        <ul className="links">
          <li><a href={`${REPO}/docs/DESIGN.md`} target="_blank" rel="noreferrer">DESIGN</a> — the chain-specific design, the parameters, and §5c on what the protocol scales to and why the line is the arithmetic.</li>
          <li><a href={`${REPO}/docs/TOKENOMICS.md`} target="_blank" rel="noreferrer">TOKENOMICS</a> — §9 is the measured cost of a run, who pays for the atlas, and the invariant that a mint must cover the measurement it creates.</li>
          <li><a href={`${REPO}/docs/GATEWAY.md`} target="_blank" rel="noreferrer">GATEWAY</a> — the OpenAI-compatible API in front of the mesh: what is sold, what is given away.</li>
          <li><a href={`${REPO}/docs/flybnb/proposal.md`} target="_blank" rel="noreferrer">The proposal</a> and <a href={`${REPO}/docs/flybnb/CREDIT.md`} target="_blank" rel="noreferrer">CREDIT</a> — the dataset, and who is named in it for what.</li>
          <li><a href={`${REPO}/flybnb/analysis/phenotype_rank.mjs`} target="_blank" rel="noreferrer">phenotype_rank.mjs</a> — how a fly's standing among the founders is computed, and the published files it writes.</li>
        </ul>
      </Panel>
    </div>
  );
}
