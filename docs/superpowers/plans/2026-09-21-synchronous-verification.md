# Synchronous verification implementation plan

> **For agentic workers:** Use subagent-driven-development for bounded implementation and review tasks, or executing-plans for sequential execution. Do not deploy until the integrated activation gates pass.

**Goal:** A browser host finishes a finite execution-and-verification session before payout and may then disconnect without a later interactive obligation for that task.

**Architecture:** Separate opt-in synchronous market/dispute contracts preserve the legacy mesh. Two assigned hosts commit and reveal results, then agree or play a bounded proof game. The browser and sponsored relayer automate the session; downstream consumers accept only completed results.

**Tech Stack:** Solidity/Foundry, viem, existing deterministic WASM executor, browser workers/IndexedDB, Render relayer and gateway.

## 1. Freeze contract/client interfaces

- [x] Review the companion spec against TaskMarket, MultiAssetTaskMarket, ExecutionDisputes, InstanceRegistry and the browser proof API.
- [x] Define commitment, reveal, dispute-move authentication, task-state/party-state getters, one-shot readiness and events; use exact ABI fixtures as the integration boundary.
- [x] Resolve total deadline and stake/slot ownership on every terminal transition before coding.

## 2. Contracts

Files: new `contracts/src/SynchronousTaskMarket.sol`, `contracts/src/SynchronousExecutionDisputes.sol`; new `contracts/test/SynchronousVerification.t.sol` and token/batch coverage.

- [x] Write failing tests for both-host commitment/reveal, payout escrow, expiry, replay and objective disagreement.
- [x] Implement contracts preserving asset identities and royalty/refund accounting, with finite deadlines and no later challenge path.
- [x] Add rejecting-recipient, task-hold, capacity-release and native/token fuzz invariants, including a rejecting slash beneficiary.
- [x] Run focused tests, full contract suite, size checks and independent security review.

## 3. Browser/relayer session

Files: new client session module and journal tests near `frontend/src/core/`; bounded proof responder using `contracts/lib/aigg-porw/web/porw-browser/node.js` APIs; new relayer routes/module beside `relayer/relayer.mjs`.

- [x] Write protocol tests before implementation, including restart between commit and reveal.
- [x] Authenticate and sponsor bounded moves; preserve budgets and client restrictions.
- [x] Keep exact task reconstruction/proof material available through terminal state; never silently evict pending evidence.
- [x] Add actual browser/Anvil tests for honest agreement, disagreement and peer failure through the total deadline.

## 4. Consumers and UI

Files: `frontend/src/ui/HostDashboard.jsx`, controller/session bindings, `gateway/gateway.mjs`, `battery/worker.mjs` and their focused tests.

- [x] Add explicit verification states and safe-to-close indicator based on pending sessions.
- [x] Ensure inconclusive does not become completed, billed inference or a validated battery row.
- [x] Preserve legacy behavior using the deployment capability; old clients fail closed on synchronous tasks.

## 5. Migration and publication

- [ ] Reconcile live task, bond, royalty and inventory states immediately before migration.
- [ ] Rehearse complete deployment and any required collection transition on Anvil.
- [ ] Commit/review/merge code, deploy new contracts and matching service/frontend versions, preserve old claims and keys.
- [ ] Exercise a live paid task through finality and confirm that later challenges cannot create host obligations.
- [ ] Record addresses, receipts, version hashes, measured deadline parameters and any limitations; do not describe a partial deployment as complete.
