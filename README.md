# aigg-bnb — PoRW fly-brain mesh on BNB Chain

The BNB Chain deployment of the browser fly-brain mesh: **BNB** as the bond and settlement
asset, **BSC / opBNB** as the settlement chain, **Greenfield** as the content-addressed store
for model bytes, and a chain-specific **epoch beacon** (prevrandao is not random on PoSA
chains). Everything chain-neutral — the PoRW scheme, the browser node, the deterministic
execution kinds (integer SpMV, integer LIF on the real FlyWire brain), the settlement and
dispute contracts, the relay transport, EIP-712 wallet signing — lives in
[`aigg-porw`](https://github.com/jianmliu/aigg-porw) and is consumed here as a pinned
dependency. The canonical scheme definitions live in `aigg-spec`. This repository never
changes a PoRW scheme id and never forks the neutral contracts.

| here | what |
|---|---|
| `docs/DESIGN.md` | the BNB-specific design: layering, beacon, parameters, costs, risks |
| `docs/PROPOSAL.md` | the ecosystem proposal draft |
| `contracts/` | `CommitRevealBeacon` (IBeacon for BSC/opBNB), `GreenfieldDA` (weights pointer format), the deployment script |
| `js/greenfield.js` | fetch a MEP's model bytes from a Greenfield storage provider and verify them against `model_id` before loading |
| `js/greenfield_admin.mjs` / `js/register_mep.mjs` | publisher tools: bridge-funded deployer account → create a public-read bucket, upload the payload (SDK, Reed-Solomon checksums), then register the MEP on-chain after verifying the SP serves bytes with the pinned `model_id` |
| `relayer/` | **the relayer service**: stage-1 relay hub + epoch aggregator (one root per MEP per epoch) + commit-reveal beacon participant / epoch roller + gas-sponsoring transaction submitter for bonded instances (`delegateBySig`, `materializeClaim`, `submitResult`, `settle`) with a small HTTP API |
| `frontend/` | **the node page**: connect wallet → choose the brains to host → bond BNB for all of them → delegate a session key (one EIP-712 signature) → load a model per brain (model_id verified locally; a Greenfield SP endpoint fills the URL from the MEP's `gnfd://` pointer) → run the node (a claim per brain per epoch, materialize when wanted, audits and tasks for every hosted brain over the relay); the selector switches which brain the model panel shows |
| `test/` | end-to-end on a local anvil: `e2e_anvil.mjs` (the whole loop without a browser) and `e2e_frontend.mjs` (headless Chromium with a wallet simulated outside the page) |
| `deploy.sh` | opBNB testnet / BSC testnet deployment (Foundry) |
| `split.sh` | turns this staging directory into the standalone repository (`aigg-porw` becomes a git submodule) |

## Layering (short version)

1. **Greenfield** stores the model payload (`FLYBRAINv2`, 28 MB for the FlyWire v783 export) and
   its manifest. The MEP's `weightsDA` is the object pointer; integrity comes from `model_id`
   (the keccak weights Merkle root every node recomputes), not from Greenfield.
2. **BSC / opBNB** runs the neutral contracts unchanged: `MEPRegistry`, `InstanceRegistry`
   (bond in BNB), `PoRWClaimManager` (with a BNB-chain `IBeacon`), `TaskMarket`,
   `ExecutionDisputes`, `RelayRegistry`.
3. **Browsers** hold the brain resident, prove it, execute tasks, and settle through relays;
   wallets (MetaMask/Binance Wallet) sign one EIP-712 delegation per session key.

## Run it

```sh
npm install
# contracts: deploy; the addresses are saved as environment variables in .env.<network> (gitignored, chmod 600)
NETWORK=bsc-testnet PK=0x... ./deploy.sh
# publish a brain: fund the deployer on Greenfield (TokenHub.transferOut on BSC testnet: 0xED8e5C546F84442219A5a987EE1D820698528E04,
# value = amount + relayFee + minAckRelayFee from CrossChain.getRelayFees()), upload, then register the MEP
source .env.bsc-testnet
node js/greenfield_admin.mjs balance $PORW_DEPLOYER
PORW_GNFD_SP=https://gnfd-testnet-sp2.bnbchain.org node js/greenfield_admin.mjs upload aigg-brains flywire-fafb-v783-min5.bin /path/to/flywire-783-min5.bin
node js/register_mep.mjs fields.json gnfd://aigg-brains/flywire-fafb-v783-min5.bin https://gnfd-testnet-sp2.bnbchain.org
#   fields.json = model_id / synapseRoot / exec kind / steps / stride computed by aigg-porw (web/porw-browser/model_id.mjs + node.loadModel)
# relayer: addresses + RPC come from the env file; add the relayer key and the MEP ids to it (or export them)
echo "PORW_RELAYER_KEY=0x...
PORW_MEP_IDS=0x<mep id>,0x<mep id>
PORW_RELAY_PORT=8787
PORW_API_PORT=8788
PORW_BEACON_LAZY=1
PORW_BEACON_WAKE_EPOCHS=2
PORW_SPONSOR_EPOCH_GAS=1500000
PORW_SPONSOR_DAY_GAS=50000000" >> .env.bsc-testnet
source .env.bsc-testnet && npm run relayer      # or: node relayer/relayer.mjs --env .env.bsc-testnet
# frontend: static page; point it at the relayer API (http://host:8788) in the first box
npm run frontend -- --port 8790
# tests (local anvil + Foundry; PW_CHROMIUM for the browser test)
npm test              # js/test_greenfield.mjs + test/e2e_anvil.mjs
npm run test:frontend # headless Chromium: wallet, bond, delegate, model, node, claims, materialize, task
```

The relayer sponsors gas only for calls that belong to a bonded instance (or its delegated session key) and
that succeed in simulation; it is untrusted for correctness (envelopes are signed, roots are challengeable,
omitted instances fall back to `submitClaim`), so anyone may run one and instances may use several.

Every `/tx/*` call therefore passes three gates before anything is signed: it must **name a bonded instance** to
charge (`/tx/result` derives it from the session key the signature resolves to; `/tx/settle` needs one in the
body -- settling is permissionless on-chain, so a client who is not bonded can always settle their own task by
paying for it), it must **simulate successfully** from the relayer's account, because a reverted transaction
still costs gas, and it must **fit a budget**: `PORW_SPONSOR_EPOCH_GAS` per instance per epoch (default 1,500,000)
and `PORW_SPONSOR_DAY_GAS` across everyone per rolling day (default 50,000,000). Both are finite by default so an
operator raises them knowingly rather than inheriting an unbounded hot wallet; `/status.sponsor` shows the limits,
the day's spend and the last refusals with their reasons. `test/e2e_sponsor_guard.mjs` covers all three gates,
including that a call which would revert broadcasts nothing at all.

`PORW_BEACON_LAZY=1` makes the beacon follow demand instead of the clock. Producing one costs about 366k gas per
epoch (commit + reveal + `rollEpoch` + one root) whether or not a single instance is online, and an epoch's beacon
is only ever consumed by that epoch's claims, sortition and audits. In lazy mode the relayer commits for the next
epoch only when there is demand: a verified claim collected in this epoch or the previous one, or a bonded
instance that announced itself (`POST /wake`, which the node page sends once per epoch). A cold epoch never rolls
and costs nothing; a node arriving into a cold mesh waits one epoch for a beacon and a second to become eligible,
and `/status` reports `beacon.warm` with the reason. Spamming `/wake` cannot amplify the bill — the beacon fires
at most once per epoch either way. Default off: with it unset the relayer behaves exactly as before.

## Claim posture per chain

- **opBNB**: every instance may submit its own EIP-712 claim each epoch (`submitClaim`, ≈240k gas, negligible cost).
- **BSC**: use the **aggregated path** from aigg-porw — an untrusted aggregator (`web/porw-browser/aggregator.js`)
  batches the epoch's verified claims into one root (`postEpochRoot`, ≈72k gas per MEP per epoch) and serves
  inclusion proofs over the relay; only instances that compete for tasks that epoch, or are audited,
  `materializeClaim` (≈232k gas). Passive instances cost nothing on-chain; an omitted instance falls back to
  `submitClaim`. See `docs/DESIGN.md` §5 for the cost model.

## What the end-to-end tests prove (local anvil, BNB parameters, commit-reveal beacon)

`e2e_anvil.mjs`: deploy → MEP registered → relayer up → two wallets bond 0.5 BNB and delegate session keys
through the relayer → relayer commits/reveals the beacon and rolls each epoch → nodes announce claims over the
relay → relayer posts the epoch root → instances materialize through the relayer (≈285k gas) → both eligible
→ a client posts a task, sortition picks both, results answered over the relay, submitted by the relayer,
settled, fee split; the client re-executes and matches. 14 sponsored transactions, 0 errors.
`e2e_frontend.mjs`: the same through the page in Chromium with **two brains hosted at once** (female + a
synthetic "male" MEP): one bond covers both, wrong bytes for a brain are flagged by the model_id check,
claims and materializations run for both, a task on the male brain is executed by the tab and matches an
independent re-execution. The wallet is prompted exactly twice (bond tx, one `Delegation`).

## Where deployment addresses live

Never in git. `deploy.sh` writes `.env.<network>` (`PORW_CHAIN_ID`, `PORW_RPC`, `PORW_EPOCH_BLOCKS`,
`PORW_VERIFIER`, `PORW_MEP_REGISTRY`, `PORW_INSTANCES`, `PORW_BEACON`, `PORW_CLAIMS`, `PORW_MARKET`,
`PORW_DISPUTES`, `PORW_RELAYS`, plus the deployer that owns the registries: `PORW_DEPLOYER`, `PORW_DEPLOYER_KEY`); the relayer reads the environment (`relayer/env.mjs`) and serves the
addresses to the frontend over `/deployment`, so the page needs nothing but the relayer URL. `deployments/*.json`,
`.env*` and `relayer/config.json` are gitignored; keep the env files in your secret store. The end-to-end tests
start the relayer through the same `PORW_*` variables.

## Testnet deployment record (BSC testnet, chain 97)

Deployed 2026-09-17 with `deploy.sh` (parameters for 0.75 s blocks: epoch 800 blocks, commit/reveal windows 160,
opening window 160, dispute round 400, exit delay 2400, task timeout 800; UNIT 0.05 BNB, slash 0.5 BNB, opening
deposit 0.01 BNB, beacon deposit 0.1 BNB, relay bond 1 BNB). Deployer `0xFE560Af8f5cFC209794b3Df7DC7E281D4Ef81EDa`;
first deployment tx `0x999f6098374049fdb3abb8fc33da708fea3aff2e3a74936fad2a8af69a53d873` (the eight contract creations
follow it in the same run). Contract addresses are distributed through the `.env.bsc-testnet` file, not this repo.

Published brain: `gnfd://aigg-brains/flywire-fafb-v783-min5.bin` on Greenfield testnet (SP
`https://gnfd-testnet-sp2.bnbchain.org`, public read; manifest next to it), 28,123,136 bytes, sha256
`fd246cc2…e1da`. MEP `0x9b7dc2ba02a04ed1be9519d00d53323d581c0b496764c28edc071d8c841bef49` registered on the MEP
registry (tx `0xb20e5fd164198ea293590adfbec61ab70c2d25b53af660a5041f78a0951f8d2e`): int-lif, 100 steps, stride 10,
139,255 neurons, 2,700,513 synapse records, model_id `0x9747cc81830375103eae957a93d3800875223c17bdc6399f5783be62a19da93a`.

### Live run record — 2026-09-17, BSC testnet (chain 97)

`test/live_bsc.mjs` (a headless instance holding the real FlyWire brain) against `relayer/relayer.mjs`, both on
the deployment above; all transactions on https://testnet.bscscan.com/tx/<hash>. One account played deployer,
relayer and instance (only one funded key); in production these are three parties.

| step | who | tx | gas |
|---|---|---|---|
| bond 0.05 BNB for the FlyWire MEP (1 vote) | instance wallet | `0xe8677a1d0d5211fd92eab0c4a73f7b06a4166c7e1985c9f24d5a862d888949a8` | — |
| delegateBySig (session key, EIP-712) | relayer, sponsored | `0x3a6ca9b493ee4aa04818647c55b389b4e85649209fee7ccf59a0962d47409155` | 54,935 |
| beacon commit for epoch 164533 | relayer | `0xedcc81a69a7c9b00ffae3692900e9ae453a4baaac202c8c539777f5b0da09917` | 115,235 |
| beacon reveal for epoch 164533 | relayer | `0xa79cc2ed1ceac7833ece936d83e09dad5762144395febb4185ca7c9b6585200d` | 100,408 |
| rollEpoch(164533) | relayer | `0x4080d6a7ebfc1dd61b43a2ff630050b7cfa2f6974ce0aaa2f60ebcc30a5f4637` | 52,276 |
| claim for epoch 164533 (off-chain, over the relay) | instance | claimHash `0x248d455aeb…`, slot 5.1 s (100 LIF steps + commitments, single thread) | — |
| beacon commit / reveal for epoch 164534 | relayer | `0xffb68421bb2bcd91968636dfa090de7cf3f1afd96c1a3719ad011841362dd109` / `0xd6fd02ec9918dbd29e99ed1d4ccfd198ada9208668e3d3427ba82f1888b431e0` | 115,235 / 100,396 |
| rollEpoch(164534) | relayer | `0x27a843a60d61b2fe5efdaf956372a3421fb864d8b91aa6dfe63853135171e15d` | 52,276 |
| postEpochRoot(MEP, 164533, 1 claim) — root `0xa102297a18b16b6be233793be29f939f4ea806d42f01edcd4c42c84a5f0dc518` | relayer | `0x9cafda285e33d7195db230797992684811893c768d280a643e6003bb84af1e3f` | 97,803 |
| claim for epoch 164534 (off-chain) | instance | claimHash `0xde77e12d2f…`, slot 5.1 s | — |
| materializeClaim(164533) with the relayer's inclusion proof | relayer, sponsored | `0xeb02cdfcb35e971964e42da139ec1e76f35e0cd4a18ab851b86af82178f367e7` | 284,571 |
| postTask (fee 0.001 BNB, redundancy 1) → sortition picked the instance | client | `0xf096e8bf393541335e56c70b13986d108e7fc9906f5dfc1fc4fc686f59463a63` | — |
| task executed over the relay (100 LIF steps), execDigest `0x688bc3909079…` | instance | off-chain | — |
| submitResult (EIP-712, session key) | relayer, sponsored | `0x8c67ddc7c9d4fffbdffad99e09b9702467b96126dc9eb9134e9815101537ddd0` | — |
| settle → fee paid to the instance | relayer | `0xd07c48aaec2fbf1c701bf064246b44a029dc195001b5e55a6942d88b02b3bac7` | — |

Verified afterwards by read calls: `hasValidClaim(instance, MEP, 164533) == true`, `epochRoots(MEP, 164533, relayer) ==
(0xa10229…, 1)`. One transient failure: the first `postEpochRoot` attempt got "nonce lower than current" from the
public RPC pool right after `rollEpoch`; the relayer's next tick (5 s later) succeeded. Since then the relayer
carries an explicit, locally tracked pending nonce on every send (serialized sends, resync + one retry on nonce
errors; `/status.nonce` shows the counter and resync count), covered by `e2e_anvil.mjs` with concurrent sponsored
sends and a deliberate external desync. Wall clock from bond to
settlement: 10.5 minutes, dominated by waiting for epoch boundaries (800 blocks ≈ 10 min).

## Build and test (standalone layout)

```sh
cd contracts && forge test          # remappings point at contracts/lib/aigg-porw (pinned submodule)
cd .. && npm install && npm test    # js/test_greenfield.mjs (a local server stands in for the storage provider)
NETWORK=anvil ./deploy.sh           # deploy the BNB-parameterized mesh to a local anvil (or opbnb-testnet / bsc-testnet)
```

After `./split.sh /path/to/aigg-bnb`, the same commands run against the pinned submodule `contracts/lib/aigg-porw`.
