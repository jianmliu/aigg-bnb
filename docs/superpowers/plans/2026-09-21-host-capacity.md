# Host Capacity Implementation Plan

> **For agentic workers:** Use subagent-driven-development for bounded contract implementation and independent review; integrate UI/relayer locally.

**Goal:** Admit hosts with free concurrent execution slots to stake-weighted task draws.

**Architecture:** Shared optional HostCapacity contract owns bounded expiring reservations across authorized markets. Markets atomically reserve during draws and release accepted submissions. A cached relayer endpoint and host dashboard expose honest capacity commitments without changing draw weight.

**Tech Stack:** Solidity/Foundry, Node/viem, React/Vite.

### Task 1: Contracts and lifecycle (delegated)
- [x] Add failing tests in upstream contracts/evm/test/HostCapacity.t.sol and parent contracts/test/HostCapacity.t.sol for spec invariants.
- [x] Implement upstream contracts/evm/src/mesh/HostCapacity.sol and capacity hooks in TaskMarket.sol; mirror hooks in parent contracts/src/MultiAssetTaskMarket.sol.
- [x] Verify with forge test in both roots; preserve legacy suites and task/dispute snapshots.

### Task 2: Deployment and API (local)
- [x] Wire optional HOST_CAPACITY flag in contracts/script/DeployBNB.s.sol; output hostCapacity address when enabled. New markets only.
- [x] Add relayer/capacity.mjs reader with bounded/coalesced cache; discover via market getter; capability-absent uses legacy, transport errors must fail closed.
- [x] Add GET /capacity?instance=... independent of earnings/log scan; advertise capability in /deployment.
- [x] Unit tests for cache, error handling and deployment mapping.

### Task 3: Host controls (local)
- [x] Add standalone HostCapacity panel/helper with current capacity, busy/free, pause and 1-slot browser resume. Wallet changes and wrong-chain writes guarded. Explain serial runtime; never advertise unsupported parallel execution.
- [x] Test behavior, build and check older frontend behavior.

### Task 4: Validation and review
- [x] Review spec and contract/API boundaries independently; resolve findings.
- [x] Run all Solidity suites, targeted JS tests and frontend build; integration test real market/registry/API against Anvil.
- [x] Document commands, limitations and activation; commit both repositories locally with correct gitlink. No production migration in this request.

## Verification results

- Upstream Foundry: 134 tests passed; parent Foundry: 223 tests passed.
- Capacity/API/UI/base/RPC unit tests: 20 passed; wallet and memory regressions passed.
- Real Anvil fresh multi-asset deployment and shared-registry deployment, API snapshots and legacy mode passed.
- Chromium flow: wallet bond/delegation, two loaded brains, opt-in slot, actual task execution/submission/release, pause and payment passed.
- Independent review found running-node identity mismatch after wallet reconnect; fixed with immutable startup identity and regression tests.
- Initial browser invocation used production build with hidden mesh selector; rebuilt in test mode and reran successfully.
- Nothing deployed to live chain. Automatic future-child loading and sampled claims remain separate work.
