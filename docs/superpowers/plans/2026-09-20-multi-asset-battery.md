# Multi-asset Battery Implementation Plan

**Goal:** Preserve native tasks and add ERC-20 settlement and an optional BNB conversion entry.
**Architecture:** Local market port, separate token job/factory, existing native ABI unchanged.
**Tech Stack:** Solidity, Foundry, Node, viem.

- [x] Write failing multi-asset market tests in contracts/test/MultiAssetTaskMarket.t.sol; run forge test --root contracts --match-contract MultiAssetTaskMarketTest.
- [x] Implement contracts/src/MultiAssetTaskMarket.sol and TokenTransfer.sol. Bind token/client/chain/market to IDs, filter hosts, isolate royalties/refunds, reject nonexact transfers.
- [x] Write failing token battery/adapter tests; implement TokenBatteryJob.sol and TokenBatteryBudget.sol. Preserve parent ownership, exact-output budget, max input/deadline and original payer refunds.
- [x] Extend battery/worker.mjs using explicit token mode and opted-in capacity; record token in artifacts.
- [x] Run focused Foundry tests, native battery regressions, node queue tests, frontend build, diff checks; update docs with actual verified scope.

The user approved the design and requested implementation in the current workspace. Preserve all previous uncommitted work. Do not deploy or change treasury liquidity.

## Completion evidence

- Read-only plan/security review identified royalty receiver compatibility, historical dispute flags, receiver-mode snapshots, and wallet chain changes during approvals; addressed with code and tests.
- 163 selected Foundry contract regressions pass (includes inherited fixture regression tests, not 163 new tests).
- Token live-node queue: two hosts receive tokens, restart does not double-post, output artifact pins payment token, unused tokens refund, host API does not label tokens as BNB.
- Browser: native and BNB-to-token Breed, quote requirement, route switching, host opt-in/out; inventory Adopt regression passes.
- Ten Node tests cover queue recovery, currency-separated statistics and wallet chain/account binding. Frontend build, environment mapping, memory regression and diff checks pass.
- No deployment or treasury liquidity action performed.
