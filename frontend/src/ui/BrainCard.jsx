// One brain (MEP), as a listing. The card is the selector, the host toggle and the status readout at once, because
// those three were three separate widgets pointing at the same thing. It comes in two sizes. On the Brains view it
// is a listing -- the portrait first, the way a place to stay is a photograph first -- and clicking it opens the
// brain below. On the Host view it is a row with the checkbox that decides whether this tab takes the brain in.
import { MB, brainBytes, state } from "../core/controller.js";
import { Portrait } from "./Portrait.jsx";

/** what the tab currently knows about these bytes: nothing, the right brain, or the wrong one */
function modelState(mep) {
  const loaded = state.loaded[mep.mepId];
  if (!loaded) return { tone: "idle", text: "no model" };
  if (!loaded.ok) return { tone: "bad", text: "model_id mismatch" };
  return { tone: "ok", text: state.node?.models.has(mep.mepId) ? "resident" : "verified" };
}

export function BrainCard({ mep, active, hosted, steps, onSelect, onHost, listing = false, index = 0 }) {
  const s = modelState(mep);
  const projected = Number.isInteger(steps) && steps >= 1 ? brainBytes(mep, steps) : 0;
  return (
    <div className={listing ? "brain listing" : "brain"} data-active={active} onClick={onSelect} role="button" tabIndex={0} style={{ "--i": index }}
         onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onSelect(); } }}>
      <div className="photo">
        <Portrait seed={mep.modelId} label={`portrait of ${mep.name || mep.mepId.slice(0, 12)}, drawn from its model id`} />
        {listing && hosted && <span className="tag">you host this</span>}
      </div>
      <div className="about">
        <div className="name">
          <span>{mep.name || mep.mepId.slice(0, 12) + "…"}</span>
          <span className="exec">{mep.exec}</span>
        </div>
        <div className="counts">{mep.neurons.toLocaleString()} neurons · {mep.synapses.toLocaleString()} synapses</div>
        <div className="state" data-tone={s.tone}>
          {s.text}
          {projected > 0 && <span style={{ color: "var(--faint)" }}>· ~{MB(projected)}</span>}
        </div>
        {!listing && (
          <div className="foot">
            <label className="check" onClick={(e) => e.stopPropagation()}>
              <input type="checkbox" checked={hosted} onChange={(e) => onHost(e.target.checked)} />
              {state.deployment?.familyHosting ? 'host this model family' : 'host this brain'}
            </label>
          </div>
        )}
      </div>
    </div>
  );
}
