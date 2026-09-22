# Synchronous verification for intermittent research hosts

Status: user-approved direction; proposed implementation, not deployed. This refines the offline-host boundary in the scientific verification design. Evidence handoff alone is not a completion signal for this first version.

## Product contract

A task includes execution AND a bounded verification session. Hosts stay online until their assigned task reaches a terminal on-chain state. Completion is final for this task: the deployed synchronous market exposes no post-completion interactive challenge against its executors. Historical research data can still be replicated and annotated, but that does not create a new contractual response obligation. Residency/storage obligations for other tasks are separate.

The pilot uses two independently administered executors, both selected when a task is posted. Two addresses alone are not proof of independence. Matching results establish replication agreement under this assumption, not a cryptographic proof or scientific validity. Colluding executors remain a risk. The first version accepts redundancy exactly two to avoid claiming a pairwise dispute resolves arbitrary groups.

## State machine

`assigned -> committing -> revealing -> [disputing] -> completed | inconclusive`

Admission additionally requires an explicit readiness flag per instance. The new market consumes readiness atomically when assigning one task; bond membership and spare capacity alone never authorize another session. Default is one-shot hosting. Pending-task getters let a browser reconcile assignments before shutdown. Continuous hosting is a distinct opt-in that re-arms only after confirmed closure; stop/drain revokes readiness and any outstanding signed re-arm nonce, then checks pending assignments at a confirmed block.

Each executor signs a chain/market/task/instance-bound commitment to its result, with a secret salt, before either result is published. Commitments are immutable. Reveal is allowed only after both commitments exist, and must match the signed commitment, exact assignment and original signed result. The relayer may transport but must not choose a result or sign on behalf of a host. Restart/replay cannot replace a commitment or double-pay a task.

Matching valid roots AND output digests complete and settle the task. Root agreement with conflicting digests is inconclusive unless an objective output-binding check resolves it; never label it completed. Different roots open the existing local-computation verification game immediately. Result acceptance cannot fall back to one remaining submitter after the peer times out.

Every assignment advertises immutable commit, reveal and overall deadlines in blocks before the host starts. All per-round deadlines are capped by the overall deadline; no action, challenge or restart extends it. Commit and reveal phases end at fixed earlier deadlines; the last legal reveal must leave a separately reserved dispute budget sized for all admitted batch/segment/neuron rounds and the largest replay/witness. Reject task shapes that cannot fit this budget. Messages are accepted through their deadline block, and expiry is callable only after it. Terminal callbacks and moves always fail after closure. Deployment values must be measured/configured and shown as block deadlines, not promised wall-clock durations. Late commitments, reveals and dispute moves fail. Anyone may finalize an expired task.

At deadline, missing results or unfinished disputes become inconclusive. Return the unallocated task fee to its original client, pay no experiment royalty, record no accepted digest, release capacity and task holds exactly once. An unresponsive peer never establishes the other result's correctness. A rejection of payment must not block terminal state: credit a withdrawal balance per asset rather than requiring a push transfer to succeed. Slash proceeds follow the same pull-payment rule: the dispute receives BNB from InstanceRegistry and credits the rightful beneficiary; a rejecting beneficiary cannot prevent resolution. No timeout-only fraud slash. A demonstrated invalid computation follows the local proof slash rule. A surviving result is accepted as `adjudicated under independent-honest-executor assumption`, not as a standalone proof of the complete run or its arbitrary output digest. Root/digest conflicts without an applicable local proof stay inconclusive. The gateway must verify returned output bytes against the accepted digest; the honest-executor assumption remains explicit. Inconclusive is not success and cannot be consumed by the gateway or battery worker as a valid dataset row.

While a task is pending, assigned stake cannot exit before possible adjudication. The market owns one assignment hold per host, acquired atomically at assignment and released exactly once at terminal settlement; the new dispute must not acquire a duplicate hold. Track this hold separately from an execution slot: releasing compute capacity does not imply task completion or permission to erase evidence. The browser's first version admits one active execution/verification session at a time.

## Interactive client and evidence

A bounded browser responder keeps or replays the exact signed task manifest, model, inputs and execution state through verification. It follows chain state rather than unauthenticated peer messages. It can submit the existing run/segment/state/row openings and valid final local proof. Expose bounded phase/round and party-state getters (including opened roots, rows and sums required to build the final witness). Each sponsored move signs chain, dispute address, task, instance, expected phase/round nonce, calldata hash and expiry. Restrict forwarded methods to proof moves; validate session authorization and require delegation coverage through the session deadline. Reorg recovery reloads confirmed state and never treats an unconfirmed receipt as safe to close. Each sponsored move is authenticated, task-bound, deadline-bound and replay-safe; no new unrestricted session-key authority is granted to the relayer.

The host UI distinguishes computing, committed, waiting for peer, verifying, completed, and inconclusive. It shows outstanding sessions and the final block deadline. It says safe to close only when no session owned by this tab remains pending. On crash/reload, recover the journal and resume within the same deadline; never re-sign different results. If the deadline is missed, expose the actual terminal outcome and accounting rather than implying scientific success.

Complete/inconclusive tasks have no further required interaction by the original host. Preserve scientific artifacts according to dataset policy; continued browser-local storage is not a condition of completed task settlement.

## Compatibility and migration

Implement as separate synchronous contracts and deployment capability, retaining legacy contracts and their semantics. Native and ERC-20 tasks must share the state machine while preserving token acceptance, task identity, beneficiary accounting, and BNB/token refund denomination. No change to a live address by source edit: existing contracts are not upgradeable.

The relayer, gateway, battery worker and frontend must understand the new state machine before cutover. Existing clients that can only submit a result fail closed against the new capability. Do not activate with a UI-only completion label or a contract-only flow without a working responder. The existing collection has an immutable market pointer, so inventory/royalty migration must be separately audited; do not leave royalties routed to an inaccessible market or replace externally held NFTs silently.

## Activation gates

- Native/token, single/batch agreement and disagreement; no payout before both reveals.
- Hidden commitments, tampered reveal, task/chain/market/instance replay, duplicates, conflicting digest and late messages.
- Peer crash at every phase; both silent; finite closure without slashing silence; holds/capacity released once.
- Correct objective fraud proof slashes; rejecting payment recipients and slash beneficiaries cannot prevent closure; explicit one-shot readiness/draining prevents new assignments after completion.
- Real browser/Anvil automatic dispute and restart recovery, including family delta tasks.
- Gateway/battery consume completed only; UI marks incomplete work honestly.
- Account reconciliation, preserved old obligations, fully tested migration and verified live smoke task before claiming rollout complete.

Specialized validity proofs remain a separate benchmark track. This implementation does not deliver cheap cryptographic verification of every full brain simulation.

## Implementation refinements from real-model validation

The published min2 payloads exceed the legacy 8,192-input row limit (female 8,861; male 10,167). The synchronous contracts therefore require owner-attested support for each exact MEP and use bounded 1,024-entry row uploads up to 16,384 total entries, reserving all upload rounds at task admission. The certificate does not inherit through the base link, and is not a cryptographic proof of maximum row degree. See [the operational protocol](../../SYNCHRONOUS_VERIFICATION.md) for payment, sponsorship, gas and calibration details. Consumers accept finalized block snapshots rather than treating two confirmations as finality.
