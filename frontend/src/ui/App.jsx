// flybnb: a bed-and-breakfast for fruit-fly brains, organised on BNB Chain.
//
// The borrowed shape is deliberate, because the product really is that shape. A brain is a LISTING. Whoever holds
// one resident in a browser tab and proves it every epoch is its HOST, and puts down a deposit (the bond) to be
// one. An experiment is a BOOKING against a listing, paid to the hosts that ran it -- and for now every booking is
// the FlyBnB dataset's own: third-party experiments are not open yet, and the booking card says so instead of offering one. So the page has the three
// places that kind of site has: Brains (browse the listings, open one, book an experiment on it), Host (the four
// things it takes to become one, then the running node) and Flies (the individuals you own, and breeding) -- and a
// fourth, Paper, which is what all of it is for: the FlyBnB atlas, its dataset, and the holders it acknowledges. The
// capsule in the header is "where": which mesh -- which relayer -- all of it is read from.
//
// What is NOT borrowed is any softness about what is happening. Every technical word is still on the page next to
// its friendly one (deposit = bond, house key = session key), and every number is still the chain's.
//
// The strings written into #dep, #epoch, #wallet, #bond, #session, #mepInfo, #mepStatus and #model are the same
// ones the old page assigned to those elements by hand. They are rendered here instead, but the ids and the text
// are part of the contract the end-to-end test reads, so they are kept verbatim.
import { useEffect, useState } from "react";
import * as C from "../core/controller.js";
import { useNodeState } from "../core/store.js";
import { hex } from "../core/abi.js";
import { Panel, Field, Button, Chip, Pill } from "./primitives.jsx";
import { BrainCard } from "./BrainCard.jsx";
import HostDashboard from "./HostDashboard.jsx";
import FliesView from "./FliesView.jsx";
import { BAKED_RELAYER, SOLO } from "./mode.js";
import FlyBnbView, { FlyBnbBanner } from "./FlyBnbView.jsx";
import DocsView from "./DocsView.jsx";

const bnb = (wei) => (Number(wei) / 1e18).toFixed(4);
const unitBnb = (wei) => (Number(wei) / 1e18).toFixed(6).replace(/0+$/, "").replace(/\.$/, ""); // 0.05, 0.005: an amount somebody types back in

// Where the page points on first load. Locally that is a relayer on this machine; a deployed build gets
// VITE_RELAYER_URL baked in, because `http://127.0.0.1:8788` on an https origin is blocked as mixed content
// before it is anything else. The field stays editable either way -- pointing the page at your own relayer is
// the whole reason the relayer is replaceable.
const DEFAULT_RELAYER = BAKED_RELAYER || "http://127.0.0.1:8788";

/** the mark: a fly's head from the front -- two red eyes, a gold brain between them. The portraits are this, grown up */
function Logo() {
  return (
    <svg width="30" height="30" viewBox="0 0 32 32" aria-hidden="true">
      <ellipse cx="16" cy="17" rx="8.5" ry="9.5" fill="var(--gold)" />
      <path d="M16 8.5v17" stroke="var(--text)" strokeOpacity="0.35" strokeWidth="1" />
      <ellipse cx="6.5" cy="16" rx="5.5" ry="8" fill="var(--eye)" />
      <ellipse cx="25.5" cy="16" rx="5.5" ry="8" fill="var(--eye)" />
      <ellipse cx="5" cy="12.5" rx="1.4" ry="2.4" fill="#fff" opacity="0.5" transform="rotate(-20 5 12.5)" />
      <ellipse cx="27" cy="12.5" rx="1.4" ry="2.4" fill="#fff" opacity="0.5" transform="rotate(20 27 12.5)" />
    </svg>
  );
}

// the docs view keeps its own tab in the hash (#/docs, #/docs/how) so a link can land on either audience's half
const VIEWS = { "#/host": "host", "#/flies": "flies", "#/flybnb": "flybnb", "#/docs": "docs", "#/docs/how": "docs" };
const viewOf = () => VIEWS[window.location.hash] || "stay";

/** the one-line health of the whole page, in the order things go wrong */
function status(s) {
  if (s.wallet && !s.chainOk) return { tone: "bad", text: "wrong chain" };
  if (s.node) return { tone: "live", text: `live · ${s.node.models.size} resident` };
  if (s.delegation) return { tone: "ready", text: "ready to start" };
  if (s.wallet) return { tone: "warn", text: "no session key" };
  if (s.deployment) return { tone: "ready", text: "online" }; // a visitor needs no wallet to look around
  return SOLO ? { tone: "warn", text: s.errors.length ? "relayer unreachable · retrying" : "connecting…" } : { tone: null, text: "no mesh loaded" };
}

