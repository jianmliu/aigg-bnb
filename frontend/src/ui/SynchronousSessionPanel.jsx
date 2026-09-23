import SynchronousCredits from './SynchronousCredits.jsx';
import * as C from '../core/controller.js';
import {Button} from './primitives.jsx';
import {sessionStatus} from '../core/synchronous_status.js';

export default function SynchronousSessionPanel() {
  const s=C.state, session=s.synchronousSession, view=sessionStatus(session);
  const rounds=s.deployment?.verification?.mode==='synchronous-vrf-rounds-v1';
  const connected=!!s.wallet && s.chainOk;
  const pending=!!session?.pendingTask && !/^0x0{64}$/i.test(session.pendingTask);
  return <section id="synchronous-session" aria-live="polite">
    <h3>Execution &amp; verification session</h3>
    <p><strong id="synchronous-phase">{view.label}</strong></p>
    <p className="hint">{view.detail}</p>
    {session?.taskId && <p className="hint">Task {session.taskId.slice(0,18)}…</p>}
    {session?.totalDeadline && <p className="hint">Final deadline: block {String(session.totalDeadline)}. Network block times vary.</p>}
    {session?.admission && <p className="hint">Randomness deadline: block {session.admission.randomnessDeadline}. Candidates: {session.admission.candidateCount}. {session.admission.fulfilledAt!=='0' && `Allocation deadline: block ${session.admission.allocationDeadline}.`}</p>}
    {s.deployment?.verification?.mode==='synchronous-vrf-v1' && <p className="hint">Readiness lasts up to {s.deployment.verification.readyTtlBlocks} blocks. Each draw reserves the eligible ready pool; hosts not selected must explicitly accept another task. Clients pay a separate nonrefundable admission fee.</p>}
    {rounds && <p className="hint">A round collects for {s.deployment.verification.roundBlocks} blocks and accepts at most {s.deployment.verification.maxRoundTasks} tasks. Your declared task slots bound your reservations. Each task retains its own evidence and deadline; finish every reservation before closing. Clients pay a separate nonrefundable admission fee per task.</p>}
    {rounds && <p className="hint">Reserved tasks: {session?.pendingTasks?.length || 0}. Active verification journals: {session?.tasks?.length || 0}.</p>}
    <p id="synchronous-close-status">{view.safe?'No pending session or new assignment permission. You can close this page.':'Do not close yet: task or readiness reconciliation is still pending.'}</p>
    <div className="row tight center">
      <Button id="sync-arm" disabled={!connected || !s.node || !session || !!session.error || pending || session.ready || session.draining} onClick={C.wrap(C.armSynchronousSession)}>{rounds?'Accept a bounded round':'Accept one task'}</Button>
      <Button id="sync-drain" disabled={!connected || !!session?.draining} onClick={C.wrap(C.drainSynchronousSession)}>Finish and stop accepting</Button>
      <Button id="sync-resume" disabled={!connected} onClick={C.wrap(C.resumeSynchronousSession)}>Reconcile / resume</Button>
    </div>
    <SynchronousCredits/>
    <p className="hint">Agreement between two independent operators is replication confirmation, not a validity proof. Rewards become claimable only after completion.</p>
  </section>;
}
