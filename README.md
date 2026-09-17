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
# register your MEP (model_id, exec kind, steps, synapseRoot, weightsDA=gnfd://bucket/object) — see test/harness.mjs registerSyntheticMep
# relayer: addresses + RPC come from the env file; add the relayer key and the MEP ids to it (or export them)
echo "PORW_RELAYER_KEY=0x...
PORW_MEP_IDS=0x<mep id>,0x<mep id>
PORW_RELAY_PORT=8787
PORW_API_PORT=8788" >> .env.bsc-testnet
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
`PORW_DISPUTES`, `PORW_RELAYS`); the relayer reads the environment (`relayer/env.mjs`) and serves the
addresses to the frontend over `/deployment`, so the page needs nothing but the relayer URL. `deployments/*.json`,
`.env*` and `relayer/config.json` are gitignored; keep the env files in your secret store. The end-to-end tests
start the relayer through the same `PORW_*` variables.

## Testnet deployment status

`deploy.sh` targets `bsc-testnet` (chain 97, default RPC on port 443) or `opbnb-testnet` (chain 5611). Not yet
deployed: awaiting testnet funds on the deployer.

## Build and test (standalone layout)

```sh
cd contracts && forge test          # remappings point at contracts/lib/aigg-porw (pinned submodule)
cd .. && npm install && npm test    # js/test_greenfield.mjs (a local server stands in for the storage provider)
NETWORK=anvil ./deploy.sh           # deploy the BNB-parameterized mesh to a local anvil (or opbnb-testnet / bsc-testnet)
```

After `./split.sh /path/to/aigg-bnb`, the same commands run against the pinned submodule `contracts/lib/aigg-porw`.