const toneOfLine = (line) => (!line ? null : /ERROR|FAIL|REVERT|DOES NOT MATCH/.test(line) ? "bad" : /WARNING|note:/.test(line) ? "warn" : /\bok\b|confirmed|running|resident|matches/.test(line) ? "ok" : null);

export default function App() {
  useNodeState();
  const s = C.state; const hasCollection = !!s.deployment?.addresses?.collection;
  const active = C.mepById(s.active);

  // hosting capacity: controlled, because the memory projection under the model line reprices as it is typed
  const [steps, setSteps] = useState("100");
  const stepsNum = Number(steps);

  // the task form. Separate from the capacity above: this is what a task asks for, that is what the tab can hold.
  const [scene, setScene] = useState(String(C.SCENES[0].id));
  const [taskSteps, setTaskSteps] = useState("3");
  const [taskStride, setTaskStride] = useState("1");
  const [taskRedundancy, setTaskRedundancy] = useState("1");
  const [taskFee, setTaskFee] = useState("0.01");
  const [taskDeadline, setTaskDeadline] = useState("50");

  // Three views, one page; the hash is the route, so a link to #/host or #/flies works. Brains and Host are hidden
  // rather than unmounted -- the controller writes into #log and reads #amount, #steps, #url and the rest whichever
  // view is showing, and a running node must not lose its console because someone went to look at the listings.
  const [view, setView] = useState(viewOf);
  useEffect(() => { const on = () => setView(viewOf()); window.addEventListener("hashchange", on); return () => window.removeEventListener("hashchange", on); }, []);

  // the MEP's gnfd:// pointer plus an SP endpoint is a fetchable URL; fill the box rather than make anyone paste it
  useEffect(() => { C.autofillUrl(); }, [s.active]);
  // after the first commit, not before: #relayer and #log have to exist before anything drives the page
  useEffect(() => { window.__ready = true; }, []);
  // A deployed build knows its mesh (VITE_RELAYER_URL is baked in), so it opens it: a visitor who lands on the site
  // should see the brains, not an empty shelf and "offline" until they find the arrow. A local build does not -- its
  // default is a relayer on this machine that may not be running, and the tests point the field somewhere else first.
  useEffect(() => {
    if (!SOLO) return; let live = true;
    (async () => { while (live && !C.state.deployment) { await C.wrap(C.loadDeployment)(); if (live && !C.state.deployment) await new Promise((r) => setTimeout(r, 5000)); } })();
    return () => { live = false; };
  }, []);
  // the entrance plays once. A view that is hidden and shown again would otherwise replay it on every tab switch
  // (a CSS animation restarts when display leaves `none`), and the listings would blink out each time
  const [entered, setEntered] = useState(false);
  useEffect(() => { const t = setTimeout(() => setEntered(true), 1500); return () => clearTimeout(t); }, []);

  const e = s.epochInfo;
  const st = status(s);
  const hostedIds = [...s.hosted];
  // a capacity the page would refuse buys no memory, so it projects none rather than pricing a nonsense number
  const validSteps = Number.isInteger(stepsNum) && stepsNum >= 1;
  const projected = validSteps
    ? hostedIds.filter((id) => s.prepared.has(id)).reduce((n, id) => n + C.brainBytes(C.mepById(id), stepsNum), 0)
    : 0;
  const claimsNow = e ? hostedIds.filter((id) => s.claims[id]?.[e.epoch]).length : 0;

  const loaded = active && s.loaded[active.mepId];
  const cost = loaded && validSteps ? ` · ~${C.MB(C.brainBytes(active, stepsNum))} resident at ${stepsNum} steps` : "";
  const modelText = !active ? "—"
    : loaded ? `${loaded.name}: ${loaded.neurons} neurons, ${loaded.synapses} synapses, model_id ${loaded.modelId.slice(0, 14)}… (${loaded.ok ? "matches the MEP" : "DOES NOT MATCH the MEP's model_id"})${cost}`
    : "not loaded";

  const taskProblem = C.checkTask(active, { steps: Number(taskSteps), commitStride: Number(taskStride), redundancy: Number(taskRedundancy) });

  const on = (fn) => C.wrap(fn);

  const short = (a) => a.slice(0, 6) + "…" + a.slice(-4);
  // Third-party experiments are not open yet: every task on the network is one the FlyBnB dataset needs, posted by the
  // project, and the relayer says so (`taskClients`: whose tasks it sponsors; null = anybody's, as on a local mesh). The
  // market is permissionless and the page cannot stop anybody posting -- but it does not offer what nothing will run.
  const taskClients = s.deployment?.taskClients || null;
  const bookingOpen = !taskClients || (!!s.wallet && taskClients.includes(s.wallet));
  const feeNum = Number(taskFee); const hostsNum = Number(taskRedundancy);

  return (
    <div className="shell" data-entered={entered}>
      <header className="topbar" data-solo={SOLO}>
        <a className="brand" href="#/" aria-label="flybnb — home">
          <Logo />
          <span className="word">fly<b>bnb</b></span>
        </a>

        {/* "where": the mesh everything on the page is read from. A form, so Enter in the field loads it too. A deployed
            page has one relayer and no choice to offer, so the capsule is not shown; the field stays in the document
            because the controller reads the relayer's address from it */}
        <form className="where" hidden={SOLO} onSubmit={(ev) => { ev.preventDefault(); on(C.loadDeployment)(); }}>
          <label htmlFor="relayer">Mesh</label>
          <input id="relayer" type="text" defaultValue={DEFAULT_RELAYER} placeholder="https://relayer.example.org" spellCheck={false} />
          <button id="btnDep" type="submit" className="go" aria-label="Load deployment" title="Load this mesh">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M3 8h9M8.5 4l4 4-4 4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>
          </button>
        </form>

        <nav className="views" aria-label="Sections">
          <a id="navStay" href="#/" data-active={view === "stay"}>Brains</a>
          <a id="navHost" href="#/host" data-active={view === "host"}>Host</a>
          <a id="navFlies" href="#/flies" data-active={view === "flies"}>Flies</a>
          <a id="navFlyBnb" href="#/flybnb" data-active={view === "flybnb"}>Paper</a>
          <a id="navDocs" href="#/docs" data-active={view === "docs"}>Docs</a>
        </nav>

        <div className="me">
          <Pill tone={st.tone}>{st.text}</Pill>
          <Button id="btnConnect" tone={s.wallet ? undefined : "money"} onClick={on(C.connect)} disabled={!s.deployment || s.walletConnecting}>
            {s.walletConnecting ? "Connecting…" : s.wallet ? short(s.wallet) : "Connect wallet"}
          </Button>
        </div>
      </header>
      {(s.walletConnecting || s.walletError) && <div className="wallet-notice" role={s.walletError ? "alert" : "status"}>
        {s.walletError || `Open ${s.walletName || "your wallet"} to approve the connection. If no popup appears, open the extension from your browser toolbar.`}
      </div>}


      <div className="strip">
        <div className="telemetry">
          <Chip k="epoch" v={e ? e.epoch : "—"} tone="cyan" />
          <Chip k="block" v={e ? e.block : "—"} />
          <Chip k="beacon" v={e ? (e.rolled ? "rolled" : e.lazy && !e.warm ? "cold" : "pending") : "—"} tone={e?.rolled ? "green" : "amber"} />
          <Chip k="brains" v={`${s.node ? s.node.models.size : 0}/${hostedIds.length || 0}`} tone="green" title="resident on the node / chosen to host" />
          <Chip k="resident" v={s.node ? C.MB(s.node.memoryBytes) : projected ? `~${C.MB(projected)}` : "—"} tone={s.node ? "green" : undefined} title="wasm memory the hosted brains hold" />
          <Chip k="claims" v={claimsNow} tone={claimsNow ? "green" : undefined} title="claims announced this epoch" />
        </div>
        <div className="mesh">
          <div id="dep" className={`kv ${s.deployment ? "" : "empty"}`}>
            {s.deployment ? `chain ${s.deployment.chainId} · claims ${s.deployment.addresses.claims.slice(0, 10)}… · relay ${s.deployment.relay} · ${s.meps.length} MEP(s)` : "—"}
          </div>
          <div id="epoch" className={`kv ${e ? "" : "empty"}`}>
            {e ? `epoch ${e.epoch} · block ${e.block} · beacon ${e.rolled ? "rolled" : e.lazy && !e.warm ? "cold (waking up)" : "pending"}` : "—"}
          </div>
        </div>
      </div>

      {view !== "flybnb" && view !== "docs" && <FlyBnbBanner />}
      {view === "flies" && <FliesView />}
      {view === "flybnb" && <FlyBnbView />}
      {view === "docs" && <DocsView />}

      {/* ---------------- Brains: the listings, and booking an experiment on one ---------------- */}
      <div className="main stay" hidden={view !== "stay"}>
        <section className="hero">
          <p className="kicker">A bed &amp; breakfast for fruit-fly brains · on BNB Chain</p>
          <h1>Take part in <em>open brain research</em>.</h1>
          <p className="lede">Adopt a fly or breed a new individual to participate in the <a href="#/flybnb">FlyBnB research atlas</a>. What you buy is an opportunity to take part in research, a contribution others can verify, and potential revenue rights under the applicable terms.</p>
          <p className="hint"><b>Independent research. Shared technology.</b> FlyBnB uses AIGG’s open model infrastructure and code support. Its proposed project token is <b>FLYBNB</b>, with a separate treasury and project governance. AIGG does not issue a platform token under this design.</p>
          <p className="hint">Browser hosts provide the compute. Your NFT connects you to a specific brain, its lineage and the experiments run on it. Published results make the research useful to everyone; paid experiments may create royalties for eligible holders.</p>
        </section>

        {/* Two ways to take part, and what each one really pays today. The owner's royalty is in the contracts --
            aigg-porw's MEP terms set a share of every settled fee aside, and FlyCollection forwards it to whoever owns
            the token -- and whether a collection is deployed on THIS network is something the relayer says, so the
            card says what is true here. A page about money that is vague about which parts exist is the one thing
            this page may not be. */}
        <section className="ways">
          <article className="way">
            <span className="badge" data-tone="live">live on-chain</span>
            <h3>Host a brain, earn for the work</h3>
            <p>You bring a tab’s memory and a BNB deposit. Each epoch your tab proves the brain is resident; when sortition draws you for an experiment and your result agrees with the other hosts’, its fee is split between you.</p>
            <dl className="terms">
              <dt>You put in</dt><dd id="unitLine">compute · a bond of {s.unit ? unitBnb(s.unit) : "…"} BNB per vote</dd>
              <dt>You are paid</dt><dd>your share of each experiment’s fee, at settlement</dd>
              <dt>You can lose</dt><dd>the bond, if a result of yours loses a dispute</dd>
            </dl>
            <a className="btn" data-tone="money" href="#/host">Become a host</a>
          </article>
          <article className="way">
            {hasCollection
              ? <span className="badge" data-tone="live" id="collectionBadge">collection on-chain · adoption requires listed inventory</span>
              : <span className="badge" data-tone="soon" id="collectionBadge">royalty: in the contracts · no collection deployed yet</span>}
            <h3>Adopt a fly. Be part of its research.</h3>
            <p>Adopt an existing individual from treasury inventory, or breed a new one from a pair you hold and fund its standard battery of experiments. Your participation connects funding to a named research subject and the work needed to study it.</p>
            <dl className="terms">
              <dt>Participate</dt><dd>Support open brain research through an individual you adopt or a new lineage you breed.</dd>
              <dt>Verify your contribution</dt><dd>Trace ownership and lineage on-chain, and inspect task receipts and published results as experiments are completed.</dd>
              <dt>Potential revenue rights</dt><dd>The applicable contracts define your share of paid experiments on your fly. Royalties depend on actual use and fees; no income is guaranteed.</dd>
              <dt>You put in</dt><dd>the listed adoption price, or the breeding fee plus its battery budget</dd>
            </dl>
            <p className="fineprint">Paper and dataset acknowledgment follows the release snapshot: your NFT must be included in that research, and you must hold it at the specified block. Acknowledgment is separate from authorship and royalties. <a href="https://github.com/jianmliu/aigg-bnb/blob/main/docs/flybnb/CREDIT.md" target="_blank" rel="noreferrer">Read the acknowledgment policy</a>.</p>
            <p className="fineprint">The proposed FLYBNB bootstrap rewards hosts for accepted research work. Adoption proceeds enter the FlyBnB treasury in BNB; host bonds start in BNB. FLYBNB issuance is not presented as live, and holding the token alone does not grant NFT acknowledgment or royalties.</p>
            <a className="btn" href="#/flies">Explore flies &amp; participate</a>
          </article>
          <p className="fineprint">Research participation and a verifiable record have value even when no royalty is earned. Host rewards pay for completed work; holder royalties depend on applicable terms and paid usage. Hosting also carries a slashable bond.</p>
        </section>

        <section className="shelf">
          <header><h2>Brains on this mesh</h2><span className="note">{s.meps.length ? `${s.meps.length} listed` : "no mesh loaded"}</span></header>
          {s.meps.length === 0 && <p className="hint empty-shelf">{SOLO ? "Connecting to the network… the listings come from the chain, through the relayer." : <>Put a relayer’s address in the <b>Mesh</b> capsule above and press the arrow. The listings come from the chain it points at.</>}</p>}
          <div className="listings">
            {s.meps.map((m, i) => (
              <BrainCard key={m.mepId} listing index={i} mep={m} active={m.mepId === s.active} hosted={s.hosted.has(m.mepId)}
                         steps={stepsNum} onSelect={() => C.setActive(m.mepId)} onHost={(v) => C.host(m.mepId, v)} />
            ))}
          </div>
        </section>

        {active && (
          <section className="listing-page">
            <div className="about-brain">
              <h2>{C.mepName(active)}</h2>
              <p className="sub">{active.exec} · {active.neurons.toLocaleString()} neurons · {active.synapses.toLocaleString()} synapses</p>
              <dl className="facts">
                <dt>Hosted by this tab</dt><dd>{s.hosted.has(active.mepId) ? (s.node?.models.has(active.mepId) ? "yes — resident and proving" : "chosen, not resident yet") : "no"}</dd>
                <dt>Where its bytes live</dt><dd className="mono">{active.weightsDA}</dd>
                <dt>How you know they are the right bytes</dt><dd>every host recomputes <code>model_id</code> over all of them before loading; a wrong source can only waste the download</dd>
              </dl>
              <div id="mepInfo" className="kv">
                {`${active.mepId} · model_id ${active.modelId.slice(0, 14)}… · ${active.neurons.toLocaleString()} neurons · ${active.synapses.toLocaleString()} synapses · ${active.weightsDA}`}
              </div>
              <div id="mepStatus" className="kv">
                {`hosted: ${s.hosted.has(active.mepId) ? "yes" : "no"} · claims: epochs ${Object.keys(s.claims[active.mepId] || {}).join(",") || "—"} · materialized: ${Object.entries(s.materialized[active.mepId] || {}).filter(([, v]) => v).map(([k]) => k).join(",") || "—"}`}
              </div>
              <p className="hint">The seed is the scene, and it is pinned on-chain with the fee and the deadline — so the experiment is fixed before anyone runs it, and an executor cannot choose afterwards what it was answering. Any node, an auditor, or a dispute round re-derives the same stimulus from it: that is what makes a result from a stranger’s tab worth anything.</p>
            </div>

            {!bookingOpen ? (
            <aside className="book" id="bookingClosed">
              <div className="price"><b>Not open yet</b></div>
              <p className="hint">For now every experiment on this network is one the FlyBnB atlas needs: the perturbation battery in the paper, posted by the project and run by the hosts. Booking your own experiment on a brain opens later.</p>
              <p className="hint">Until then there are two ways in: <a href="#/host">host a brain</a> and be paid for the runs you do, or <a href="#/flies">own a fly</a> the atlas measures.</p>
              <a className="btn wide" href="#/flybnb">What the experiments are</a>
            </aside>
            ) : (
            <aside className="book">
              <div className="price"><b>{Number.isFinite(feeNum) ? taskFee : "—"} BNB</b><span>per experiment</span></div>
              <div className="legend">Scene — what the fly sees</div>
              <div className="scenes">
                {C.SCENES.map((sc) => (
                  <button key={sc.id} type="button" className="scene" data-active={Number(scene) === sc.id} title={sc.about} onClick={() => setScene(String(sc.id))}>
                    <span className="name">{sc.name}</span>
                    <span className="counts">seed {sc.id}</span>
                  </button>
                ))}
              </div>
              <div className="cells">
                <Field label="Seed (uint32)" htmlFor="taskSeed"><input id="taskSeed" type="number" min="0" value={scene} onChange={(ev) => setScene(ev.target.value)} /></Field>
                <Field label="Steps" htmlFor="taskSteps"><input id="taskSteps" type="number" min="1" value={taskSteps} onChange={(ev) => setTaskSteps(ev.target.value)} /></Field>
                <Field label="Stride" htmlFor="taskStride"><input id="taskStride" type="number" min="1" value={taskStride} onChange={(ev) => setTaskStride(ev.target.value)} /></Field>
                <Field label="Hosts (redundancy)" htmlFor="taskRedundancy"><input id="taskRedundancy" type="number" min="1" value={taskRedundancy} onChange={(ev) => setTaskRedundancy(ev.target.value)} /></Field>
                <Field label="Fee (BNB)" htmlFor="taskFee"><input id="taskFee" type="number" min="0" step="0.001" value={taskFee} onChange={(ev) => setTaskFee(ev.target.value)} /></Field>
                <Field label="Deadline +blocks" htmlFor="taskDeadline"><input id="taskDeadline" type="number" min="1" value={taskDeadline} onChange={(ev) => setTaskDeadline(ev.target.value)} /></Field>
              </div>
              <Button id="btnPostTask" tone="money" className="btn wide" disabled={!s.wallet || !!taskProblem}
                      onClick={on(() => C.postTask({ seed: Number(scene), steps: Number(taskSteps), commitStride: Number(taskStride), redundancy: Number(taskRedundancy), feeBnb: taskFee, deadlineIn: Number(taskDeadline) }))}>
                Book this experiment
              </Button>
              <div className="kv empty">{!s.wallet ? "connect your wallet to book — the fee is paid from it" : taskProblem || `scene seed ${scene} · ${taskSteps} steps · stride ${taskStride} · ${taskRedundancy}× redundancy · ${taskFee} BNB`}</div>
              <dl className="bill">
                <dt>You pay</dt><dd>{Number.isFinite(feeNum) ? taskFee : "—"} BNB</dd>
                <dt>Split between</dt><dd>{Number.isInteger(hostsNum) && hostsNum >= 1 ? `${hostsNum} host${hostsNum > 1 ? "s" : ""} whose results agree` : "—"}</dd>
              </dl>
              {s.tasks.length > 0 && (
                <div className="kv trips">
                  <div className="legend">Your experiments</div>
                  {s.tasks.slice(0, 5).map((t) => (
                    <div key={t.taskId}>{t.taskId.slice(0, 12)}… · seed {t.seed} · {t.steps} steps · deadline {t.deadline}</div>
                  ))}
                </div>
              )}
            </aside>
            )}
          </section>
        )}
      </div>

      {/* ---------------- Host: the four things it takes, then the running node ---------------- */}
      <div className="main host" hidden={view !== "host"}>
        <div className="col">
          <section className="hosthead">
            <p className="kicker">Become a host</p>
            <h2>Your tab, their brain.</h2>
            <p className="lede">Four steps, two wallet prompts. After that the tab does the work: a residency claim per brain per epoch, audits answered, experiments run.</p>
          </section>

          <HostDashboard active={view === "host"} />

          <Panel step={1} title="Your deposit" note="bond · BNB">
            <div id="wallet" className={`kv ${s.wallet ? "strong" : "empty"}`}>
              {s.wallet ? `${s.wallet} (chain ${s.chainId}${s.chainOk ? "" : " ≠ " + s.deployment.chainId})` : "not connected"}
            </div>
            <div id="bond" className={`kv ${s.wallet ? "" : "empty"}`}>
              {s.wallet
                ? `balance ${bnb(s.balance)} BNB · bonded ${bnb(s.bonded)} BNB · ${s.weight} votes${s.exitAt ? ` · exiting at block ${s.exitAt}` : ""} · MEPs: ${s.inMep.join(", ") || "none"}`
                : "—"}
            </div>
            <div className="row">
              <Field label="Amount (BNB)" htmlFor="amount" className="mid">
                {/* one vote's worth by default; remounted once, when the deployment has said what a vote costs here */}
                <input id="amount" key={s.unit ? "unit" : "unknown"} type="number" defaultValue={s.unit ? unitBnb(s.unit) : ""} step={s.unit ? unitBnb(s.unit) : "any"} min="0" />
              </Field>
              <Button id="btnBond" tone="money" onClick={on(C.bond)} disabled={!s.wallet}>Bond</Button>
              <Button id="btnRefresh" onClick={on(C.refreshBond)} disabled={!s.wallet}>Refresh</Button>
            </div>
            <div className="row tight">
              <Button id="btnExit" tone="danger" onClick={on(C.requestExit)} disabled={!s.wallet}>Request exit</Button>
              <Button id="btnFinalize" tone="danger" onClick={on(C.finalizeExit)} disabled={!s.wallet}>Finalize exit</Button>
            </div>
            <p className="hint">A host’s deposit is a bond: slashable if a result of yours loses a dispute, yours again after the exit delay. One bond covers every brain ticked on the right; a top-up adds brains to it.</p>
          </Panel>

          <Panel step={2} title="House key" note="session key · 1 signature">
            <div className="row">
              <Field label="Expiry in blocks" htmlFor="expiry" className="mid">
                <input id="expiry" type="number" defaultValue="100000" />
              </Field>
              <Button id="btnDelegate" tone="chain" onClick={on(C.delegate)} disabled={!s.wallet}>Delegate session key</Button>
            </div>
            <div id="session" className={`kv ${s.session ? "strong" : "empty"}`}>
              {s.session ? `session key ${hex(s.session.address)}${s.resolved ? ` → instance ${s.resolved}` : ""}` : "—"}
            </div>
            <p className="hint">EIP-712 <code>Delegation</code>: the only wallet prompt the node needs. Everything after this is signed by the session key, which holds no BNB — the relayer pays the gas.</p>
          </Panel>
        </div>

        <div className="col">
          <Panel step={3} title="Move a brain in" note={`${s.meps.length} on this mesh`}>
            {s.meps.length === 0 && <p className="hint">{SOLO ? "Connecting to the network…" : "Load a mesh in the capsule above to see the brains it lists."}</p>}
            <div className="brains">
              {s.meps.map((m, i) => (
                <BrainCard key={m.mepId} index={i} mep={m} active={m.mepId === s.active} hosted={s.hosted.has(m.mepId)}
                           steps={stepsNum} onSelect={() => C.setActive(m.mepId)} onHost={(v) => C.host(m.mepId, v)} />
              ))}
            </div>

            <div className="legend">Bytes for the selected brain</div>
            <Field label="Greenfield SP endpoint (optional)" htmlFor="sp">
              <input id="sp" type="text" onInput={() => C.autofillUrl()}
                     placeholder="https://gnfd-testnet-sp1.bnbchain.org — fills the URL from the MEP's gnfd:// pointer" />
            </Field>
            <div className="row">
              <Field label="File" htmlFor="file"><input id="file" type="file" /></Field>
              <Field label="…or URL" htmlFor="url"><input id="url" type="text" placeholder="https://…/flywire-783-min5.bin or /payload.bin" /></Field>
            </div>
            <div className="row">
              <Field label="Max task steps" htmlFor="steps" className="narrow">
                <input id="steps" type="number" value={steps} min="1" max="262144" step="1" required
                       title="Capacity for each brain when it starts hosting; higher values use more memory"
                       onChange={(ev) => setSteps(ev.target.value)} />
              </Field>
              <Button id="btnModel" tone="chain" onClick={on(C.loadModel)} disabled={!active}>Load for this brain</Button>
            </div>
            <div id="model" className={`kv ${loaded ? "strong" : "empty"}`}>{modelText}</div>
            <p className="hint">The bytes go straight to the worker, which recomputes the model_id over every 4 KiB tile: a wrong or hostile source can only waste the download.</p>
          </Panel>

          <Panel step={4} title="Open the doors" note={s.node ? "running" : "stopped"}>
            <div className="row tight">
              <Button id="btnStart" tone="primary" onClick={on(C.startNode)} disabled={!!s.node || !s.delegation}>
                {s.node ? "Node running" : "Start node"}
              </Button>
              <label className="check">
                <input id="auto" type="checkbox" defaultChecked />
                materialize claims automatically
              </label>
            </div>
            <div className="last" data-tone={toneOfLine(s.lastLog)}>
              <span className="text">{s.lastLog || "idle"}</span>
            </div>
            <pre id="log" className="console" />
          </Panel>
        </div>
      </div>

      <footer className="foot-note">
        <span>fly<b>bnb</b> · bonded, settled and disputed on BNB Chain · model bytes on Greenfield</span>
        {!SOLO && <span>the relayer is replaceable: point the Mesh capsule at your own</span>}
      </footer>
    </div>
  );
}
