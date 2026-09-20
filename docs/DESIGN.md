# BNB Chain deployment design

Status: deployed on BSC testnet (chain 97; see README "Testnet deployment record") with the FlyWire brain on Greenfield testnet. Numbers marked *assumed* are inputs to
the cost model, not measurements; measured gas comes from `aigg-porw` (`benchmarks/evm/`,
`contracts/evm/DESIGN-cross-audit.md` §5b/§5c).

## 1. What is BNB-specific and what is not

| layer | neutral (aigg-porw) | BNB deployment (this repo) |
|---|---|---|
| model bytes | `FLYBRAINv2` payload, `model_id` = keccak weights root, MEP registry | **Greenfield** object as `weightsDA`; download + verify before load |
| bond / rewards | `InstanceRegistry` in the native asset; per-epoch budgets | bond, deposits, slash and fees in **BNB**; parameter table §4 |
| settlement | claims, opening challenges, tasks, disputes (EIP-712, session keys) | **opBNB** (default) or BSC; deployment script + addresses |
| randomness | `PoRWClaimManager` takes an `IBeacon` (prevrandao fallback for the pilot) | **`CommitRevealBeacon`** among bonded instances (§3); VRF adapter as an alternative |
| transport | relays + signed envelopes; `RelayRegistry` | relays bonded in BNB; suggested operators |
| wallets | EIP-712 `Claim`/`Result`/`Delegation` | MetaMask / Binance Wallet / WalletConnect via `eth_signTypedData_v4`; chain ids 56 / 204 (mainnets), 97 / 5611 (testnets) |

## 2. Greenfield as the model store

- A released brain is one Greenfield object (public read) plus a manifest object
  (`*.manifest.json` from `flywire_export.py`: neuron/synapse counts, sha256, sources).
- `MEP.weightsDA = "gnfd://<bucket>/<object>"` (UTF-8 bytes; `GreenfieldDA.sol` validates the
  form). Anyone can fetch the object from any storage provider (SP) that serves the bucket.
- **Integrity is `model_id`, not the SP.** `js/greenfield.js` streams the object, recomputes
  the keccak weights leaves and root, and refuses to load a payload whose root differs from
  the MEP's `model_id`. A malicious or stale SP therefore can only deny service.
- Publication convention carries over: synapse records sorted by post neuron (the node's
  parallel path depends on it).
- Cost: a 28 MB object; Greenfield charges storage per size and read quota per bucket —
  publishers set a read quota large enough for instance bootstraps (each instance downloads
  once; 1,000 instances ≈ 28 GB of egress per release).

## 3. Epoch beacon on a PoSA chain

`block.prevrandao` on BSC / opBNB is the PoSA "difficulty" (a small constant), so the pilot
beacon `keccak(prevrandao ‖ blockNumber)` is predictable and partly grindable by the block
producer. The claim manager here takes an `IBeacon`:

- **`CommitRevealBeacon`** (`contracts/src/CommitRevealBeacon.sol`): for epoch `e`, anyone who
  posts the `DEPOSIT` with it (in practice the relayers; the contract checks the deposit, not a
  bond in `InstanceRegistry`) commits `keccak(secret ‖ sender)` during the **last**
  `COMMIT_BLOCKS` of epoch `e − 1`, and reveals during the first `REVEAL_BLOCKS` of `e`, which
  refunds the deposit. `beaconFor(e) = keccak(acc ‖ e)` once the reveal window closes, where
  `acc` is the running keccak of the revealed secrets in reveal order; with no reveal at all
  there is no beacon and the epoch is skipped. A committer who does not reveal forfeits its
  deposit to the pool (anyone may sweep it with `forfeit`) and its commitment is excluded. With ≥ 1 honest revealer the
  beacon is unpredictable to everyone before the reveal window; the last revealer can bias by
  withholding at the cost of its deposit (standard RANDAO trade-off, bounded by the deposit).
- **VRF**: where a VRF service is available on the target chain, an adapter contract that
  implements `IBeacon` from the VRF response is the stronger option; it is not included here
  to avoid a vendor dependency in the reference.
- The beacon is fixed before the epoch's claims are accepted (the claim manager only rolls an
  epoch whose beacon is ready), so no claimant can influence its own challenge or auditors.

## 4. Parameters (proposed; all constructor arguments)

