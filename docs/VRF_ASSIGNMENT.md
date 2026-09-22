# Locked-pool VRF assignment

This is a new admission mode, `synchronous-vrf-v1`, for the existing two-executor synchronous verification protocol. It is not an upgrade of an already deployed immutable market. No live VRF activation is implied by local mock-coordinator tests.

## What changes

A client irrevocably posts the exact task, execution fee and separate positive admission fee. The market snapshots all qualifying members of its bounded, opt-in ready roster before requesting one Chainlink VRF v2.5 word. The word selects two distinct hosts with probability weighted by their snapshotted effective stake, without replacement. The caller supplies neither a candidate list nor a seed.

The candidate set, weights, signers and capacity reservations cannot change after posting. Changing stake, readiness, token acceptance, claims or capacity later cannot improve a draw. No cancellation, rerequest, fallback beacon, replacement host or reselection exists. Repeating a task with a different nonce purchases another independent request and pays another admission fee.

This prevents free offline nonce grinding against an already public beacon. It does not prove computation correctness or prevent colluding hosts. Scientific experiment identity, repeated experiment disclosure and publication policy remain separate requirements.

## Host lifecycle

Readiness registers a host in a global bounded roster with an immutable readiness TTL. Positive stake, no pending exit and configured capacity are required. A full roster rejects a new arm, not task posting. Historical registry entries do not fill the roster; expired seats can be pruned and reused. The roster is shared across models, so bonded Sybil seat occupation remains a deployment limitation.

Posting filters that roster by base residency, accepted payment asset, available capacity and signer lifetime. Every qualifying candidate consumes readiness, reserves one slot and holds its bond. Phase **6** means awaiting randomness; it is neither completion nor permission to close the host page. After confirmed allocation, unselected candidates are released and must explicitly rearm. Selected hosts retain their existing reservations through the finite execution and verification session. Two distinct addresses do not imply two independently administered operators.

Task announcements use the captured `taskSigner(taskId, host)`. Registry delegation remains the authority for execution signatures: revoking a key can make the session inconclusive, but never causes a new draw. Browser closure is safe only after finalized release and no replayable readiness authorization remains.

For posting block P, VRF fulfillment block F, configured wait W, activation allowance A and execution duration T:

- Candidate lease and delegation horizon: P + W + A + T.
- Randomness must arrive no later than P + W.
- Allocation must occur no later than F + A.
- Execution deadlines start from F + A, regardless of who calls allocation or when.
- No timely word: expiry is possible strictly after P + W.
- A timely word blocks randomness timeout; delayed allocation can expire only after F + A.

A permissionless caller can allocate or expire. Relayer endpoints authenticate sponsorship independently of that permissionless on-chain right. The callback only stores the first timely word and fulfillment block; all loops and payments happen outside fulfillment.

## Accounting and client compatibility

Each supported asset has a fixed, positive admission fee. Native and ERC20 tasks escrow execution plus admission in the same asset. Admission fees accrue separately to the immutable fee recipient; inconclusive execution refunds only the execution fee. Coordinator subscription funding is independent: token admission receipts do not automatically convert to BNB or LINK.

The gateway persists the original task id, nonce and signed raw posting transaction before broadcast, waits through phase 6, advances the same request and records admission transactions. Receipts expose `fee_wei`, `admission_fee_wei`, `total_escrow_wei` and `admission_fee_refundable: false`. Successful-call usage includes the admission expense. Existing failed-call user billing remains zero: **the gateway bears the spent admission fee on failed calls**, and `protocol_expenses` exposes that fact. Upstream billing must not mistake an execution refund for a full protocol refund.

VRF gateway startup requires explicit positive `GATEWAY_VRF_ADMISSION_BUDGET_WEI`: a lifetime operator spending allowance, not a daily reset. The durable `<GATEWAY_STATE>.admission.json` ledger reserves cost before broadcasting, independently of pruned call history. Restarting or resuming the same task does not reserve twice. Uncertain or failed broadcasts conservatively retain their budget reservation. Preserve this ledger with the gateway state; deleting it resets the local protection. A single gateway process must own both files and the sending wallet.

