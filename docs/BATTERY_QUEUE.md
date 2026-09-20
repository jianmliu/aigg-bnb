# Budgeted battery delivery

## What is implemented

`BatteryBudget.breed(a,b)` atomically pays the existing collection's breed fee, creates a separate `BatteryJob` funded with the fixed battery execution budget, and transfers the newborn NFT to the caller. The caller must own both parents and approve this adapter for them. Existing individuals can be funded once through `fund(tokenId)`. No new AIGG, automatic swap or liquidity provision is involved.

Each job keeps its own balance. Neither treasury nor the operator can withdraw execution reserves. Its fixed policy binds the exact battery file hash, ordered input root, run count, steps, stride, redundancy, maximum attempts, per-attempt fee and funding lifetime. Changes require a new factory/policy. Job refund rights remain with the original payer even if the NFT changes hands.

One attempt is one `TaskMarket.postBatch` call. The job is the market client and receives its own market refunds. Posting and recording the task ID occur in the same transaction. The operator cannot post a second active task, change the model bound to the NFT, alter the committed battery, raise the task fee, or spend more than the funded bounded attempts. A no-result or insufficient-redundancy attempt can be retried only after settlement and the challenge window, subject to remaining funds, attempts and the funding lifetime.

The execution fee is distinct from the collection breed fee and wallet gas. The collection still splits its fee into hatch bounty and treasury proceeds. The operator must separately fund its BNB gas wallet and independent verification compute; those costs are not debited from the execution escrow. The UI quotes these distinctions. The old collection's direct `breed` entry point still exists on-chain, but the updated frontend's Breed action requires a configured battery factory and does not silently create an unfunded child.

## Queue and evidence

`battery/worker.mjs` scans funded job addresses from the configured collection and factory. Chain state is authoritative; local JSON stores status and output artifacts, not spend authority. A mined post with a lost RPC response is discovered on the next pass. A crash after writing results but before `deliver` safely repeats verification/delivery checks. Use one worker instance per factory and one dedicated signer, never a wallet shared with another transaction sender.

States include funded, waiting for owner model registration, waiting for reconstructed payload, waiting for capacity, posted/executing, in dispute, awaiting finality, verifying outputs, delivered, needs attention, and refund available. A failed RPC or invalid artifact is surfaced rather than marked complete. Worker retries are bounded by the contract; it never silently tops up a job.

The worker validates the exact battery policy and registered model commitments before spending. It sends the batched request to the selected hosts using their live session keys and can submit their signed results using its own gas. Result consensus is read from the chain. After settlement, no active dispute, no repudiation, the full challenge window, and the required number of agreeing executors, the worker independently replays the battery from a verified reconstructed payload. The per-run execution roots must reproduce the settled batch root before publication.

Artifacts contain every stimulus/seed row, execution roots, count digests, total spikes, neurons reached, descending counts in the latter half of the run, model/profile/battery identities and the chain task. The job stores the hash of the exact persisted artifact bytes. This initial implementation runs an independent local replay rather than trusting unbound per-run counts from the batch reply; provision CPU, memory and an archival backup accordingly. A completed battery is measured phenotype data, not automatically a rarity score: percentile/rank calculation still requires an explicit versioned reference cohort and scoring definition.

`artifactHash` is an operator publication attestation gated on chain finality, not an on-chain proof of data availability or of every scientific readout. Clients can fetch the artifact, check its hash and independently replay it. A malicious or unavailable operator can delay delivery; unused funds are recoverable subject to the conditions below.

## Prerequisites and refunds

After hatch, the child payload must be derived from its parents and seed and registered by the NFT owner using the collection's existing registration path. The queue waits for this step; it cannot bypass owner authorization. Supply the reconstructed, published payload at `<BATTERY_MODELS>/<modelId>.bin`. Registration/ownership is not proof of valid biological lineage, and this coordinator does not upgrade legacy lineage enforcement.