| parameter | proposal | rationale |
|---|---|---|
| chain | opBNB (chain id 204; testnet 5611) | sub-second blocks, ~100M gas/block, cents per dispute round; BSC as fallback for liquidity |
| `EPOCH_BLOCKS` | ≈ 10 minutes of blocks | one claim per (instance, MEP, epoch); browser slots are ~1–2 s, epochs are minutes |
| `UNIT` (bond per sortition vote) | 0.05 BNB | Sybil cost per vote; `MAX_WEIGHT` = 16 keeps whales at 16 votes |
| `SLASH_AMOUNT` | 0.5 BNB | 10 votes' worth; exceeds any single task fee |
| `OPENING_DEPOSIT` | 0.01 BNB | false challenges cost something; an honest response wins the deposit |
| `OPENING_WINDOW` | ≈ 2 minutes of blocks | an instance behind a censoring relay must be able to answer on-chain itself |
| `ROUND_BLOCKS` (dispute) | ≈ 5 minutes of blocks | wallet / session key latency + one tree bisection round |
| `TASK_TIMEOUT` | ≈ 10 minutes of blocks | replaces stragglers by the next sortition index |
| `CHALLENGE_WINDOW` (replicator) | one epoch, never more than `EXIT_DELAY` | how long a settled result stays open to a non-executor; longer than the exit delay and a liar settles, exits, and is challenged with nothing left to slash (`TaskMarket` enforces it). 0 = off |
| `CHALLENGE_DEPOSIT` | 0.02 BNB, doubling per thrown-out challenge of the same task | half goes to the defender and has to cover its side of a full bisection (≈ 1.75M of the ≈ 3.5M gas in §5: 0.01 BNB pays that up to ≈ 5.7 gwei) |
| `CHALLENGE_SINK` | the deployer; the treasury on a real network | takes the other half, so an executor cannot shield its own result by challenging itself for free |
| `RelayRegistry` bond | 1 BNB | operator identity; ≥ 2 relays per instance |
| beacon `COMMIT/REVEAL_BLOCKS` | ≈ 2 / 2 minutes; committer deposit 0.1 BNB | RANDAO-style, deposit-bounded bias |

## 4b. Settlement assets: one mechanism, several currencies

**Proposed. Nothing below is built** — today every path in this system is native BNB and only native
BNB, in both repositories (`FlyCollection.mint`: `require(msg.value == MINT_PRICE)`; `TaskMarket._post`:
`require(msg.value == t.fee)`; refunds, executor payouts, royalties and `withdraw` are all
`call{value:}` against a single balance).

The design is that **BNB, AIGG and USDC are alternative settlement assets under one mechanism**.
There is no AIGG-specific code path, no dedicated funding channel, and no automatic conversion
anywhere: a currency is carried, not swapped.

| | what it means | where it lands |
|---|---|---|
| **Adoption** | a collection declares which currencies it accepts and the price in each | `FlyCollection`: `MINT_PRICE` becomes a price per accepted asset; `mint` takes the asset it is paid in |
| **Experiment budget** | accounted per currency, never converted | the treasury holds balances per asset; a budget in one currency cannot fund a task in another |
| **Task offer** | states its currency, its amount and what it accepts as a result, and locks the budget before it is posted | `Task` gains the asset; the escrow holds that asset |
| **Provider** | chooses which currencies and prices it will work for | already a free choice — sortition draws from those enrolled, and an executor that will not take the offer does not enrol for it |
| **Settlement and shares** | paid in the currency the task named; a refund returns that same currency | `TaskMarket` payout and `royalties` / `withdrawRoyalty`, and `FlyCollection.owed`, become per-asset |

### What it costs to build, stated honestly

The currency belongs **in the `Task`**, and `taskId = keccak256(abi.encode(Task, nonce))`. So adding
it changes the task id's derivation: a **breaking protocol change in `aigg-porw`**, not something this
deployment can decide by itself, and one that moves every id, signature and fixture that depends on
it. It is not a wrapper this repository can put in front of the market.

It buys one thing worth having, though, and for free: because the asset is inside the id, it is
inside what sortition drew and inside what an executor signed. **Nobody can be paid in a currency
they did not agree to**, and no separate negotiation is needed to establish that — the same signature
that binds the result binds the asset.

The rest is ordinary ERC-20 work with one real asymmetry: native value arrives *with* the call and a
token has to be pulled (`approve` + `transferFrom`), so a posting becomes two transactions or one
permit; and a payout that reverts cannot be left to `call{value:}`'s failure path, so the per-asset
`withdrawable` credit that already exists for the native case becomes the normal path rather than
the fallback.

### Why this is separate from what the AIGG treasury does

The two are deliberately different kinds of decision:

- **Multi-currency settlement is a protocol capability.** It is permissionless and says nothing about
  who should pay for what. A collection that accepts USDC accepts it from anybody.
- **Which NFTs the AIGG treasury subscribes to, and which research it funds, is governance.** It is a
  policy exercised *through* that capability, with the treasury's own money, and it can change
  without the protocol changing.

The example that makes the separation concrete. The AIGG treasury subscribes to FlyBnB NFTs in AIGG;
the experiments those individuals attract can then recruit compute in AIGG, because that is the
currency the budget is held in. Meanwhile an outside user buys a task in USDC: that task pays its
providers in USDC and pays the individual's owner a royalty in USDC. Neither transaction knows about
the other, and neither needed a conversion.