Existing BatteryBudget/TokenBatteryBudget policies cover execution fees only. The battery worker refuses VRF mode until budgets explicitly escrow admission cost per attempt; do not enable or silently subsidize old policies on the new market. Legacy synchronous-v1 remains supported.

## Deployment prerequisites

Deploy a new `VrfSynchronousTaskMarket`, its constructor-created immutable `VrfAdmission`, and a matching `SynchronousExecutionDisputes`. Configure capacity authorization for the market (required by its setter) and controller (which owns actual leases), and slasher authorization for the controller's bond holds and the dispute contract's existing responsibilities. Certify exact supported profiles before use. Do not repoint existing NFT or battery contracts whose immutable market differs.

Use a real, sufficiently funded VRF v2.5 subscription, add the **admission controller** as its consumer, and verify coordinator, key hash, confirmation count, callback gas and billing asset against the official network configuration. The controller is the consumer, not the market. Choose wait and activation windows long enough for request confirmations, chain finality, service polling and the allocation transaction. Admission fee calibration must account for request cost and candidate-lock griefing; a merely positive fee is not proof of economic security.

Official BSC testnet settings checked 2026-09-21: coordinator `0xDA3b641D438362C440Ac5458c57e00a712b66700`; 50-gwei key hash `0x8596b430971ac45bdf6088665b9ad8e8630c9d5049ab54b14dff711bee7c0e26`. Recheck before deployment. No subscription ID is supplied or invented here.

Set `PORW_VERIFICATION_MODE=synchronous-vrf-v1` only for the new market. Services and browser reject admission version mismatch; `/deployment` publishes the controller, candidate bound, readiness TTL, wait/activation windows and native admission fee. Keep the old market and claims reachable during any audited migration.

A real network acceptance run must demonstrate: subscription charge and authenticated callback; exact locked pool and two assignments; result completion; released nonselected and selected reservations; fee conservation; safe host closure; and no public-beacon fallback. A mock coordinator cannot provide this live acceptance evidence.

Sources: [Chainlink VRF security considerations](https://docs.chain.link/vrf/v2-5/security), [supported networks](https://docs.chain.link/vrf/v2-5/supported-networks).

## Local validation

The configured global roster contains **32** seats. A 64-seat cold-lease fixture required about 25.8 million gas, so 64 is not a deployable bound with the current capacity contract. With real MEP/base registration and nonzero-epoch residency claims, 32 hosts with 63 preexisting active leases each measured: native admission 13,476,979 gas; token admission 13,678,235; allocation 5,913,066; waiting expiry 6,155,148. Tests additionally reserve 31,000 gas for transaction overhead. These use a mock VRF coordinator; real coordinator request overhead and gas-lane economics still require deployment calibration.

Compiled runtime sizes: market 23,922 bytes, controller 9,375 bytes. The existing dispute contract remains 24,541 bytes. All are below EIP-170.

Read-only deployment checks (after building artifacts):

```sh
node js/check_vrf_deployment.mjs --rpc "$PORW_RPC" --market "$PORW_MARKET" --chain-id 97
```

The tool checks a finalized, hash-rechecked snapshot: chain, code existence, controller/market/dispute/registry bindings, capacity and slasher authorization, the known BSC testnet coordinator/key hash, confirmations 3–200, callback gas 100,000–2,500,000, nonzero subscription identifier, windows and native fee. `configurationValid` is only this configuration result. It deliberately returns `liveProofVerified: false`; subscription funding, consumer enrollment, request pricing and actual callback delivery remain separate required checks.

Run local tests with `npm run test:vrf` (Foundry must be on PATH; set `FOUNDRY_BIN` for the Anvil harness). The full Foundry suite also checks v1 compatibility. Browser tests cover three-candidate release/rearm and a batch disagreement through reload, proof and slash.