After successful delivery, the original payer can recover unused reserves. After funding lifetime expiry, the payer can close an unposted job or recover the remainder of a finalized attempt. Pending or disputed tasks must be resolved before refund. Anyone can call the existing market's settlement method when eligible. Paid execution fees are not clawed back by later successful challenges; retries use remaining reserves. A fully consumed budget may have no refundable amount. A rejected refund transfer reverts and remains recoverable.

## Deployment and operation

1. Build contracts: `forge build --root contracts`.
2. Run `node battery/policy.mjs flybnb/battery/battery-v1.json` to derive the exact immutable file hash and input root. The production v1 battery has 39 runs. Never reuse these values with another file, layout or version.
3. Configure `BATTERY_COLLECTION`, `BATTERY_MARKET`, `BATTERY_OPERATOR`, `BATTERY_VERSION_HASH`, `BATTERY_RUNS_ROOT`, `BATTERY_RUNS`, `BATTERY_STEPS`, `BATTERY_STRIDE`, `BATTERY_REDUNDANCY`, `BATTERY_ATTEMPTS`, `BATTERY_FEE_WEI`, and `BATTERY_LIFETIME_SECONDS`. Review the full price and expiry before using `script/DeployBatteryBudget.s.sol`. Simulate with the intended signer/RPC before broadcasting. No production price or address is supplied by this change.
4. Set relayer `PORW_BATTERY_BUDGET` to the deployed factory. Optionally set `PORW_BATTERY_API` to the worker's public read-only endpoint for detailed status and result links. The frontend verifies factory collection binding; absent configuration disables funded breeding. Existing collection functions are not upgraded by this setting.
5. Start the worker with a supported Node runtime and `BATTERY_DEPLOYMENT` (trusted mesh JSON), `BATTERY_BUDGET`, `BATTERY_KEY` (dedicated secret), `BATTERY_SPEC`, `BATTERY_MODELS`, `BATTERY_STATE` (persistent volume) and `BATTERY_RELAY` (WebSocket URL). Command: `node battery/worker.mjs`. The signer must match the immutable operator and hold BNB for gas.
6. Optional settings: `BATTERY_REGISTRY_FROM_BLOCK` bounds session-log scans; `BATTERY_TASK_BLOCKS`, `BATTERY_RESULT_TIMEOUT_MS`, `BATTERY_POLL_MS`, `BATTERY_PORT` (8792), `BATTERY_HOST` (127.0.0.1). Publish only the read-only endpoints `/<jobAddress>.json` and `/artifacts/<jobAddress>.json` behind the deployment's HTTPS proxy. Back up the state volume and artifacts. There are no remote spend endpoints.
7. Refresh the Battery queue panel to inspect status, fund an existing individual, download results or recover eligible reserves. Parent approval transactions and user-initiated breed/fund/refund gas are paid by that user. No live deployment or additional treasury spending has been performed by this implementation task.

## Validation

- `forge test --root contracts --match-contract 'BatteryBudgetTest|BatteryJobTest'`
- `node --test test/battery_queue.mjs`
- `FOUNDRY_BIN=<foundry-bin> node test/e2e_battery_queue.mjs`
- `npm run build:frontend`
- `FOUNDRY_BIN=<foundry-bin> node test/e2e_flies.mjs`

The local chain end-to-end fixture uses a small six-run battery on a synthetic brain to exercise actual hosts, batch submission, settlement, coordinator restart, independent replay, artifacts and unused-budget recovery. The canonical 39-run battery remains version-pinned; a full real-brain delivery/load benchmark is a deployment acceptance step, not claimed by the synthetic test.

## Optional AIGG settlement

Native BNB jobs remain supported. See [Multi-asset battery design](MULTI_ASSET_BATTERY.md) for the separate ERC-20 factory, optional BNB exact-output adapter, host opt-in, royalty callback, worker configuration and migration limits.
