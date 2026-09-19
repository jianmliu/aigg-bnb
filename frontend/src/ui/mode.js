// A deployed build knows its relayer (VITE_RELAYER_URL is baked in), and for now that is the only one there is:
// external relayers are not open yet. So a deployed page has no "which mesh" control at all -- it connects on open,
// keeps trying if the relayer is away, and says "online". A local build keeps the Mesh capsule: a developer points it
// at a relayer on their machine, and the end-to-end tests point it at theirs.
export const BAKED_RELAYER = import.meta.env?.VITE_RELAYER_URL || "";
export const SOLO = !!BAKED_RELAYER;
