// One brain (MEP). The card is the selector, the host toggle and the status readout at once, because those three
// were three separate widgets pointing at the same thing: a <select>, a checkbox list, and a line of text. Click
// the card to make it the one the model panel refers to; the checkbox decides whether the node hosts it.
import { MB, brainBytes, state } from "../core/controller.js";

/** what the tab currently knows about these bytes: nothing, the right brain, or the wrong one */
function modelState(mep) {
  const loaded = state.loaded[mep.mepId];
  if (!loaded) return { tone: "idle", text: "no model" };
  if (!loaded.ok) return { tone: "bad", text: "model_id mismatch" };
  return { tone: "ok", text: state.node?.models.has(mep.mepId) ? "resident" : "verified" };
}

export function BrainCard({ mep, active, hosted, steps, onSelect, onHost }) {
  const s = modelState(mep);
  const projected = Number.isInteger(steps) && steps >= 1 ? brainBytes(mep, steps) : 0;
  return (
    <div className="brain" data-active={active} onClick={onSelect} role="button" tabIndex={0}
         onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onSelect(); } }}>
      <div className="name">
        <span>{mep.name || mep.mepId.slice(0, 12) + "…"}</span>
        <span className="exec">{mep.exec}</span>
      </div>
      <div className="counts">{mep.neurons.toLocaleString()} neurons · {mep.synapses.toLocaleString()} synapses</div>
      <div className="state" data-tone={s.tone}>
        {s.text}
        {projected > 0 && <span style={{ color: "var(--faint)" }}>· ~{MB(projected)}</span>}
      </div>
      <div className="foot">
        <label className="check" onClick={(e) => e.stopPropagation()}>
          <input type="checkbox" checked={hosted} onChange={(e) => onHost(e.target.checked)} />
          host this brain
        </label>
      </div>
    </div>
  );
}
