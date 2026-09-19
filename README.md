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

**What it is for: [FlyBnB](docs/flybnb/paper.md)** — a whole-brain perturbation atlas of the fly, re-tested across
individuals, every row of which anybody can recompute bit for bit. The individuals are the brains hosted on this
network, and the dataset acknowledges whoever holds one: the list on the page and in the paper's appendix is read from
the chain and follows mints and transfers.

| here | what |
|---|---|
| `flybnb/` | **the FlyBnB pilot, reproducible**: the variance pilot's code (a sparse int-lif runner checked against the published digests), its results with a digest per run, and the Hugging Face dataset card and export. `docs/flybnb/proposal.md` is the research proposal |
| `docs/flybnb/` | **the FlyBnB paper, a living draft**: `paper.md` is prose plus generated blocks; `build.mjs` regenerates the pilot's numbers from `results/variance.json` and Appendix A (the acknowledgments) from the chain or a relayer; `.github/workflows/flybnb-paper.yml` re-runs it on a schedule once the repository variables name a deployment |
| `docs/DESIGN.md` | the BNB-specific design: layering, beacon, parameters, costs, risks |
| `docs/PROPOSAL.md` | the ecosystem proposal draft |
| `docs/GATEWAY.md` | design, not built: the mesh behind ai.gg's OpenAI-compatible API -- every tab a model provider, a task as an inference call, receipts, who pays (user, vendor subsidy) and who is paid (hosts, owners, the base's vendor) |
| `contracts/` | `CollectionWhitelist` (which collections of brains the system recognises: a curated list of collections, each answering for its own brains, bred ones included), `CommitRevealBeacon` (IBeacon for BSC/opBNB), `GreenfieldDA` (weights pointer format), the deployment script |
| `js/greenfield.js` | fetch a MEP's model bytes from a Greenfield storage provider and verify them against `model_id` before loading |
| `js/fetch_brain.mjs` | the other half of publishing: fetch a registered MEP's payload from a storage provider and verify it against the on-chain `model_id` before it lands on disk |
| `js/greenfield_admin.mjs` / `js/register_mep.mjs` | publisher tools: bridge-funded deployer account → create a public-read bucket, upload the payload (SDK, Reed-Solomon checksums), then register the MEP on-chain after verifying the SP serves bytes with the pinned `model_id` |
| `contracts/src/LineageRegistry.sol` | **who a derived brain is, provably**: bases proven from their first tile; `register(delta, model_id)` with a bond and a challenge window; one-record and static-byte challenges through aigg-porw's `FlyDeltaRecordVerifier`; finalization generation by generation. `FlyCollection.registerDerived` accepts only final registrations and, for bred tokens, only the recipe the contract recorded |
| `relayer/` | **the relayer service**: stage-1 relay hub + epoch aggregator (one root per MEP per epoch) + commit-reveal beacon participant / epoch roller + gas-sponsoring transaction submitter for bonded instances (`delegateBySig`, `materializeClaim`, `submitResult`, `settle`) with a small HTTP API |
| `frontend/` | **flybnb — the page** (Vite + React). A bed & breakfast for fly brains, organised on BNB Chain: a brain is a *listing*, whoever holds it resident is its *host* and posts a deposit (the bond), and a scientist *books* an experiment on it. Three views — **Brains** (the listings, each with a portrait drawn from its `model_id`; what hosting and owning pay today, and what they do not yet; the booking card), **Host** (deposit → house key → move a brain in → open the doors) and **Flies** (the colony and breeding). Underneath it is the node page it always was: connect wallet → choose the brains to host → bond BNB for all of them → delegate a session key (one EIP-712 signature) → load a model per brain (model_id verified locally; a Greenfield SP endpoint fills the URL from the MEP's `gnfd://` pointer) → run the node (a claim per brain per epoch, materialize when wanted, audits and tasks for every hosted brain over the relay); the selector switches which brain the model panel shows |
| `test/` | end-to-end on a local anvil: `e2e_batch.mjs` (one task, many runs: posted, executed by two live nodes, settled, a row re-executed by the client; then a lie in one run bisected to on-chain and convicted); `e2e_anvil.mjs` (the whole loop without a browser) and `e2e_frontend.mjs` (headless Chromium with a wallet simulated outside the page) |
| `deploy.sh` | opBNB testnet / BSC testnet deployment (Foundry) |
| `deploy_collection.sh` | the genesis `FlyCollection` on top of a deployed mesh (`contracts/script/DeployCollection.s.sol`): the genesis root is read from `flybnb/genesis/genesis-v1.json`, the collection is listed on the mesh's `CollectionWhitelist`, and its address is saved as `PORW_COLLECTION` |

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
NETWORK=bsc-testnet PK=0x... ./deploy.sh          # CLAIM_VALIDITY_EPOCHS=6 keeps a claim good for six epochs: one materialization an hour, not six
#   settled results stay challengeable by anybody for CHALLENGE_WINDOW blocks (default: one epoch, at most EXIT_DELAY; 0 = off) against
#   CHALLENGE_DEPOSIT (0.02 BNB); set CHALLENGE_SINK to the treasury -- it defaults to the deployer
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
PORW_SPONSOR_DAY_GAS=50000000
PORW_COLLECTION=0x<FlyCollection, optional: hatch its eggs for the bounty>
PORW_RELAY_PATH=/relay
PORW_PUBLIC_RELAY_URL=wss://api.example.org/relay" >> .env.bsc-testnet
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

Running it behind a proxy needs two more settings. `PORW_RELAY_PATH` serves the relay hub on the API's own port
under that path instead of giving it a port of its own, which is what a host that routes one port per service
allows; leave it unset and the hub takes its own port as before. `PORW_PUBLIC_RELAY_URL` is the URL browsers are
told to connect to -- the address the process bound is an implementation detail, and `ws://127.0.0.1:8787` is
wrong for every tab that is not on the same machine (and refused outright by an `https://` page). Keepalive is
handled in `aigg-porw`: the hub pings its peers and reaps the ones that stop answering, and `RelayClient` redials
with backoff and replays its subscriptions, because a relay connection is idle across whole epochs and anything
in front of it will cut it. `test/e2e_hosting.mjs` covers the single-port and announced-URL behaviour.

`PORW_BEACON_LAZY=1` makes the beacon follow demand instead of the clock. Producing one costs about 366k gas per
epoch (commit + reveal + `rollEpoch` + one root) whether or not a single instance is online, and an epoch's beacon
is only ever consumed by that epoch's claims, sortition and audits. In lazy mode the relayer commits for the next
epoch only when there is demand: a verified claim collected in this epoch or the previous one, or a bonded
instance that announced itself (`POST /wake`, which the node page sends once per epoch). A cold epoch never rolls
and costs nothing; a node arriving into a cold mesh waits one epoch for a beacon and a second to become eligible,
and `/status` reports `beacon.warm` with the reason. Spamming `/wake` cannot amplify the bill — the beacon fires
at most once per epoch either way. Default off: with it unset the relayer behaves exactly as before.

`PORW_COLLECTION` makes the relayer the **hatch keeper** for that `FlyCollection`. `breed` fixes only the recipe and
a seed block -- the block after the one it lands in -- and `hatch(id)`, which anyone may call, turns that block's
hash into the child's seed and pays the caller `HATCH_BOUNTY`. The EVM forgets a hash after 256 blocks (about three
minutes on BSC) and an egg nobody hatched in time costs its owner a whole `BREED_FEE` to re-arm, so breeding takes
seconds only if somebody is standing there. The keeper follows `Bred` and `Rearmed` (looking back one 256-block
window on startup), hatches on the first tick after the seed block, and is not a subsidy: an egg is hatched only
when the bounty covers the gas at the current price, and one that does not stays listed in `/status.keeper` with
the reason, since the price may fall inside the window. These are the relayer's own transactions, outside the
sponsorship budgets, and anyone may run the same loop -- whoever lands first takes the bounty.
`PORW_KEEPER=0` keeps naming the collection to the page over `/deployment` without hatching for it.

