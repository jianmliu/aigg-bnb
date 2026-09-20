# Multi-asset tasks and optional BNB-to-AIGG breeding

Status: implemented locally; no deployed addresses or liquidity configuration.

Users may continue paying BNB. Native Breed locks BNB and posts native tasks. An optional token-budget factory/adapter buys an exact ERC-20 budget with BNB and locks it before creating the child. Direct token funding supports treasury-funded Founder jobs. Founder inventory sale proceeds remain treasury BNB; sales do not automatically repeat completed batteries or add liquidity.

## Protocol

`MultiAssetTaskMarket` is a locally maintained port of the pinned upstream TaskMarket, with the original native task ABI and IDs preserved. Port baseline: `aigg-porw` commit `f32c684075c26df8536eaac2313ad673e2ea63c0`; the submodule itself is unchanged. Upstream market fixes must be reviewed and carried into this local port. Token tasks hash a versioned domain, market, chain, token, client and original task/batch hash; result signatures bind that ID. `paymentToken(taskId)` is immutable once posted. Native currency is address zero. Registry bonds and challenge deposits remain native.

Only owner-allowlisted conventional, non-rebasing, non-fee ERC-20s may be posted. Actual inbound balance must equal the fee. Hosts explicitly opt in per ERC-20 before selection; native remains the legacy default. Selection is snapshotted, so later opt-out does not invalidate an active task. Token tasks require all requested executors. Fees, refunds and royalties stay in the task asset; asset ledgers never net against native balances. Rounding remainder returns to the task client.

## Budget and conversion

The native BatteryBudget/BatteryJob path remains unchanged. TokenBatteryBudget and TokenBatteryJob lock one immutable asset and the same fixed battery policy. Treasury can fund an NFT it owns directly with tokens. A user approving the factory for both parents can breed with a token execution budget plus the native collection fee, or use `breedWithBNB` with a configured immutable V2-compatible exact-output router and direct WBNB/token path. The collection fee stays native.

The quote specifies exact token output, maximum native input and an absolute deadline signed by the user. Conversion, child creation and escrow funding are atomic. Excess BNB is returned to the payer. The operator cannot exchange the escrow during queuing. Refunds of unused execution reserves are denominated in the locked token, not the original BNB purchase cost. No automatic retry in a different currency.

A liquidity pool is an independently provisioned treasury operation. No router, AIGG address, price, budget or liquidity depth is assumed. The adapter checks actual token receipt; untrusted arbitrary swap calldata is not accepted.

## Integration and boundaries

The battery worker selects native or token factory ABI explicitly; token capacity counts opted-in eligible hosts. Artifacts record the payment asset. Existing relay results continue signing the on-chain task ID. A new market requires fresh dispute wiring and domain configuration; this is not an in-place upgrade. The UI defaults to the native factory. When a token factory is configured, users can select AIGG task settlement while still paying BNB, request a ten-minute exact-output quote with a visible 1% input tolerance, and approve/sign the checkout. Both routes retain independent job lists. A host can opt in/out from its dashboard; token earnings are displayed separately from BNB, currently in token base units.

EOA token royalties accrue separately for `withdrawTokenRoyalty`. The updated FlyCollection implements an authenticated funded callback: the market transfers the royalty, then the collection credits the current NFT owner and immutable base vendor at task settlement. `withdrawToken(token)` collects these credits. Contract receivers must be allowlisted and implement the callback; delivery mode is snapshotted at posting. Native royalties are unaffected. Token factories reject royalty-bearing collections bound to another market. Old deployed collections cannot acquire this callback and require an explicit migration; do not allowlist them.

The new market exposes `disputeResolved(taskId)` without changing the historical `disputed` flag consumed by legacy dispute code. Token jobs and updated native jobs distinguish active disputes from completed ones; accepted results still require the challenge window and configured redundancy. Repudiated results never qualify for delivery. The worker handles both markets, but old native markets lacking this signal retain their original dispute limitations.

## Acceptance

Contract tests cover asset-bound IDs, explicit host acceptance, exact receipt, refunds and royalty segregation; adapter tests cover exact output, deadline/slippage rollback, child ownership, payer refunds and no duplicate funding. Native contract/queue tests and frontend build remain regression checks. No production deployment or swap is part of this change.

## Deployment configuration

1. Build and simulate `DeployBNB.s.sol` with `MULTI_ASSET_MARKET=true` for a new mesh. Its default remains the original native market. Domain separators and ExecutionDisputes are wired to the new address. Do not overwrite a production deployment file merely to reuse registries.
2. Deploy a collection against this market. For token royalties, use the updated FlyCollection. Market owner enables the conventional AIGG token with `setTokenAllowed(token,true)` and the collection with `setTokenBeneficiaryAllowed(collection,true)`. Revocation affects admission only; already-posted tasks can settle.
3. Derive the policy from `battery/policy.mjs`. Deploy `DeployTokenBatteryBudget.s.sol` using the usual battery fields plus `BATTERY_PAYMENT_TOKEN`, `BATTERY_FEE_UNITS` (raw token units per batch attempt) and optional `BATTERY_SWAP_ROUTER`. The router must be a reviewed V2-compatible exact-output native router with `WETH()` and a funded direct wrapped-native/AIGG pool. Zero router supports treasury token funding only.
4. Run the worker with `BATTERY_ASSET_MODE=token`, its token factory and a separate persistent state directory. The operator still pays BNB gas. Native worker/factory can coexist; use separate operators if running separate senders to avoid nonce contention.
5. Set relayer `PORW_TOKEN_BATTERY_BUDGET` and optional `PORW_TOKEN_BATTERY_API`, alongside the existing native `PORW_BATTERY_BUDGET`/`PORW_BATTERY_API`. The current token checkout is labeled AIGG, so configure the actual AIGG contract, not another asset.
6. Host wallets explicitly call `setAcceptedToken(token,true)` or use the dashboard toggle. Already-selected assignments survive opt-out. Queue capacity checks count only opted-in hosts.

BNB inventory-sale revenue and liquidity provisioning remain separate treasury actions. There is no automatic sale-proceeds swap, liquidity deposit or live on-chain transaction in this implementation. There is no detached quote signature: parent IDs, native cap and deadline are authorized by the user's own transaction.

## Test commands

- `forge test --root contracts --match-contract 'MultiAsset.*Test|TokenBatteryTest|FlyTokenRoyaltyTest|TokenRoyaltyIntegrationTest|BatteryJobTest|BatteryBudgetTest'`
- `node --test test/battery_queue.mjs test/provider_stats.mjs`
- `TEST_TOKEN_BATTERY=1 FOUNDRY_BIN=<foundry-bin> node test/e2e_battery_queue.mjs`
- `FOUNDRY_BIN=<foundry-bin> node test/e2e_flies.mjs`

The live-node local-chain test checks two hosts earn tokens, exact task asset identity, restart recovery, output artifacts and token refunds. The browser fixture exercises both BNB native and BNB-to-token checkout against a deterministic test router. It does not establish production pool liquidity or fork-test a particular production router. Full real-brain 39-run load acceptance remains separate.

Validation recorded: 163 related Foundry regressions pass, plus live token-batch/queue restart, browser native/token checkout and host opt-in/out, Adopt regression, ten Node checks, frontend build and environment mapping. These are local results, not a live-network deployment claim.
