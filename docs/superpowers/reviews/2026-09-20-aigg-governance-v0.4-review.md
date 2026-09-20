# AIGG Governance v0.4: Implementation Readiness Review

**Reviewed:** 2026-09-20

**Spec:** [Governance v0.4](../specs/2026-09-20-aigg-governance-design.md), repository commit `f5e0f54a110fed33b1b4201834a8f2e10c095647`.

**Code baseline:** local checkout and pinned `contracts/lib/aigg-porw` at `f32c684075c26df8536eaac2313ad673e2ea63c0`. The existing dirty workspace was read only. No remote/deployed-state equivalence is claimed.

## Verdict

Ready for implementation decomposition and isolated foundational prototypes; **not ready to implement the complete economic state machine as a production specification**. Earlier architecture approval established internal coherence, not executable completeness. The spec itself preserves this distinction in Section 14.

The blockers below require explicit interfaces and state-transition choices, not a new product narrative. Numeric supply, prices, quorum, and durations can remain deployment configuration with test fixtures. Beneficiary rights, payment finality, cancellation semantics, and authority cannot be guessed by implementers.

## Findings

### R1 — P1: Complete-set bootstrap lacks reservation and a reversible abort path

**Spec:** Sections 4.1 and 9, lines 75–81 and 256–267.

Bootstrap requires every Founder before releasing any service budget. Current `FlyCollection.mint` is public, consumes `genesisMinted[index]`, assigns the NFT to `msg.sender`, optionally bonds that caller, and forwards the native payment (`contracts/src/FlyCollection.sol:201–220`). There is no purchase cancellation/burn/refund entry point in that collection.

**Counterexample:** if public mint remains available during batched acquisition, another account acquires the last Founder first. The bootstrap can no longer acquire its full manifest at fixed terms; earlier purchases and minted AIGG are already committed. “Pause or unwind” alone does not define how to reverse those purchases.

**Required before bootstrap implementation:** select a reserved new collection or another enforceable exclusive acquisition path; define manifest identity by genesis leaf/index rather than assuming sequential token IDs; separate `Prepared`, `Acquiring`, `Active`, and `Aborted`; specify deadline authorization, atomic refund/NFT treatment, native bond handling, and whether a failed attempt can restart. Mint accounting must separately record cumulative authorized issuance and circulating supply so burning a refund cannot silently replenish the issuance allowance. A test must front-run a batch and interrupt acquisition, then verify either prevention or a complete bounded unwind.

### R2 — P1: Service reward finality is not selected

**Spec:** Section 4.1 line 79 and Sections 8–9.

The document promises rewards for verified service after applicable settlement conditions, without selecting whether that means initial agreement or final challenge resolution. The existing market pays executors in `_pay` while starting the challenge clock (`contracts/lib/aigg-porw/contracts/evm/src/mesh/TaskMarket.sol:257–271`). Its post-settlement challenge explicitly cannot claw back task fees (`:191–196`).

**Counterexample:** colluding hosts submit the same incorrect result, collect and transfer AIGG, and are later successfully challenged. Slashing BNB does not recover their AIGG distribution. Treating the original payout as irrevocably verified service changes the advertised bootstrap assurance.

**Required before service-mining implementation:** explicitly retain optimistic payment with that limitation, or introduce pending rewards released after the dispute/challenge lifecycle. If delayed, define extended windows, active challenges, invalidated results, refunds, royalties, and reward eligibility together. The test must include a successful post-settlement challenge, not only disagreement before settlement.

### R3 — P1: Multi-asset opt-in has no execution-selection contract

**Spec:** Section 8 lines 225–229.

Providers can reject currencies and prices in the design, but the current market samples providers from model enrollment at posting, without asset or price filtering (`TaskMarket.sol:114–149`). Its posting fee is native currency (`:115`), and the task/hash ABI must be versioned for additional payment terms (`interfaces/PorwMesh.sol`, `PorwMeshHash.taskId`).

**Counterexample:** a model has BNB-only hosts and AIGG-accepting hosts. A task funded in AIGG is drawn entirely to BNB-only hosts. They can correctly refuse, yet willing hosts cannot replace the fixed roster through an unspecified acceptance step.

**Required before multi-asset market integration:** choose asset-aware admission or an explicit signed offer/acceptance and replacement protocol. Bind asset address, amount, terms version, expiry, and replay protection into the task/quote identity. Define price updates, selection cutoff, accepted versus merely selected providers, minimum fulfilled redundancy, and timeout refunds. A frontend currency selector alone does not implement consent. Preserve BNB service bonds independently.

### R4 — P1 for auctions: Pre-sale royalty attribution is not implemented by the current transfer behavior

**Spec:** Section 6.1, especially line 174.

The desired sale boundary protects accrued treasury income. `FlyCollection.transferFrom` attempts `_settle` and then transfers ownership (`FlyCollection.sol:144–151`), but `_settle` catches market errors and returns without credit (`:351–358`). Later collection credits the then-current owner.

**Counterexample:** royalty withdrawal fails during auction delivery and succeeds afterward. The buyer can receive revenue that accrued before treasury sold the NFT. The draft permits a reliable cutover or explicit disclosure but does not choose one or bind it into auction terms.

**Required before auction implementation:** select a strict settlement precondition with a recoverable failed-auction path, separate income checkpoints, or explicitly priced sale of pending claims. Define which policy is used and how receipts prove it. Test market failure at transfer and subsequent recovery. Do not assume ERC-721 transfer alone preserves seller income.

### R5 — P2: Governance activation and historical entitlement need executable policy

**Spec:** Sections 4.1 line 97, 7.1 line 190, 8.1 line 245, and 14.

The draft deliberately distinguishes acquisition completion, governance activation, and initial distribution completion, but does not define machine-checkable gates or who certifies them. It also proposes permanent cohort rights after stake withdrawal while explicitly requiring approval. This is a coherent option, not an already approved consequence of staking.

**Counterexample:** one implementation activates governance after the first host payout; another waits for all scheduled rewards. One retains perpetual historical entitlements; another pays only while stake remains locked. Both could be built from the broad product description, but they create different ownership and issuance control.

**Required before the relevant modules:** publish transition predicates and authorities; define residual/expired escrow handling; explicitly choose historical versus continuing-stake entitlement. Freeze the election denominator and quorum semantics. AIGG service collateral remains deferred until its separate completion and activation gates are specified. These choices do not block a standalone asset ledger prototype.

## Recommended Implementation Boundary

Proceed first with a narrowly scoped foundation package, using fixture tokens and local tests:

- Explicit payment-asset identity and versioned task/quote schemas.
- Per-asset escrow, pull payouts, refunds, and royalty accounting, with native BNB regression coverage.
- A restricted acquisition/issuance controller prototype with cumulative mint-cap accounting and a reserved mock Founder collection.

Before integrating that package into a working service-mining launch, resolve R1–R3 and pin the intended upstream contract revision. Prefer a versioned collection/market over silently changing semantics for existing collections. The prototype does not authorize deploying tokens or configuring real issuance.

Then implement Founder acquisition and host distribution; add treasury auctions after R4 is resolved. Implement ongoing staking and vote incentives after R5's rights are approved. Leave AIGG service collateral and open subnet competition for their stated later stages. Do not require those later features to launch BNB-bonded service mining.

## Validation Performed

Read the full v0.4 spec and checked relevant local collection, task-market, hashing, and instance-bond code. An independent reviewer evaluated economic state-machine completeness. No contracts were modified and no runtime test suite was run: this is a static design-readiness review, not evidence that any proposed feature passes execution tests.
