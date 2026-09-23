# Shared VRF rounds implementation plan

> **For agentic workers:** Use subagent-driven-development for the independent contract unit; root integrates services and tests. User approved restoring shared beacon scheduling with one VRF request per round.

**Goal:** Amortize randomness across a bounded, precommitted task round without allowing post-randomness task/pool selection.

**Architecture:** Add explicit `synchronous-vrf-rounds-v1` capability (admission version 3), retaining v2. Each task escrows its fee and snapshots/reserves its eligible candidates while the round is open. Fixed close block precedes a single permissionless seal/request; callback stores one word, and each task derives distinct domain-separated draws. Hosts opt into a bounded multi-task round; each candidate/task consumes a capacity slot before the seed is requested. Frozen pending-task sets prevent later arrivals or readiness changes from modifying existing snapshots. A host cannot enter a different round until its queue drains. Preserve finite deadlines and no automatic rerolls.

**Tech Stack:** Solidity/Foundry, viem/Node, browser synchronous session journal.

## Contract interface and invariants

- New `RoundVrfAdmission`, `RoundVrfSynchronousTaskMarket`; existing v2 stays unchanged.
- Market constructor matches v2 plus trailing `uint64 roundBlocks, uint8 maxRoundTasks` (bounded <=64).
- Existing requestInfo ABI retained. State 5 means collecting, 1 awaiting callback, 2 fulfilled, 3 allocated, 4 closed. `requestInfo` synthesizes shared round state and deadline per task, without callback loops.
- Additional admission views `taskRound(bytes32)->uint256`, `roundInfo(uint256)->(uint64 closeBlock,uint64 randomnessDeadline,uint256 requestId,uint64 fulfilledAt,uint64 allocationDeadline,uint8 state,uint16 taskCount)`, `ROUND_BLOCKS()`, `MAX_ROUND_TASKS()`; market `sealRound(uint256)` permissionless.
- Collection is fixed at first task block+ROUND_BLOCKS; no early seal or adding tasks at/after close. Empty rounds request nothing. Seal before fixed timeout, one request only, callback authenticated and late/duplicate ignored.
- Pool snapshots freeze task/asset/MEP eligibility, capped stake, signer and lease. Host queue <=64, one reservation+bond hold per candidate/task. Revoke readiness affects only future admission. Task routing retains the snapshotted signer; live registry authorization remains enforced.
- `pendingTasks(host)` returns a bounded set of nonreleased reservations; `pendingTask(host)` remains its first item for legacy display. Add `hasPendingTask(id,host)` in the market and a base virtual pending-membership hook for commit/reveal/dispute guards. Round tasks execute independently, not blocked behind a disputed FIFO head. Each task has its own reserved capacity slot. No keeper-chosen timing resets.
- Exact timing: close=firstPost+ROUND_BLOCKS; randomnessDeadline=close+WAIT_BLOCKS; seal only close<=block<=deadline; callback only at/before deadline; activationDeadline=fulfilledAt+ACTIVATION_BLOCKS; session commit/reveal/total deadlines=activationDeadline+respective execution windows. Per-task lease upper bound=postBlock+ROUND_BLOCKS+WAIT_BLOCKS+ACTIVATION_BLOCKS+TASK_TIMEOUT. All callback-derived deadlines fit that bound.
- Freeze task inbox routing using snapshotted signer. Existing registry signature authorization/revocation remains live, not claimed to be cryptographically frozen. Do not change readiness signer while outstanding reservations exist; revoke readiness only changes future admission.
- Timeout before seal, after request and after fulfillment releases per-task holds/leases and refunds execution escrow, preserves nonrefundable admission credits. Each task can settle or time out independently, even when another task disputes.
- Per-task admission price is configured separately; this change reduces VRF request count, not all per-task transaction gas. No claim that round capacity always fills or that slots prove compute speed.

## Tasks

- [x] Contract tests first: multiple tasks/same pool => one request; no append/early seal/reseal; capacity refusal; per-task frozen signer/weight; deterministic allocation; out-of-order independent release; native/token costs; callback/timeout cleanup; bounded gas/code size. Implement contracts and run Foundry.
- [x] Service tests first: version3 verification, collecting/seal action, finalized progression, capability metadata, same durable outbox and budget. Update relayer/gateway dispatch, assignment membership, and candidate readiness reads to include hosts reserved in the current collecting round where appropriate.
- [x] Browser tests first: multiple independent task journals under one exclusive host lock; durable host readiness/drain journal; per-task terminal archive; round wait/seal and bounded readiness text. Never assert safe-to-close with remaining reservations.
- [x] Deployment tooling: explicit opt-in mode and constructor config, correct admission slasher/capacity authorization, inventories recognize v3. Existing live configuration remains pinned until a separately verified deployment/migration.
- [x] Integration: two paid tasks share a mock coordinator request, distinct task state survives restart, hosts settle both and holds drain. Run legacy regressions, build, independent review, record limitations.

## Verification record

- 124 Foundry tests passed across shared rounds, existing VRF and synchronous contracts.
- 120 JavaScript unit tests passed across services, browser sessions, worker evidence, capacity UI and deployment preflight.
- Local shared-round gateway integration passed: two tasks share one request across restart; independent completed receipts; zero residual host reservations; missing-word refund and late callback handling; real WASM output verification and a sponsored 1,024-entry dispute proof.
- Local subscription creation/funding/consumer enrollment and idempotent restart passed.
- Local 200-Founder inventory launch, sale/treasury receipt and resumable recovery passed with admission version 3.
- Frontend production build passed (existing large-chunk warning remains).
- Independent contract and browser/service reviews completed; admission tuple normalization, manifest-less timeout recovery and competing-keeper sealing were fixed with regressions.
- No public deployment, Render settings or live contract addresses changed. Real-network callback and integration migration remain rollout work.
