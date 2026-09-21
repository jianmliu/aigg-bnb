# BSC testnet synchronous verification migration — 2026-09-21

This migration replaces the active market with bounded execution-and-verification sessions. Two ready hosts commit before either reveals. Agreement or adjudication completes the task; expiration closes it inconclusively and refunds the original payment asset. Silence is not computational fraud. Terminal tasks cannot acquire new interactive challenges.

The implementation is PR #94, merged as `4f48ee38a6a7b1da1ef702803481245f929c2a7e`. Operational semantics, trust assumptions and measured witness limits are in [SYNCHRONOUS_VERIFICATION.md](SYNCHRONOUS_VERIFICATION.md). This is BSC **testnet**, not a mainnet launch.

## Contracts and inventory

All new addresses and transaction receipts are recorded in [the public migration record](../tasks/live-runs/synchronous-migration-2026-09-21.json). The fresh collection is needed because its market reference and MEP royalty terms are immutable. Genesis v2 still contains the same 100 female and 100 male Founder recipes and published deltas. New token numbers are scoped to the new collection; old NFTs are neither transferred nor burned.

Adopt remains 0.01 tBNB paid to the existing treasury `0x1Bef7990Ea5d9C761aACe71c48432078AAC43708`. Breed remains 0.005 tBNB, with a 0.0001 tBNB hatch bounty. All four bases and 200 exact Founder MEPs receive independently measured row-size support certificates. A future child does not inherit a parent's certificate automatically.

At finalized block 132401669, the preceding family market had never posted a task, the market and instance registry balances were zero, and all 200 preceding Founders belonged to its inventory vault. Its sale was paused in transaction `0xfdb99a79a61e8bf7af13b7fd93890984d25883e203e0a816079566355af4965e`. Do not reopen that sale alongside the replacement inventory.

Earlier bonds, NFT ownership and royalties remain on their original contracts. In particular, the 0.0712 tBNB in the pre-family instance registry and 0.000204 tBNB in the pre-family market were not moved. Their withdrawal instructions remain in [the preceding migration record](FAMILY_MIGRATION_2026-09-21.md).

## Service transition

`render.yaml` pins the new contract addresses and `PORW_VERIFICATION_MODE=synchronous-v1`. The gateway uses `/var/data/gateway-synchronous-v1-state.json`; previous gateway state and count files remain archived. The selected RPC is unchanged: `https://bsc-testnet-dataseed.bnbchain.org/`.

Sponsorship is explicitly bounded at 160 million gas per host/epoch and 350 million gas per day. Readiness admission checks the relayer's 350-million-gas wallet reserve. Each transaction checks its estimate against remaining budget and the chain transaction cap. This is not a global budget reservation across concurrent sessions.

Configured windows are 7,200 blocks to commit, 400 to reveal, and 30,000 for disputes; individual proof rounds use 400 blocks. Successful agreement completes immediately after both reveals. The longest window reserves enough blocks for bounded row uploads; it is not the expected runtime of a normal task. The actual four base profiles were measured, and the 1,024-entry sponsored proof transaction used 7,272,092 gas in integration testing.

## Validation and limits

Before deployment: 318 contract tests, 48 synchronous/profile tests, real-browser agreement/disagreement/reload/batch/timeout scenarios, real HTTP sponsorship, finalized gateway acceptance, and both fresh synchronous and legacy 200-Founder inventory rehearsals passed. GitHub CI for PR #94 passed.

Live service, frontend and paid-task status is tracked in the public record. A local pass is not evidence that a live step has completed.

Two hosts controlled by the same operator can validate integration but do not establish executor independence. This mechanism assumes an independently administered honest executor; it is not a succinct proof of every computation. Battery budgets/workers and conversion adapters require separate deployment. The selected public RPC rejects historical event queries. Synchronous gateway and battery routing therefore read the on-chain readiness signer directly and validate its live delegation against the assigned session, without scanning delegation logs. The older keeper event-log scan remains a separate operational limitation.