## 5. Cost model (measured gas × assumed prices)

Measured in aigg-porw (anvil, keccak scheme): tile fraud proof ≈ 1.11M gas; `submitClaim`
≈ 240k; `respondOpening` ≈ 870k; SpMV dispute: `postChildren` 38–115k, `postRow` ≈ 176k,
`proveSynapseTerm` ≈ 290k; LIF dispute: `postStepRoots` ≈ 275k, `postChildren` ≈ 75k,
`postRowLif` ≈ 109k, `proveSynapseTermLif` ≈ 183k.

| action | gas | opBNB (*assumed* 0.001 gwei, BNB = $600) | BSC (*assumed* 1 gwei) |
|---|---|---|---|
| one residency claim per epoch | 240k | $0.00014 | $0.14 |
| respond to an on-chain opening challenge | 870k | $0.0005 | $0.52 |
| full LIF dispute (18 bisection rounds × 2 parties + rows + term) | ≈ 3.5M | $0.002 | $2.1 |
| 10,000 instances × 1 claim per 10-minute epoch | 2.4G gas / epoch | $1.4 / epoch | $1,440 / epoch |

Reading: on opBNB the honest path (one claim per instance per epoch) is negligible even at
10k instances; on BSC it is not. For BSC use the **aggregated claim path** (implemented in
aigg-porw: `postEpochRoot` ≈ 70k gas once per MEP per epoch by an untrusted aggregator;
`materializeClaim` ≈ 230k only for instances that compete for tasks that epoch or are
audited): 10,000 passive instances then cost one root per epoch (≈ $0.04 on BSC at the
assumed price), and 500 active ones ≈ $70 per epoch. opBNB is therefore not required for
mainnet; it remains the cheaper choice if every instance should carry an on-chain claim.

**Update — measured gas, batches, and a sortition that does not scan (aigg-porw `d7dd788`).** The per-task figures
above are for one run per task and predate a measurement. As a receipt would give them, at the pinned upstream:

| | gas |
|---|---|
| one task, redundancy 1 / 2 / 3 | 579,287 / 782,170 / 991,106 |
| of which `postTask` at redundancy 2 (paid by the client; it draws and stores the executors) | 327,009 |
| the same task with 30 instances enrolled for the brain instead of 3 | 782,170 |
| a **batch** of 1,000 runs of one brain (`TaskMarket.postBatch`), redundancy 2 | 831,777, i.e. 831 per run |
| finding the run in a disputed batch of 1,000 (one party, dispute path only) | about 1.1M |

The third row used to be 2,358,050: the executor list was rebuilt from every enrolled instance on every call, about
55,000 gas per enrolled instance per task. A draw is constant time now and the roster is drawn once, when the task is
posted, which also makes it a fact about the task instead of a live view; a task nobody can execute is refused at post.
Agreement between results is on the execution root only. The digest is not bound to the root by anything the chain can
check, and a digest-only disagreement used to be won by whoever revealed first; now it is no dispute, and a task
endorses the digest a strict majority of its paid executors gave, or none (`settledDigest`, and `TaskSettled`, can be
zero).

Batches run end to end (`test/e2e_batch.mjs`, two live nodes on anvil): a client computes the runs root
(`PorwNode.batchRunsRoot`), posts with `postBatch`, announces one `batch-announce` (id sets named once, runs referring
to them), and the executors' one signed result goes through the relayer's `/tx/result` like any other, because a
batch result is still one `(execDigest, execRoot)`. The reply carries every run's root: those are the dataset's rows,
and a client checks any of them against the settled root and by re-executing it. A lie in one run is bisected to that
run on-chain (about 84,000 gas a round, 76,000 to open it) and is then the ordinary dispute. The page's node serves
batches too: its worker runs the same `NodeService`. What sizes a batch is the task timeout, since an executor runs its
runs one after another.

## 5b. Relayer and frontend (implemented)

- **Relayer** (`relayer/relayer.mjs`, viem): one process runs the relay hub, the aggregator for its MEPs,
  the beacon participant (commit in the last `COMMIT_BLOCKS` of an epoch, reveal in the first
  `REVEAL_BLOCKS` of the next, then `rollEpoch`), and a sponsor API. Sponsorship rules: the caller must be a
  bonded instance or its delegated session key; the call must simulate successfully; roots are posted only
  once per (MEP, epoch). Sends are serialized with a locally tracked pending nonce (resync and one retry on
  nonce errors), because public RPC pools return stale nonces right after a mined transaction. The relayer is
  untrusted for correctness and replaceable for liveness (several may run; instances fan out). Its cost per epoch: beacon commit + reveal + roll + one root per MEP, plus the
  sponsored materializations and results, all recoverable from task fees / operator incentives.
