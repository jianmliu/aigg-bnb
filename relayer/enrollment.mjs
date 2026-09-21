const ZERO32 = '0x' + '00'.repeat(32);

// Older non-proxy deployments return no data or an empty revert for unknown selectors.
// Transport failures and Solidity errors with data must never silently select legacy routing.
export function unsupportedGetter(error) {
  for (let e = error; e; e = e.cause) {
    if (e.name === 'ContractFunctionZeroDataError') return true;
    if (e.name === 'ContractFunctionRevertedError' && (!e.reason || e.reason === 'execution reverted') && !e.data && (!e.raw || e.raw === '0x')) return true;
  }
  return false;
}
async function optionalRead(read, fallback) {
  try { return await read(); } catch (error) { if (unsupportedGetter(error)) return fallback; throw error; }
}
export async function enrollmentMetadata(ch, id) {
  const base = String(await optionalRead(() => ch.meps.read.baseOf([id]), ZERO32)).toLowerCase();
  // The instance registry is authoritative: merely having a registered base does not activate pooling.
  const enrollmentMepId = String(await optionalRead(() => ch.instances.read.enrollmentMep([id]), id)).toLowerCase();
  if (enrollmentMepId !== id && (base === ZERO32 || enrollmentMepId !== base)) throw new Error(`MEP ${id}: registry enrollment mismatch`);
  return { baseMepId: base === ZERO32 ? null : base, enrollmentMepId };
}

// A pinned child keeps its enrollment base alive. A dependency alone must not become a permanent pin.
export async function reconcileEnrollmentBases(meps, listed, load) {
  const retained = new Set([...meps].filter(([id, M]) => M.pinned || listed.has(id)).map(([id]) => id));
  const dependencies = new Set([...retained].map(id => meps.get(id).info.enrollmentMepId || id));
  // Load before deleting anything: a transient RPC failure preserves the last complete catalog.
  const additions = new Map();
  for (const id of dependencies) if (!meps.has(id)) additions.set(id, await load(id));
  for (const [id, M] of additions) meps.set(id, M);
  for (const [id, M] of meps) if (!retained.has(id) && !dependencies.has(id)) {
    for (const A of M.aggregators.values()) A.stop?.();
    meps.delete(id);
  }
}
