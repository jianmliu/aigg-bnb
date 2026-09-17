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

## Claim posture per chain

- **opBNB**: every instance may submit its own EIP-712 claim each epoch (`submitClaim`, ≈240k gas, negligible cost).
- **BSC**: use the **aggregated path** from aigg-porw — an untrusted aggregator (`web/porw-browser/aggregator.js`)
  batches the epoch's verified claims into one root (`postEpochRoot`, ≈72k gas per MEP per epoch) and serves
  inclusion proofs over the relay; only instances that compete for tasks that epoch, or are audited,
  `materializeClaim` (≈232k gas). Passive instances cost nothing on-chain; an omitted instance falls back to
  `submitClaim`. See `docs/DESIGN.md` §5 for the cost model.

## Testnet deployment status

`deploy.sh` targets `bsc-testnet` (chain 97, default RPC on port 443) or `opbnb-testnet` (chain 5611). Not yet
deployed: awaiting testnet funds on the deployer. Deployed addresses will be recorded in `deployments/<network>.json`.

## Build and test (standalone layout)

```sh
cd contracts && forge test          # remappings point at contracts/lib/aigg-porw (pinned submodule)
cd .. && npm install && npm test    # js/test_greenfield.mjs (a local server stands in for the storage provider)
NETWORK=anvil ./deploy.sh           # deploy the BNB-parameterized mesh to a local anvil (or opbnb-testnet / bsc-testnet)
```

After `./split.sh /path/to/aigg-bnb`, the same commands run against the pinned submodule `contracts/lib/aigg-porw`.
