// The page: one node in a decentralized fly-brain network, and the console for running an experiment on it.
//
// Five numbered panels are the order a node has to be brought up in -- relayer, wallet, session key, brains,
// run -- and a sixth posts an experiment into the network. Setup lives in the left rail and stays put; the right
// column is what moves once the node is running.
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
import FliesView from "./FliesView.jsx";
import FlyBnbView, { FlyBnbBanner } from "./FlyBnbView.jsx";

const bnb = (wei) => (Number(wei) / 1e18).toFixed(4);

// Where the page points on first load. Locally that is a relayer on this machine; a deployed build gets
// VITE_RELAYER_URL baked in, because `http://127.0.0.1:8788` on an https origin is blocked as mixed content
// before it is anything else. The field stays editable either way -- pointing the page at your own relayer is
// the whole reason the relayer is replaceable.
const DEFAULT_RELAYER = import.meta.env?.VITE_RELAYER_URL || "http://127.0.0.1:8788";

function Logo() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M12 3.5c-2.4 0-3.6 1.4-3.6 3 0 .8.3 1.5.8 2-1.9.4-3.7 1.9-3.7 4.2 0 2.6 2.1 4.4 4.6 4.4.9 0 1.6-.2 2-.4v3.3" stroke="var(--cyan)" strokeWidth="1.4" strokeLinecap="round" />
      <path d="M12 3.5c2.4 0 3.6 1.4 3.6 3 0 .8-.3 1.5-.8 2 1.9.4 3.7 1.9 3.7 4.2 0 2.6-2.1 4.4-4.6 4.4-.9 0-1.6-.2-2-.4" stroke="var(--pink)" strokeWidth="1.4" strokeLinecap="round" />
      <circle cx="12" cy="20" r="1.4" fill="var(--green)" />
    </svg>
  );
}

/** the one-line health of the whole page, in the order things go wrong */
function status(s) {
  if (s.wallet && !s.chainOk) return { tone: "bad", text: "wrong chain" };
  if (s.node) return { tone: "live", text: `live · ${s.node.models.size} resident` };
  if (s.delegation) return { tone: "ready", text: "ready to start" };
  if (s.wallet) return { tone: "warn", text: "no session key" };
  if (s.deployment) return { tone: "warn", text: "no wallet" };
  return { tone: null, text: "offline" };
}

const toneOfLine = (line) => (!line ? null : /ERROR|FAIL|REVERT|DOES NOT MATCH/.test(line) ? "bad" : /WARNING|note:/.test(line) ? "warn" : /\bok\b|confirmed|running|resident|matches/.test(line) ? "ok" : null);

