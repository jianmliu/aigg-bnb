# Bounded execution and verification sessions

Implementation: `SynchronousTaskMarket` / `SynchronousExecutionDisputes`, capability `verification.mode = synchronous-v1`. These are separate contracts, not upgrades of legacy task markets. Deployment activation must be recorded separately; source code alone does not change a live host's obligations.

The optional [`synchronous-vrf-v1` admission mode](VRF_ASSIGNMENT.md) locks the task and admitted candidate pool before requesting fresh VRF randomness. It adds a bounded waiting phase and a separate nonrefundable admission fee. It requires a new market and funded subscription; it does not change the existing live deployment automatically.

## What completion means

A host explicitly accepts **one** assignment. Assignment consumes readiness. Two assigned hosts independently execute, privately persist their results and random salts, and submit commitments before either result can be revealed. Matching roots and digests complete the task. Different roots immediately start the proof game inside the same session. Equal roots with conflicting digests end inconclusively. Agreement and adjudication rely on an independently administered honest executor; two wallets alone do not provide that independence or a standalone validity proof.

The host remains online until execution and verification end. Both missing responses and an exhausted deadline produce an inconclusive result, return the original payment asset to the client's credit, and release task holds and capacity. Silence is not slashed as false computation. A proved incorrect local computation can slash the responsible executor. Rewards, refunds and slash proceeds are withdrawable credits; receiving contracts cannot stall task closure by rejecting payment.

There is no new interactive challenge against a terminal task. The browser says it is safe to close only after a finalized chain read confirms terminal/idle state, no pending assignment, no readiness, and consumption of outstanding readiness signatures. “Finish and stop accepting” drains the active session. A second task requires explicit rearming; previous evidence remains archived. A refresh can restore the signed manifest and evidence from IndexedDB, subject to the wallet/session authorization still being valid. Clearing browser storage before closure loses that recovery path.

## Supported profiles and proofs

Residency, memory capacity and execution-proof support are different checks. The market admits only an exact MEP that its owner has certified with a measured maximum CSR row size. A base's certificate never automatically certifies descendants: the registry's base link alone does not prove identical topology. Certification is an operator attestation over verified model data, **not** an onchain proof of a global maximum. Revocation affects new admission; it does not strand an existing task.

Current limits are 16,384 inputs per row, at most 1,024 entries per row-upload transaction, and fixed complete chunks except the final remainder. Offsets, total length, claimed state, signatures and round nonces are bound and checked. Partial rows cannot enter final adjudication. The session reserves all row-upload rounds plus run/segment/neuron localization before assignment. The browser responder currently supports deterministic integer LIF profiles; contract support for another execution kind does not imply browser support.

This chunking is required for the published models. Measured maxima are 5,080 / 8,861 for female min5 / min2 and 6,660 / 10,167 for male min5 / min2. Storing an entire 10,167-entry row in one transaction exceeds the [BNB transaction gas cap](https://github.com/bnb-chain/BEPs/blob/master/BEPs/BEP-652.md). Chunking bounds each transaction, but the aggregate storage gas remains substantial; it is not a succinct proof or an elimination of duplicate execution.

`js/build_founder_profiles.mjs` reconstructs all 200 Founder payloads and measures the CSR bounds alongside their exact model and synapse commitments. `js/launch_founder_inventory.mjs --synchronous` certifies the new collection's **terms-bound** identities in bounded batches. New offspring require their own verified profile and certificate before paid execution; they must not be described as automatically eligible merely because their base is resident.

## Consumers and payments

Only state `Completed` is acceptable scientific output. `settled == true` alone is insufficient because inconclusive sessions are also closed. Gateway receipts use the accepted onchain root and verify returned bytes against the accepted digest. Gateway and battery consumers read finalized state and recheck the block hash; a fixed number of confirmations is not substituted for finality. Battery jobs recover pull refunds before retry/refund, accept adjudicated completion, and the worker independently replays output before archiving it.

BNB rewards/refunds are withdrawn with `withdrawCredit(address(0), recipient)` by the credited wallet. ERC-20 credits use the token contract address. The Host page exposes both. Native NFT royalties retain the collection settlement path. For authorized synchronous token-royalty collections, the market snapshots the holder/base recipients at completion and credits those wallets directly. A failed recipient view preserves the royalty in the beneficiary ledger; `FlyCollection.settleToken` provides exceptional recovery to the then-current holder, like the existing failed native-settlement fallback.

Relayer sponsorship is bounded and can become unavailable. The operator must explicitly provision sufficient per-instance and daily gas budgets and wallet reserve before sponsoring readiness. Every send estimates and checks remaining gas budget and the transaction cap. Admission-time reserve checks are not a global reservation for all concurrent sessions. RPC outages, exhausted sponsorship or lost browser data can still cause inconclusive closure; none is evidence of computational fraud.

## Calibration and deployment gates

The measured payload identities, kernel hash, CSR limits and local timing samples are in [the calibration record](../tasks/benchmarks/synchronous-profiles-2026-09-21.json). The male min2 5,000-step / stride-500 sample executed in about 4.64 seconds and reconstructed one 500-step segment in about 24.92 seconds on this machine. These samples use seed 7, are not a full scientific battery, and do not guarantee another host's speed.

The proposed testnet configuration reserves 7,200 commit blocks, 400 reveal blocks and 30,000 dispute blocks, with 400 blocks per dispute move. The observed chain interval was 0.45 seconds; deadlines are block numbers and wall-clock timing may change. Honest agreement closes immediately after finalized reveals; it does not wait out the maximum session. Large or unsupported tasks must be refused before host commitment rather than silently extending deadlines.

Before activation: run `npm run test:synchronous`, the full Foundry suite and existing CI checks; reconcile old tasks, bonds, royalties and all NFT owners; stage and verify the fresh mesh and inventory; preserve old withdrawal paths and journals; then switch services with the matching capability and environment. A final live paid-task receipt and safe-close state are required to call the cutover verified.