- **Frontend** (`frontend/`): Vite + React, for rendering only. `src/core/controller.js` is framework-free and
  holds all of the page's state, the wallet and chain calls and the memory arithmetic (which is why
  `test/frontend_memory.mjs` can run it in a `vm`); the node itself runs in `public/node_worker.js`. The neutral
  modules from aigg-porw are served unbundled under `/porw/`, because the module worker imports the same URLs.
  Chain reads go through the wallet provider; running a node takes two wallet interactions in total (bond tx,
  one EIP-712 Delegation), and posting an experiment is one more transaction, from whoever pays its fee. The session key lives in
  `localStorage` (per-viewer convenience: it is worth nothing without the on-chain delegation, and
  `revokeSessionKey` cuts it off).

## 5c. What this scales to, and where the line actually falls

*(And a note on names, since this is the section that says why they matter: **`aigg` is the protocol**, **`aigg-bnb`
this deployment of it**, and **FlyBnB a dataset** — the fly atlas being produced on it. The protocol's subject is any
model whose arithmetic is exact, so a mouse atlas would be another dataset with another name and nothing here would
change. README states the three layers.)*

The line is not the size of the model. It is the **arithmetic**.

| | deterministic, fixed point | floating point |
|---|---|---|
| what it is | any connectome simulation — the fly, the larva, zebrafish, **the mouse** — under `aigg:exec:int-lif:v1` or a kind like it | an LLM layer: dense GEMM, MoE |
| residency provable | yes | yes — the sketch fuses into the weight-tile load of the inference kernel itself (aigg-porw `gpu/triton/porw_sketch`) |
| **result** provable | **yes, bit for bit** | **no**: two GPUs, two batch shapes or two kernel versions do not agree to the last bit, so there is nothing to compare |
| what runs it | CPU or GPU, whichever the model's size and the memory bandwidth ask for | GPU |

The reason the first column holds at any size is the same one that lets a host skip the work it does not need
(aigg-porw #31, #32): **integer sums are exact and order-independent**. A parallel reduction on a GPU, in any order,
over any number of lanes, gives the same integer as a single-threaded loop — so a redundant executor on other hardware
reproduces the state root to the bit. Floating point has no such property, and that, not scale, is why an LLM cannot be
checked by agreement.

So a mammalian connectome is the same protocol with a different execution layer, not a different system: residency
claims, sortition, redundancy and the bisection dispute are untouched, and only the kernel under `execKind` changes.
What moves with size is *where* it runs, and that is a bandwidth question rather than a compute one. A connectome is a
sparse graph and propagating activation through it is an SpMV of about 0.06 flop per byte — one to two orders of
magnitude below any CPU's roofline knee, so it is **memory-bandwidth-bound and tensor cores do not help it**
(aigg-porw `gpu/triton/demo/fly_brain/WHY-CPU.md`). That is why the fly runs on an ordinary computer: not because the
system is small, but because DRAM is what the work wants, and every machine has DRAM. A brain two orders of magnitude
larger wants HBM, and then the host is a GPU.

**This is what the fly closes.** PoRW began against LLMs, and there it is half a mechanism: residency can be proved,
and the result cannot — a network can show that a model was really in memory and still not show that what came out of
it was that model's answer. Every route around it costs something. Redundancy needs bit-identity that floating point
does not give. A tolerance turns "wrong" into a threshold somebody has to argue for, and an executor can sit just
inside it. A TEE moves the question to a vendor's attestation. A zero-knowledge proof of the inference is orders of
magnitude too expensive at this size.

A connectome simulation has none of that difficulty, and not by luck: it is integer because it was written to be, and
integer is what makes agreement mean something. So the loop closes — **residency proved, execution proved, disagreement
adjudicable to a single synapse term, and the loser slashed** — and it closes the same way at mouse scale as at fly
scale. The LLM case is not solved here; it is set aside, with what remains of it (a provable claim that the weights are
resident) clearly separated from what does not follow (that the output is right).

None of which says the mesh is *needed* for the fly. It is not: the pilot is a few CPU-hours and the atlas is
about 4 million runs (docs/TOKENOMICS.md §9). The point of this section is narrower — that nothing in the design caps
it there, and the thing that would change at mouse scale is the hardware under one interface, not the protocol.

## 6. Risks and limits specific to BNB

- **Beacon bias** is deposit-bounded, not eliminated (§3). A VRF adapter removes it.
- **SP availability**: Greenfield read quota exhaustion or an SP outage delays bootstraps;
  mirror the payload (any HTTP/IPFS copy verifies the same `model_id`).
- **Relay operators**: liveness only; the on-chain fallbacks remain (`respondOpening`,
  disputes as direct transactions), see aigg-porw design §4.
- Everything in aigg-porw's "honest limits" applies unchanged (no hardware root of trust;
  collusion of all executors of a task is caught only by independent re-execution).