export default function App() {
  useNodeState();
  const s = C.state;
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

  // Two views, one page: the node console and the colony. The hash is the route, so a link to #/flies works. The
  // node view is hidden rather than unmounted -- the controller writes into #log and reads #relayer whichever
  // view is showing, and a running node must not lose its console because someone went to look at their flies.
  const route = () => (window.location.hash === "#/flies" ? "flies" : window.location.hash === "#/flybnb" ? "flybnb" : "node");
  const [view, setView] = useState(route);
  useEffect(() => { const on = () => setView(route()); window.addEventListener("hashchange", on); return () => window.removeEventListener("hashchange", on); }, []);

  // the MEP's gnfd:// pointer plus an SP endpoint is a fetchable URL; fill the box rather than make anyone paste it
  useEffect(() => { C.autofillUrl(); }, [s.active]);
  // after the first commit, not before: #relayer and #log have to exist before anything drives the page
  useEffect(() => { window.__ready = true; }, []);

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

  return (
    <div className="shell">
      <header className="topbar">
        <div className="brand">
          <Logo />
          <h1>Fly-brain network</h1>
          <span className="sub">node · BNB Chain</span>
        </div>
        <nav className="views">
          <a id="navNode" href="#/" data-active={view === "node"}>Node</a>
          <a id="navFlies" href="#/flies" data-active={view === "flies"}>Flies</a>
          <a id="navFlyBnb" href="#/flybnb" data-active={view === "flybnb"}>FlyBnB</a>
        </nav>
        <Pill tone={st.tone}>{st.text}</Pill>
        <div className="telemetry">
          <Chip k="epoch" v={e ? e.epoch : "—"} tone="cyan" />
          <Chip k="block" v={e ? e.block : "—"} />
          <Chip k="beacon" v={e ? (e.rolled ? "rolled" : e.lazy && !e.warm ? "cold" : "pending") : "—"} tone={e?.rolled ? "green" : "amber"} />
          <Chip k="brains" v={`${s.node ? s.node.models.size : 0}/${hostedIds.length || 0}`} tone="green" title="resident on the node / chosen to host" />
          <Chip k="resident" v={s.node ? C.MB(s.node.memoryBytes) : projected ? `~${C.MB(projected)}` : "—"} tone={s.node ? "green" : undefined} title="wasm memory the hosted brains hold" />
          <Chip k="claims" v={claimsNow} tone={claimsNow ? "green" : undefined} title="claims announced this epoch" />
        </div>
      </header>

      {view !== "flybnb" && <FlyBnbBanner />}
      {view === "flies" && <FliesView />}
      {view === "flybnb" && <FlyBnbView />}
      <div className="main" hidden={view !== "node"}>
        <div className="col">
          <Panel step={1} title="Relayer" note="read-only">
            <Field label="Relayer API URL" htmlFor="relayer">
              <input id="relayer" type="text" defaultValue={DEFAULT_RELAYER} placeholder="https://relayer.example.org" />
            </Field>
            <div className="row tight">
              <Button id="btnDep" tone="chain" onClick={on(C.loadDeployment)}>Load deployment</Button>
            </div>
            <div id="dep" className={`kv ${s.deployment ? "" : "empty"}`}>
              {s.deployment ? `chain ${s.deployment.chainId} · claims ${s.deployment.addresses.claims.slice(0, 10)}… · relay ${s.deployment.relay} · ${s.meps.length} MEP(s)` : "—"}
            </div>
            <div id="epoch" className={`kv ${e ? "" : "empty"}`}>
              {e ? `epoch ${e.epoch} · block ${e.block} · beacon ${e.rolled ? "rolled" : e.lazy && !e.warm ? "cold (waking up)" : "pending"}` : "—"}
            </div>
          </Panel>

          <Panel step={2} title="Wallet and bond" note="BNB">
            <div className="row tight">
              <Button id="btnConnect" tone="chain" onClick={on(C.connect)} disabled={!s.deployment}>Connect wallet</Button>
              <Button id="btnRefresh" onClick={on(C.refreshBond)} disabled={!s.wallet}>Refresh</Button>
            </div>
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
                <input id="amount" type="number" defaultValue="0.5" step="0.05" min="0" />
              </Field>
              <Button id="btnBond" tone="money" onClick={on(C.bond)} disabled={!s.wallet}>Bond</Button>
              <Button id="btnExit" tone="danger" onClick={on(C.requestExit)} disabled={!s.wallet}>Request exit</Button>
              <Button id="btnFinalize" tone="danger" onClick={on(C.finalizeExit)} disabled={!s.wallet}>Finalize exit</Button>
            </div>
            <p className="hint">One bond covers every brain ticked below; a top-up adds brains to it.</p>
          </Panel>

          <Panel step={3} title="Session key" note="1 signature">
            <div className="row">
              <Field label="Expiry in blocks" htmlFor="expiry" className="mid">
                <input id="expiry" type="number" defaultValue="100000" />
              </Field>
              <Button id="btnDelegate" tone="chain" onClick={on(C.delegate)} disabled={!s.wallet}>Delegate session key</Button>
            </div>
            <div id="session" className={`kv ${s.session ? "strong" : "empty"}`}>
              {s.session ? `session key ${hex(s.session.address)}${s.resolved ? ` → instance ${s.resolved}` : ""}` : "—"}
            </div>
            <p className="hint">EIP-712 <code>Delegation</code>: the only wallet prompt the node needs. Everything after this is signed by the session key.</p>
          </Panel>
        </div>

        <div className="col">
          <Panel step={4} title="Brains" note={`${s.meps.length} registered`}>
            {s.meps.length === 0 && <p className="hint">Load a deployment to see the brains this mesh registers.</p>}
            <div className="brains">
              {s.meps.map((m) => (
                <BrainCard key={m.mepId} mep={m} active={m.mepId === s.active} hosted={s.hosted.has(m.mepId)}
                           steps={stepsNum} onSelect={() => C.setActive(m.mepId)} onHost={(v) => C.host(m.mepId, v)} />
              ))}
            </div>
            <div id="mepInfo" className={`kv ${active ? "" : "empty"}`}>
              {active ? `${active.mepId} · model_id ${active.modelId.slice(0, 14)}… · ${active.neurons.toLocaleString()} neurons · ${active.synapses.toLocaleString()} synapses · ${active.weightsDA}` : "—"}
            </div>
            <div id="mepStatus" className={`kv ${active ? "" : "empty"}`}>
              {active
                ? `hosted: ${s.hosted.has(active.mepId) ? "yes" : "no"} · claims: epochs ${Object.keys(s.claims[active.mepId] || {}).join(",") || "—"} · materialized: ${Object.entries(s.materialized[active.mepId] || {}).filter(([, v]) => v).map(([k]) => k).join(",") || "—"}`
                : "—"}
            </div>

            <div className="legend">Model for the selected brain</div>
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

          <Panel step={5} title="Node" note={s.node ? "running" : "stopped"}>
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

          <Panel step={6} title="Experiment" note="scene set at post time">
            <div className="legend">Scene — the stimulus every node in the network re-derives</div>
            <div className="scenes">
              {C.SCENES.map((sc) => (
                <button key={sc.id} type="button" className="brain scene" data-active={Number(scene) === sc.id}
                        title={sc.about} onClick={() => setScene(String(sc.id))}>
                  <span className="name">{sc.name}</span>
                  <span className="counts">seed {sc.id} · {sc.about}</span>
                </button>
              ))}
            </div>
            <div className="row">
              <Field label="Seed (uint32)" htmlFor="taskSeed" className="narrow">
                <input id="taskSeed" type="number" min="0" value={scene} onChange={(ev) => setScene(ev.target.value)} />
              </Field>
              <Field label="Steps" htmlFor="taskSteps" className="narrow">
                <input id="taskSteps" type="number" min="1" value={taskSteps} onChange={(ev) => setTaskSteps(ev.target.value)} />
              </Field>
              <Field label="Stride" htmlFor="taskStride" className="narrow">
                <input id="taskStride" type="number" min="1" value={taskStride} onChange={(ev) => setTaskStride(ev.target.value)} />
              </Field>
              <Field label="Redundancy" htmlFor="taskRedundancy" className="narrow">
                <input id="taskRedundancy" type="number" min="1" value={taskRedundancy} onChange={(ev) => setTaskRedundancy(ev.target.value)} />
              </Field>
            </div>
            <div className="row">
              <Field label="Fee (BNB)" htmlFor="taskFee" className="narrow">
                <input id="taskFee" type="number" min="0" step="0.001" value={taskFee} onChange={(ev) => setTaskFee(ev.target.value)} />
              </Field>
              <Field label="Deadline +blocks" htmlFor="taskDeadline" className="narrow">
                <input id="taskDeadline" type="number" min="1" value={taskDeadline} onChange={(ev) => setTaskDeadline(ev.target.value)} />
              </Field>
              <Button id="btnPostTask" tone="money" disabled={!s.wallet || !!taskProblem}
                      onClick={on(() => C.postTask({ seed: Number(scene), steps: Number(taskSteps), commitStride: Number(taskStride), redundancy: Number(taskRedundancy), feeBnb: taskFee, deadlineIn: Number(taskDeadline) }))}>
                Post experiment
              </Button>
            </div>
            <div className="kv empty">{taskProblem || `scene seed ${scene} · ${taskSteps} steps · stride ${taskStride} · ${taskRedundancy}× redundancy · ${taskFee} BNB`}</div>
            {s.tasks.length > 0 && (
              <div className="kv">
                {s.tasks.slice(0, 5).map((t) => (
                  <div key={t.taskId}>{t.taskId.slice(0, 12)}… · seed {t.seed} · {t.steps} steps · deadline {t.deadline}</div>
                ))}
              </div>
            )}
            <p className="hint">The seed is the scene, and it is pinned on-chain with the fee and the deadline — so the experiment is fixed before anyone runs it, and an executor cannot choose afterwards what it was answering. Any node, an auditor, or a dispute round re-derives the same stimulus from it: that is what makes a result from a stranger’s tab worth anything.</p>
          </Panel>
        </div>
      </div>
    </div>
  );
}
