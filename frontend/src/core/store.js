// `controller.js` owns the state and mutates it in place -- that is what lets the memory arithmetic be tested
// outside a browser, and what keeps the node's bookkeeping out of React's hands. React still has to hear about
// it, so this is the whole bridge: the controller's one notification callback bumps a version, and components
// subscribe to that version through useSyncExternalStore and then read `state` directly.
//
// Deliberately not a store: there is no second copy of anything to fall out of sync.
import { useSyncExternalStore } from "react";
import { setOnChange } from "./controller.js";

let version = 0;
const listeners = new Set();

setOnChange(() => { version += 1; for (const l of listeners) l(); });

const subscribe = (l) => { listeners.add(l); return () => listeners.delete(l); };
const snapshot = () => version;

/** re-render whenever the controller says something changed; the value itself is meaningless */
export const useNodeState = () => useSyncExternalStore(subscribe, snapshot, snapshot);
