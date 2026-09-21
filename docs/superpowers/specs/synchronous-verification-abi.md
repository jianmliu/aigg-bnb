# Synchronous verification ABI v1 (implementation integration boundary)

`protocolVersion() returns (uint256)` is 1. Deployment descriptor uses `verification.mode = "synchronous-v1"`. No legacy result submission, settlement or post-completion challenge entry point exists.

Market constructor: `(IMEPRegistry, InstanceRegistry, PoRWClaimManager, uint64 commitBlocks, uint64 revealBlocks, uint64 disputeBlocks)`. Configuration getters `COMMIT_BLOCKS`, `REVEAL_BLOCKS`, `DISPUTE_BLOCKS`, `TASK_TIMEOUT` (sum), `challengeWindow` (zero). `setDisputes(address)` and `setHostCapacity(address)` wire before admission. Registry must authorize market holds; capacity must authorize market.

Market postTask/postBatch/postTokenTask/postTokenBatch and Task/Result tuples match legacy. `t.deadline == 0` computes deadlines from posting block; a supplied deadline must be at least the computed final deadline. Task identity is **new**: `taskId(Task,address token,bytes32 nonce,uint32 runs,address client)` binds synchronous version, chain, market, asset, client, task, nonce, runs. Native task callers must use this helper or receipt event, not legacy `PorwMeshHash.taskId`.

- `sessionState(bytes32) returns (uint8 state,uint64 commitDeadline,uint64 revealDeadline,uint64 totalDeadline)`; states Missing=0, Committing=1, Revealing=2, Disputing=3, Completed=4, Inconclusive=5.
- `tasks(bytes32)` retains legacy tuple `(Task t,address client,uint64 epoch,uint64 postedAt,uint64 settledAt,bool exists,bool settled,bool disputed,bool repudiated)` for data readers. `settled` includes **inconclusive**, so consumers MUST read sessionState and accept only state 4.
- `pendingTask(address host) returns(bytes32)`, `ready(address) returns(bool)`, `readinessNonce(address) returns(uint256)`.
- `setReady(bool)` uses sender instance/session. `setReadyBySig(address host,bool value,uint64 expiry,uint256 nonce,bytes signature)` signs `readinessDigest(host,value,expiry,nonce)`. Every change and assignment consumes nonce; rearm while pending fails.
- `commitments(bytes32,address) returns(bytes32)`, `submitted(bytes32,address) returns(bool)` (revealed).
- `resultCommitment(bytes32 id,address host,bytes32 execDigest,bytes32 execRoot,bytes32 salt) returns(bytes32)`.
- `commitmentDigest(bytes32 id,address host,bytes32 commitment) returns(bytes32)`; `commitResult(bytes32 id,address host,bytes32 commitment,bytes signature)`.
- `resultDigest(bytes32 id,address host,bytes32 execDigest,bytes32 execRoot) returns(bytes32)`; **four arguments**, host bound and incompatible with legacy signatures. `revealResult(bytes32 id,address host,Result result,bytes32 salt,bytes signature)`.
- `expire(bytes32 id)` permissionless; expiry is only after deadline, messages allowed through deadline.
- Legacy read helpers `executors`, `taskInfo`, `taskInitStateRoot`, `resultOf`, `batchRuns`, `paymentToken`, `settledDigest`, `settledRef`, `paidExecutors` preserved.
- Pull payments `credits(address asset,address beneficiary)`, `withdrawCredit(address asset,address payable recipient)`. Royalties use legacy `royalties`, `tokenRoyalties`, `withdrawRoyalty`, `withdrawTokenRoyalty` and original MEP beneficiary identity.

EIP712 domain remains `PoRW Mesh`, version `1`, current chain id, market address. Canonical typed structs:

```
Readiness(address host,bool ready,uint64 expiry,uint256 nonce)
ResultCommitment(bytes32 taskId,address host,bytes32 commitment)
SynchronousResult(bytes32 taskId,address host,bytes32 execDigest,bytes32 execRoot)
```

Commit preimage is `abi.encode(keccak256("AIGG_SYNCHRONOUS_RESULT_V1"),chainid,market,id,host,digest,root,salt)`. Use 32 random salt bytes and persist before signing; never re-sign alternate results after restart.

Market events: existing `TaskPosted`, `TaskAsset`, `BatchPosted`, `ResultSubmitted`, `DisputeOpened`, `TaskSettled`; plus `SessionDeadlines(bytes32 indexed taskId,uint64 commitDeadline,uint64 revealDeadline,uint64 totalDeadline)`, `ReadinessChanged(address indexed host,bool ready,uint256 nonce)`, `ResultCommitted(bytes32 indexed taskId,address indexed host,bytes32 commitment)`, `SessionClosed(bytes32 indexed taskId,uint8 outcome,bytes32 digest)`.

Dispute constructor `(IMEPRegistry,InstanceRegistry,SynchronousTaskMarket,uint64 roundBlocks,uint256 slashAmount)`. Existing proof entry points and argument tuples exactly match upstream ExecutionDisputes: openRun, revealRoots, postStepRoots, postChildren, postRow, postRowLif, proveSynapseTerm, proveSynapseTermLif. No new dispute after terminal state. Existing `disputes`, `lifs`, `batches`, `partyA`, `partyB` getters retain upstream shapes. Phase ordinals Step=0,Refine=1,Neuron=2,Synapse=3,Resolved=4,Run=5.

`partyState(bytes32,address)` returns struct `Party(bytes32 execRoot,bytes32[] actRoots,bool revealed,bytes32 node,bytes32[2] pair,bool posted,bytes32 leaf,uint32 act,uint64[] sums,bool rowPosted)`.
`lifPartyState(bytes32,address)` returns struct `LifParty(bytes32[] stepRoots,bool refined,State state,int64[] sums,bool rowPosted)` where State is `(int32 v,int32 g,uint16 refr,uint16 flags,uint32 count)`.

