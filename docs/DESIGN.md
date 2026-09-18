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

## 6. Risks and limits specific to BNB

- **Beacon bias** is deposit-bounded, not eliminated (§3). A VRF adapter removes it.
- **SP availability**: Greenfield read quota exhaustion or an SP outage delays bootstraps;
  mirror the payload (any HTTP/IPFS copy verifies the same `model_id`).
- **Relay operators**: liveness only; the on-chain fallbacks remain (`respondOpening`,
  disputes as direct transactions), see aigg-porw design §4.
- Everything in aigg-porw's "honest limits" applies unchanged (no hardware root of trust;
  collusion of all executors of a task is caught only by independent re-execution).
