// Presentation must never promote a stale/unfinished session into permission to close.
export function sessionStatus(s) {
  if (!s) return {safe:false,label:'Checking verification session',detail:'Keep this page open until the on-chain session state is confirmed.'};
  const terminal=['completed','inconclusive','idle'].includes(s.phase);
  const pending=!!s.pendingTask && !/^0x0{64}$/i.test(s.pendingTask);
  const safe=terminal && s.safeToClose===true && Number(s.confirmedBlock)>0 && !s.error && !s.ready && !pending && !s.draining;
  const label=s.phase==='inconclusive'?'Inconclusive':s.phase==='completed'?'Completed':s.phase==='idle'?'Not accepting tasks':s.phase;
  const detail=s.error ? `State unavailable: ${s.error}. Closure has not been confirmed.`
    : s.phase==='awaiting randomness'?'Your capacity is reserved in a locked candidate pool. Keep this page open while VRF selects two executors. Unselected hosts are released after confirmed allocation.': s.phase==='inconclusive'?'This result was not accepted as a completed experiment. Check the task refund status.'
    : s.phase==='completed'?'Execution and verification have finished. This task cannot start another interactive challenge.'
    : 'Computation alone is not completion. Keep this page open through verification.';
  return {safe,label,detail};
}