Sponsored move: `forwardMove(bytes32 id,address host,uint8 phase,uint256 round,uint256 nonce,uint64 expiry,bytes data,bytes signature)` signs `moveDigest(bytes32 id,address host,uint8 phase,uint256 round,uint256 nonce,uint64 expiry,bytes32 dataHash)`. `roundNonce(id)` advances on progress, `moveNonce(id,host)` consumes every sponsored move. Only the eight proof selectors above are allowed. `data` includes the task id as its first argument. Delegation must cover whole session. Recover/reconcile confirmed state before every move. Exact getter tuple fields come from build ABI artifacts.

Both agreement and adjudication assume independently administered executors with at least one honest party. An adjudicated root/digest is not a standalone validity proof. Inconclusive refunds the fee, pays no royalty, and endorses no digest. Slash proceeds are pull credits held by dispute and never push paid to winner during adjudication.

Additional implemented details:

- `hasOpenedRun(bytes32,address) returns(bool)` tells a batch responder whether its run opening already landed.
- Dispute EIP712 typed struct is `DisputeMove(bytes32 taskId,address host,uint8 phase,uint256 round,uint256 nonce,uint64 expiry,bytes32 dataHash)` with dispute verifying-contract domain.
- `slashCredits(address)` and `withdrawSlash(address payable recipient)` are on the dispute contract.
- `readinessSigner(address)` records readiness authority. Assignment rechecks delegation is still valid through the entire computed session deadline. Revoked/too-short readiness is skipped rather than consumed.
- `minimumDisputeBlocks(uint32 neurons,uint32 runs,bool lif)` computes all worst-case round windows, including all32 row-chunk windows (16 per party) and final proof. `ROUND_BLOCKS` must also be calibrated to largest replay/witness and chain conditions; the contract cannot prove sufficient browser wall-clock compute time.
- Token royalty opt-in: `setTokenBeneficiaryAllowed(address,bool)` validates beneficiary's `MARKET()` and `supportsTokenRoyalties()`. At successful settlement a gas-bounded, return-size-bounded static query `royaltyRecipients(bytes32 mepId) returns(address holder,address baseVendor,uint16 baseShareBps)` credits asset balances directly. Query rejection/malformed data falls back to `tokenRoyalties[mepId][token]`, withdrawable only by original beneficiary, and cannot block terminal settlement. Collection's fallback pull route determines fallback ownership attribution; normally credited holder is the one at settlement.
- `postSession(Task,address token,bytes32 nonce,uint32 runs,address client)` is a self-call-only implementation helper shared by four public posting wrappers for EIP170 size; external callers always fail authorization.
- Generic `InvalidProof()` is the dispute error selector; consumers must not depend on upstream revert strings.

## Exact-profile admission certificate

`setProfileSupport(bytes32 mepId,uint32 maxInDegree)` is owner-only. `profileMaxInDegree(mepId)` must be nonzero before post; 1..16384 is the measured maximum CSR row degree, 0 revokes future admission. The profile is immutable in MEPRegistry; this is an explicit operator certification based on inspected model bytes, **not an on-chain proof of CSR degree**. An incorrect certification can still admit an unanswerable row, so measurement artifacts and deploy preflight are activation requirements. Already-admitted sessions do not depend on later approval changes.

Every derived MEP needs its own certificate. Registry base linkage proves dimensions and execution kind, not row topology; approving a base never enables arbitrary descendants. Uncertified offspring are unavailable to this market until measured and approved. `supportedExecKind(bytes32) returns(bool)` admits only canonical `keccak256("aigg:exec:int-spmv-q16:v1")` or registry-declared int-LIF execution kinds. Market reverts use generic `InvalidSession()` to remain below EIP170.


## Bounded row chunks (BNB transaction gas cap)

Full row storage above a few thousand entries exceeds BNB's per-transaction gas cap. Total row capacity is16384, but each transaction carries at most1024 entries. Shared `SynchronousLimits` is the canonical bound; dispute `MAX_IN_DEGREE()` and `MAX_ROW_CHUNK()` expose them.

- `postRowChunk(bytes32 id,uint32 offset,uint32 total,uint32 claimedAct,uint64[] sums)`.
- `postRowLifChunk(bytes32 id,uint32 offset,uint32 total,int32 v,int32 g,uint16 refr,uint16 flags,uint32 count,int64[] sums)`.
- Both selectors are sponsored-move permitted. Total and claimed state are immutable through upload; offset must match received array length. Each chunk must have exactly `min(1024,total-offset)` entries, preventing tiny chunks from expanding the round budget. Zero-length rows complete in one empty upload.
- `rowTotal(bytes32,address) returns(uint32)` stores declared total. Read current partial arrays through partyState/lifPartyState; rowPosted becomes true only at full length. Existing postRow/postRowLif remain complete-row convenience calls for at most1024 entries.
- Each chunk respects phase and current/final deadline, advances roundNonce, and caps next round at original session total. Minimum dispute duration now reserves32 row uploads plus run/segment/neuron/final proof windows, independent of actual smaller row length.
- Profile approvals allow1..16384, zero revokes. `setProfileSupports(bytes32[] ids,uint32[] degrees)` batch-certifies up to32 exact profiles atomically using the same owner/kind/degree validation.
- The upstream public CLAMP_Q16 getter is omitted to satisfy EIP170; SpMV arithmetic remains the same internal constant65536.

Gas tests in SynchronousChunks.t.sol exercise direct and signed-forward1024-entry uploads against the16,777,216 transaction cap. SynchronousWitnessGas.t.sol preserves the failed monolithic-storage experiment as evidence; it does not define a supported transaction path.
