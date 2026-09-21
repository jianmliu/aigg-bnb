# Founder treasury inventory launch — BSC testnet

Status: 200 Founders deployed, registered, listed and activated on BSC testnet. Render cutover is live; browser acceptance shows all 200 adoption entries at 0.01 BNB and no missing-configuration warning.

## Deployment

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

## Live addresses and transactions

- Collection: `0xb42dfb7b281535ddc836b3de8df62e5f59b5b7c5`
- Renderer: `0xebf1d577d317f5b9dacdf3033caa426306a9f061`
- Inventory vault: `0x235ed095a6cffd45c067d12863d8df7c71d9e7f5`
- Inventory sale: `0x9668397498C564DB5e604b1156EEE97Ed6A62f62`
- Test adoption: `0xe7cdce4ab0f1478258383bb0ecf79623ccfe4b6017c5fecf1e2e26a45600a046`
- Treasury increase: exactly 0.01 tBNB; no sweep or liquidity operation performed.
- Test NFT returned to vault and relisted; token 1 listing revision is 3, other initial listings revision 1.
- Total deployment/stocking/smoke gas: 119,426,065; actual gas cost 0.01281327411516594 tBNB.
- All transaction receipts and 200 collection-bound MEP IDs: [public launch journal](founder-inventory-bsc-2026-09-20.json).

Initial Render cutover: service `srv-damav3p42hec738utj1g` deployed commit `6d993b2179c3fefad3ef82a4ffbd18cc5ac6bca8` with deployment `dep-dao6csmgekts73b2gru0` (live). Updated only `PORW_COLLECTION` and `PORW_INVENTORY_SALE`; existing MEP names/IDs, RPC, credentials and other environment settings were preserved. Public `/deployment` returns both new addresses. Local ignored `.env.bsc-testnet` and `deployments/97.json` were also synchronized.

## Browser acceptance and catalog scaling

On `https://fly.ai.gg/#/flies`, the colony shows 200 individuals (100 female, 100 male). Refreshing treasury inventory shows 200 `Adopt · 0.01 BNB` buttons and the vault as seller. No "Treasury adoption is not configured" warning remains. Buttons are disabled for an unconnected visitor, as intended. The on-chain smoke purchase above verifies actual delivery/payment; browser acceptance did not sign a wallet transaction.

The 200-profile launch exposed unbounded parallel RPC reads in `/meps` (`Request exceeds defined limit`, HTTP 500). The accompanying relayer fix caps concurrent provider reads at four and shares successful 10-second catalog snapshots between visitors. Failed scans drain outstanding work and do not cache partial/zero provider counts. Membership changes invalidate the cache. Ten provider/capacity unit tests and `test/e2e_gateway_wake.mjs` pass; independent review found no remaining correctness issues. The catalog fix must be deployed with this cutover commit.

### Full-catalog follow-up

The four-request concurrency cap alone still hit the public RPC limit at the complete catalog size. On BSC/BSC testnet, provider vote reads now use the canonical Multicall3 address from viem's chain definitions, in sequential batches of 32. This reduces 200 Founder reads to seven RPC calls. Every inner call must succeed; there is no fallback that silently converts failed reads to zero providers. Other chains retain the bounded individual-read path.

A read-only check against the actual BSC testnet contracts verified all 200 Founders in 451 ms, with the cached second read completing in under 1 ms. Eleven provider/capacity unit tests pass, including the seven-batch assertion. No chain transactions or environment changes are needed for this follow-up.
