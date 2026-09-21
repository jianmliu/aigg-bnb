# Capacity-aware host admission

A host with ten free execution slots has the same per-draw stake weight as an equally staked host with one. The difference appears under load: after the smaller host is assigned its one task, only hosts with remaining capacity can accept further assignments. Memory and bandwidth are not lottery weights and are not measured by this feature.

## On-chain lifecycle

`HostCapacity` is a shared registry. A host calls `setCapacity(uint16)` to commit to 0–64 concurrent task leases; zero is the initial value and pauses new assignments. The commitment is global across models and all authorized markets sharing that registry, including native BNB and token tasks. A single batch consumes one slot, not one slot per run. Capacity is self-declared service capacity, not proof of physical RAM, independent operators, or guaranteed throughput.

New markets may wire `setHostCapacity(address)` once, before their first successful task. Unwired markets retain existing behavior. Draws retain the same stake weighting and distinct executor snapshot, but atomically reserve slots. In capacity mode a post must obtain the full requested redundancy; otherwise reservations, task state and transferred fees revert together. The existing bounded 64×redundancy candidate search can still fail in a mostly busy roster even when some slots are free; no API promises guaranteed assignment.

An accepted result releases that executor's lease immediately. Otherwise the lease remains occupied through `postedAt + TASK_TIMEOUT`, inclusive, and ceases to count on the following block. The task's caller-supplied deadline does not set lease duration. No cleanup transaction is needed for expired leases, and reused slots are protected from stale releases. Late task submissions retain existing market behavior. Pausing or reducing capacity never clears existing leases; occupied slots may temporarily exceed the declared limit, with zero availability.

Execution occupancy is separate from result accountability. Releasing a slot does not remove task executors, results, proofs, royalties, settlement or dispute obligations. Hosts must retain or reproducibly reconstruct dispute data for the required challenge windows. An expired lease does not prove the host has stopped computing. No automatic nonresponse slashing is added here.

## Deployment and operators

For a fresh deployment, use `HOST_CAPACITY=true` with `DeployBNB.s.sol`. `MULTI_ASSET_MARKET=true` selects the multi-asset market as usual. The deployment JSON includes `addresses.hostCapacity` only when enabled.

For another market sharing the same hardware, supply `HOST_CAPACITY_REGISTRY=<existing address>`. The deployer must be able to authorize the new market in that registry (or it must already be authorized). Do not create separate registries and assume their counters are global. Manual wiring is `registry.setMarket(market, true)` then `market.setHostCapacity(registry)` before any task. Registry-owner authorization is a trust boundary: a malicious authorized market can occupy slots. Revocation prevents new reservations but does not block release of that market's existing reservations.

Hosts configure `setCapacity(n)` from their bonded instance wallet, not their delegated session key. Server operators must size n to actual independent execution workers, their slowest supported task, bandwidth, task timeout and retained dispute state. There is no GB-to-slot conversion. The current browser runs serially: the host panel exposes only pause and one slot, and verifies the running node's wallet/deployment before enabling it. Settings are global to the wallet across tabs; closing a tab does not send a pause transaction. Pause before stopping and finish outstanding work.

`GET /capacity?instance=0x...` reports registry address, market authorization, limit, active leases and free slots. It uses bounded, coalesced five-second caches and no event-log scan. These are advisory snapshots; on-chain reservation is authoritative. Unsupported legacy getters mean capacity mode is disabled, while transport errors return an unavailable response instead of pretending a host has zero load. The endpoint is independent of earnings statistics.

## Scope and verification

This change implements available-slot admission. It does not activate automatic future-child loading or sampled claims, and it does not migrate existing deployed nonupgradeable contracts. Base enrollment remains the qualification mechanism, so all derivatives in a supported base pool share the host's global capacity.

Verification includes exact idle-draw equality at capacities 1/10, saturation, future child/base sharing, native/token/cross-market reservations, payment rollback, inclusive expiry, late stale release, pause/downsize, unauthorized callers, immutable wiring and legacy behavior. API tests cover coalescing, eviction, retries and legacy RPC errors. UI tests cover wallet/chain/deployment changes, serial capacity limits and running-host identity. `npm run test:capacity` runs focused unit tests, Anvil deployment/API integration and Chromium wallet/host/task execution integration (requires Foundry, built frontend/runtime and Playwright).
