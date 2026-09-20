# Founder treasury inventory launch — preparation

Status: implementation and local rehearsal passed; BSC testnet broadcast and Render cutover pending exclusive use of deployment account.

## Intended deployment

- Chain: BSC testnet (97), existing mesh and TreasuryRouter.
- Treasury: `0x1Bef7990Ea5d9C761aACe71c48432078AAC43708`.
- Genesis v2: 200 Founders, 100 female + 100 male.
- Root: `0x8cffc3ced1135f698f9e6477fac20cb05e8c4dfe65cf8e986e252c3dbd3f0c5e`.
- Adoption: resale from vault, 0.01 tBNB each; full proceeds to TreasuryRouter; no adopter Host bond.
- Legacy collection/NFTs remain intact.
- No Breed battery budget or production worker is introduced by this launch.

## Verification

- `forge test --root contracts`: 199 passed, 0 failed.
- `FOUNDRY_BIN=/Users/jianmingliu/.foundry/bin node test/e2e_founder_inventory_launch.mjs`: passed using all 200 committed profiles on local Anvil.
- Rehearsal covers protected mint, paused stocking, exact profile commitments and collection-bound royalty MEP IDs, conflicting registry DA hint with collection-authored WeightsHint, full treasury payment, return/relist of the smoke-purchase NFT, interrupted activation journal, public adoption and idempotent resume.
- Independent contract and deployment-script review: no remaining launch blockers after addressing public-buy/stocking race, registry hint front-run and activation/smoke-purchase recovery.

## Operator execution

Build contracts, stop concurrent use of the deployment account, then run:

```sh
node --env-file=.env.bsc-testnet js/launch_founder_inventory.mjs --broadcast
```

The script restricts live execution to chain 97 and the known deployer. It reserves gas for the complete launch and writes `deployments/founder-inventory-97.json` before every broadcast. Preserve this journal. If a prepared hash has no receipt, investigate its nonce/hash; do not remove it and blindly rerun. Artifact/configuration changes intentionally fail journal matching.

After verified launch, record the journal's collection/vault/sale/renderer addresses and receipts, update `render.yaml` plus the relayer's `PORW_COLLECTION` and `PORW_INVENTORY_SALE`, and deploy the relayer. Verify the public `/deployment` and the live Adopt inventory before marking this record complete.
