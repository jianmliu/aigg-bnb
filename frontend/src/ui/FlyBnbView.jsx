// FlyBnB: the dataset this network exists to produce, and the people it is owed to.
//
// The banner sits above both other views because it is the answer to "what is all this for": every brain hosted
// here is an individual in a perturbation atlas of the fly brain, re-tested across individuals, every row of which
// anybody can recompute bit for bit. The view has the paper, the dataset, and the acknowledgments.
//
// The acknowledgments are not a list somebody maintains. They are whoever holds an individual right now, read from
// the collection through the relayer (`/flybnb/holders`): a mint adds an address, a transfer moves a token from one
// address to another, and an address that holds nothing drops off. The paper's appendix is this same list at a
// block (docs/flybnb/build.mjs). Addresses only -- a name is the holder's to give, not the page's to guess.
import { useEffect, useState } from "react";
import * as C from "../core/controller.js";
import { Panel } from "./primitives.jsx";

const REPO = "https://github.com/jianmliu/aigg-bnb/blob/main/docs/flybnb";
export const PAPER_URL = import.meta.env?.VITE_FLYBNB_PAPER_URL || `${REPO}/paper.md`;
export const DATASET_URL = import.meta.env?.VITE_FLYBNB_DATASET_URL || ""; // empty until the dataset is public
const EVERY_MS = 30000;

export function FlyBnbBanner() {
  return (
    <a className="flybnb-banner" id="flybnbBanner" href="#/flybnb">
      <span className="tag">FlyBnB</span>
      <span className="pitch">A whole-brain perturbation atlas of the fly, re-tested across individuals — every row recomputable, every host acknowledged.</span>
      <span className="go">paper · dataset · acknowledgments →</span>
    </a>
  );
}

const short = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;

export default function FlyBnbView() {
  const s = C.state;
  const [h, setH] = useState(null); const [err, setErr] = useState(null);
  useEffect(() => {
    let live = true;
    const pull = async () => {
      try { const r = await fetch(C.relayer() + "/flybnb/holders"); const j = await r.json(); if (!live) return; if (j.error) { setErr(j.error); setH(null); } else { setH(j); setErr(null); } }
      catch (e) { if (live) setErr("the relayer is not reachable: load a deployment on the Node view first"); }
    };
    pull(); const t = setInterval(pull, EVERY_MS); return () => { live = false; clearInterval(t); };
  }, [s.deployment]);
  const me = s.wallet ? s.wallet.toLowerCase() : null;

  return (
    <div className="main single" id="flybnb">
      <Panel title="FlyBnB" note="dataset · paper">
        <p className="lede">
          Connectome simulations rest on one brain. FlyBnB silences and activates every cell type of the female (FlyWire) and male (MaleCNS) brain under
          a battery of sensory stimuli, then repeats each result in a hundred synthetic individuals whose wiring varies as much as a fly's left and right
          hemispheres do. Each row is one whole-brain run with a digest that anybody can recompute bit for bit; the individuals are the brains hosted on
          this network.
        </p>
        <div className="row tight">
          <a className="btn" data-tone="chain" id="flybnbPaper" href={PAPER_URL} target="_blank" rel="noreferrer">Paper (living draft)</a>
          {DATASET_URL
            ? <a className="btn" data-tone="chain" id="flybnbDataset" href={DATASET_URL} target="_blank" rel="noreferrer">Dataset on Hugging Face</a>
            : <span className="btn" data-tone="idle" id="flybnbDataset" aria-disabled="true" title="The dataset card and the pilot split are prepared; the repository is not public yet">Dataset · in preparation</span>}
        </div>
        <div className="kv">pilot: 100 individuals × 10 stimulus seeds × 2 stimuli — the numbers are in the paper and are regenerated with it</div>
      </Panel>

      <Panel title="Acknowledgments" note={h ? `block ${h.block} · live` : "live"}>
        <p className="lede">
          The dataset acknowledges everyone who holds an individual. This list is read from the chain and follows it: minting adds you, a transfer moves
          the acknowledgment with the token. The paper's appendix is this list at a recorded block.
        </p>
        {err && <div className="kv empty" id="flybnbHoldersError">{err}</div>}
        {h && (
          <>
            <div className="kv strong" id="flybnbHoldersSummary">{h.holders.length} holder{h.holders.length === 1 ? "" : "s"} · {h.totalSupply} individual{h.totalSupply === 1 ? "" : "s"}{h.truncated ? " · list truncated" : ""}</div>
            <ol className="holders" id="flybnbHolders">
              {h.holders.map((x) => (
                <li key={x.address} data-me={me === x.address.toLowerCase()}>
                  <span className="addr" title={x.address}>{short(x.address)}</span>
                  <span className="toks">{x.tokens.map((id) => `#${id}`).join(" ")}</span>
                  {me === x.address.toLowerCase() && <span className="you">you</span>}
                </li>
              ))}
            </ol>
          </>
        )}
      </Panel>
    </div>
  );
}