`PORW_WHITELIST` makes **the brains the relayer serves follow the whitelist**. The mesh is permissionless, but a relayer's
attention is not: aggregating a brain's claims, serving its proofs and sponsoring gas for tasks against it is what being
one of the system's brains means, and whose those are is decided on-chain by `CollectionWhitelist`, whose unit is the
collection. For every listed collection the relayer serves the bases it names and every brain bound to one of its tokens
-- so a fly is served from the pass after its owner registers it, adopted or **bred** alike, with nobody editing
`PORW_MEP_IDS` and nothing restarted; a profile under royalty terms is reproduced with its terms; a collection taken off
the list stops being served. `PORW_MEP_IDS` stays, as brains pinned whatever the list says, and is no longer required when
a whitelist is given. Collections are walked every `PORW_WHITELIST_EVERY` blocks (default 20) rather than followed by
logs: a token's binding never changes once made, so a pass re-reads only what was unbound, and a restart needs no
history. `/meps` says where each brain comes from (`collection`, `token`, `beneficiary`, `royaltyBps`), `/status.whitelist`
what was walked and what was refused, and `/tx/result` and `/tx/settle` are sponsored only for tasks against a served
brain. `test/e2e_whitelist.mjs` covers it.

`PORW_TASK_CLIENTS` says **whose tasks are sponsored**. Third-party experiments are not open yet: every task on the
network is one the FlyBnB dataset needs (the perturbation battery in the paper), posted by the project. `TaskMarket` is
permissionless and cannot refuse anybody's task, so what is withheld is the relayer's gas: `/tx/result` and `/tx/settle`
are refused for a task whose client is not on the list, and a session key holds no BNB of its own. `/deployment` carries
the list (`taskClients`; `null` = anybody's, the default, which is what a local mesh and the tests run with), and the
page reads it: a wallet that is not on it sees "Not open yet" and the two ways in -- host a brain, own a fly -- instead of a
booking card. `test/e2e_anvil.mjs` posts a third party's task on-chain and checks it is not sponsored;
`test/e2e_flybnb_page.mjs` checks what a visitor is shown.
`test/e2e_keeper.mjs` covers startup backfill, a live egg, and a bounty too small to be worth it.

The page has a second view for that collection, **Flies** (`#/flies`; `src/core/flies.js` + `src/ui/FliesView.jsx`): the
colony, the pairing (one female, one male, the base the child will vary, and the fee as what it buys), and the egg. One
block after breeding the page computes the child's seed and sex itself from the seed block's hash, and shows them while
the chain catches up; Hatch and Re-arm are there for when no keeper is running. `test/e2e_flies.mjs` checks that
preview against `FlyCollection.hatch` bit for bit, hatched by the page, by the keeper, and after a re-arm.

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

Keys: never in git, anywhere. Addresses: in one tracked place, **`render.yaml`**, and only for the hosted testnet
relayer. They were kept out of git altogether until the testnet moved to scheme v3 (below) and ten values had to be
retyped in the Render dashboard by hand, with nothing to review and nothing to diff. They are public the moment they
are deployed and the relayer serves them to anyone over `/deployment`, so what the old rule protected was the habit of
not committing env files, and that habit stays: `render.yaml` carries addresses and ids only, marks
`PORW_RELAYER_KEY` and `PORW_RPC` `sync: false` (Render asks once and never syncs them), and
`test/render_blueprint.mjs` fails the build if a secret ever gets a value in it or a stray 32-byte hex string shows up.
A redeployment is now a pull request that changes that block, followed by a manual deploy (the Blueprint keeps
auto-deploy off: a restart drops the beacon secret committed for the next epoch).

Everything else is as before. `deploy.sh` writes `.env.<network>` (`PORW_CHAIN_ID`, `PORW_RPC`, `PORW_EPOCH_BLOCKS`,
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

### Redeployed for scheme v3 — 2026-09-18

`main` had moved to scheme v3 (`sketch-tile-keccak:v3`: no `deviceId`, the sketch seeded by the claiming instance;
`Task.initStateRoot`; `bondFor`; the claim validity window) while the testnet still ran the v2 contracts, and a v3 page
cannot host a v2 MEP: the scheme digest is inside `mep_id`. The eight contracts were redeployed from `main` at
`79af654` (aigg-porw `0e47e0b`) by the same deployer, with the parameters the network already had -- epoch 200 blocks,
commit/reveal 40/40, opening window 200 and deposit 0.002, UNIT 0.005, slash 0.01, beacon deposit 0.005, exit delay
200, task timeout 400, dispute round 400, relay bond 0.001, claim validity 6 epochs -- plus the replicator's challenge
window (200 blocks, deposit 0.02). Cost: 0.0016 tBNB at 0.1 gwei. Every parameter and every wire
(`claimManager`, `slasher`, `disputes`, `beaconProvider`) was read back from the chain afterwards.

The brain is the same object on Greenfield (`gnfd://aigg-brains/flywire-fafb-v783-min5.bin`): its `model_id`,
`synapseRoot` and exec kind are unchanged, so only the scheme digest and therefore the id moved. MEP
`0x312dda12d308ba13796472e6ba444be4a94a5b04ce9e5ef3ada3649034443f8a` (`tasks/flywire-gate/fields/flywire-783-min5.v3.json`,
recomputed independently before registering), tx `0x1cf28f6feca5869ba5dd9aab360c87f9babd19e21f441f9b25ed3814adf3a833`,
227,653 gas. The addresses are in `render.yaml`. The old contracts held no bonds and no fees when they were left.

Not on this deployment: MEP terms (royalties) and batched tasks, which reached `main` with aigg-porw `f04411b` while
the contracts were being deployed. They are additive -- a royalty-free MEP keeps its id, the silence flag acts only
when a task carries one -- so the `f04411b` runtime serves this deployment unchanged; using them needs one more
redeploy.

### Redeployed with the genesis collection — 2026-09-19

The redeploy the paragraph above asks for. From `main` at `b3a88d7` (aigg-porw `994ccf4`: MEP terms, batched tasks,
the chain-read LIF weight unit), same deployer, same parameters as 2026-09-18; every address the deployment names was
checked to hold code, and every parameter of the collection was read back from the chain. The addresses are in
`render.yaml`.

- **Two brains.** `flywire-783-min5` keeps its id (`0x312dda12…3f8a`, tx `0xc3acea49…f800`): it is what the gate task
  and `test/live_bsc.mjs` run on. `flywire-783-min2` is new: MEP
  `0x79af9764440ecfefecac3056fccfa3720c1cbb09600eb0d2facad53da4315f50` (`flybnb/genesis/flywire-783-min2.v3.json`), tx
  `0x6ece389ee4a00ac328131f3ca9f06a1e3065f905253f792d47bd239cba2706d7`, 139,255 neurons, 7,595,967 synapse records,
  `gnfd://aigg-brains/flywire-fafb-v783-min2.bin` -- fetched back from Greenfield (77,074,432 bytes) and its `model_id`
  recomputed before registering, because a registration is immutable. It is the base the hundred founders are variants
  of (`genesis-v1.json: baseModelId`), so it is the collection's `BASE_MEP_FEMALE`: what an adopter is bonded for.
- **`CollectionWhitelist`** `0xAd8e7206A9bE4F24Ce0aa2c861F1E9331A16681C`, curator = the deployer. Deployed on its own
  (tx `0xb44610fc…4a4f`): `DeployBNB` created it *after* `vm.stopBroadcast()`, so the first run wrote an address into
  `deployments/97.json` that had no contract behind it. Fixed in the script; `test/harness.mjs: deploy` now refuses a
  deployment file that names an address without code, which is what every scripted e2e goes through.
- **The genesis collection** `0xE0a5a93CD9398BdFcA992F877d513e49E18E7AA4` (`deploy_collection.sh`), listed. Root
  `0x02d6d4d2…4d78`, 100 founders, all female. Testnet-scale prices, in the proportions of the mainnet intent
  (0.1 / 0.05 / 0.05 / 0.001 BNB): adopt 0.01 tBNB of which 0.005 (one UNIT) becomes the adopter's own bond, breed
  0.005, hatch bounty 0.0001; royalty 1000 bps through the market. Treasury = the deployer and no lineage registry --
  both immutable, both to be decided again before a mainnet deployment. There is no male base yet, so this network
  adopts and registers; it does not breed.

Cost: 0.0021 tBNB at 0.1 gwei for everything. The 2026-09-18 contracts are left as they are; bonds placed in that
`InstanceRegistry` during the live runs stay withdrawable by their owners through the ordinary exit.

### Live run record — 2026-09-18, scheme v3, against the hosted relayer

`test/live_bsc.mjs` with the real FlyWire brain against the deployment above and the relayer **on Render**
(`aigg-bnb-relayer-testnet.onrender.com`, built from `main` at `7a7a705`, runtime aigg-porw `f04411b`, lazy beacon) --
the first run in which the relayer was somebody else's machine, reached over TLS and a WebSocket through a proxy,
rather than a process next to the instance. Instance and client were one wallet (the deployer); the relayer was its
own account, funded with 0.3 tBNB an hour earlier. Gas price 0.1 gwei. Evidence: `tasks/live-bsc-20260918-v3.json`;
every receipt below was read back from the chain.

| step | epoch | who | tx | gas |
|---|---|---|---|---|
| bond 0.05 BNB for the v3 MEP (10 votes at UNIT 0.005) | 659206 | instance wallet | `0x2b937dbdd4fa58aaa13d6073912ee5989f699217d2f2898632c8c9c527f6a9c4` | 116,224 |
| `/wake`, then `delegateBySig` (session key, EIP-712) | 659206 | relayer, sponsored | `0x3690b0b52892e990e7a2e9aba66b6a87b93b888d321d5755e805d9f9b07e4730` | 54,989 |
| beacon commit / reveal / `rollEpoch` for 659207 | 659206–7 | relayer | `0xa1521ec8…` / `0xacef82cb…` / `0x51cb95d2…` | 115,223 / 100,408 / 52,342 |
| claim for 659207 announced over the relay | 659207 | instance | claimHash `0xabc17e35ce…` | — |
| beacon commit / reveal / `rollEpoch` for 659208 | 659207–8 | relayer | `0x25514595…` / `0x5dc50d82…` / `0xd99d5358…` | 115,235 / 100,408 / 52,342 |
| `postEpochRoot(659207)`: 1 claim, 1 MEP, one root for the epoch | 659208 | relayer | `0x486813a6d236aa003c28404ac93667cef8aaf5878ae039382138c8e041cc42db` | 71,842 |
| `materializeClaim(659207)` with the relayer's inclusion proof | 659208 | relayer, sponsored | `0x797f6f91e30475af802f1a63673c4c7ea7f3ec0affe5238b5cc026683ac772da` | **112,008** |
| `postTask` (fee 0.001 BNB, 100 steps, stride 10, redundancy 1) | 659208 | client | `0xb95ee30efa0face3dfdebe980bd38eec4ffa4ba4058af8038f925a39d95d8386` | 197,267 |
| `submitResult` (EIP-712, session key) | 659208 | relayer, sponsored | `0xd6c009221674fdd8a4ece302dc68662f94d18cc3de307314d6fb7f9bb6c496a2` | 155,505 |
| `settle` → fee paid to the instance | 659208 | relayer, sponsored | `0x2a4811026d7bd341e67f3f8f35b05ee13f4353554c44a47f97939e6ccd74e875` | 126,058 |

Afterwards: `hasValidClaim(instance, MEP, 659207) == true`; three `TaskMarket` events (posted, submitted, settled);
the relayer had spent 0.0002 tBNB in all.

**What it shows.** The cold start is still exactly two epochs -- woken in 659206, beacon and claim in 659207, root,
materialization, task and settlement all in 659208 -- but an epoch here is 200 blocks and the testnet now makes a block
in about 0.45 s, so `delegateBySig` to `settle` was **473 blocks, 3.5 minutes** (10.3 in the run below).
`materializeClaim` is **112,008 gas where it was 284,571**: a claim on-chain is one storage word now, and the root
covers every MEP of the epoch. And the two things the second run could not exercise were exercised: the relay hub and
the API on one port behind a proxy (`PORW_RELAY_PATH`), and the address browsers are told (`PORW_PUBLIC_RELAY_URL`).
An instance held a WebSocket through Render's proxy across two idle epoch boundaries and was still there for the task.

**What it found.** The relayer's `/status.errors` held nine `beacon.commit(…) reverted: committed` over three epochs.
Its tick fires every 2 s and waits for receipts that take longer, so a second tick reaches the commit branch before the
first has stored its secret, and queues the same commit again; the send queue runs it after the first is mined and its
gas estimate reverts. Nothing was spent and every epoch got its beacon, but it is the same overlap the page's node loop
had, and `rollEpoch` and `postEpochRoot` sit behind the same interval.

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

### Live run record — second run, with the lazy beacon on (BSC testnet, chain 97)

`test/live_bsc.mjs` again, this time against a relayer started with `PORW_BEACON_LAZY=1`, so the beacon followed
demand instead of the clock. Every transaction below was sponsored through the guard described above (bonded
caller, simulation, gas budget) and nothing was refused. Gas price on the day: **0.1 gwei**.

**The mesh was asleep and it cost nothing.** Beacon logs over epochs 164580–164586 — seven consecutive epochs,
about seventy minutes — contain no `Committed` and no `Revealed`: not one transaction, because nobody had asked
for a beacon. The first commit of the day was the one the arriving instance triggered.

| step | epoch | tx | gas |
|---|---|---|---|
| `/wake` from the bonded instance, then `delegateBySig` | 164587 | `0xc2b3a74b2111a11f08dc7d5702712deb2939d465c9871168ab2d306251eb2203` | 54,911 |
| beacon commit for 164588 (the first spend after seven idle epochs) | 164587 | — | — |
| reveal 164588, commit 164589 | 164588 | — | — |
| claim for 164588 announced over the relay | 164588 | claimHash `0x44c0156d19…` | — |
| `materializeClaim(164588)` with the relayer's inclusion proof | 164589 | `0x7510d42aae5919f76997582128cf1b67fd76b359f9358aaf1edd3fde0df79f96` | 284,571 |
| `postTask` (fee 0.001 BNB, redundancy 1) | 164589 | `0xa4bd3f738ebddcf3654a034499de0dbc14a6f56c6a50bf58ac6d46c00fbffd51` | 194,460 |
| `submitResult` (EIP-712, session key) | 164589 | `0x36f1d8bfa9172ae7f8b9366359704478f368af8ea6c45e889f11c55254380863` | 146,463 |
| `settle` → fee paid to the instance | 164589 | `0x5f5d379a5e90515815971baad03d772475665f1ab97eeb48961168508dc1cb03` | 92,250 |

**The cold start was exactly the predicted two epochs.** Wake and delegate in 164587, beacon for 164588, claim in
164588, root posted and materialized in 164589, eligible and executing a task in the same 164589 — 10.3 minutes
of wall clock from `delegateBySig` to `settle`, essentially all of it waiting for epoch boundaries.
`materializeClaim` came in at 284,571 gas, the same figure as the first run and as `e2e_lazy_beacon.mjs` on
anvil. Evidence: `tasks/live-bsc-20260917.json`.

What this run did **not** exercise: the relay hub and both clients were on one machine, so nothing was in a
position to cut an idle WebSocket and the keepalive was never actually put to the test. That, along with
`PORW_RELAY_PATH` and `PORW_PUBLIC_RELAY_URL`, waits for a deployment with a proxy in front of it.

## Build and test

```sh
git submodule update --init --recursive   # aigg-porw and forge-std, pinned under contracts/lib/
cd contracts && forge test          # remappings point at contracts/lib/aigg-porw (pinned submodule)
cd .. && npm install && npm test    # js/test_greenfield.mjs (a local server stands in for the storage provider)
NETWORK=anvil ./deploy.sh           # deploy the BNB-parameterized mesh to a local anvil (or opbnb-testnet / bsc-testnet)
```
