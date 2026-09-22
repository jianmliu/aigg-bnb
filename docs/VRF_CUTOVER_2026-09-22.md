# VRF service and Founder inventory cutover — 2026-09-22

The testnet service configuration moves from `synchronous-v1` to `synchronous-vrf-v1`, using the mesh that completed the [real Chainlink callback acceptance](VRF_ACCEPTANCE_2026-09-22.md). A locked task and candidate pool precede the VRF request. Existing browser and gateway VRF admission paths use this market.

## Inventory replacement

The prior collection's 200 Founders were all held by its inventory vault at the pre-migration audit. Its sale is paused before staging the replacement. No adopter-owned NFT needs transfer. The old NFTs remain intact; this migration recreates the same genesis v2 recipes (100 female and 100 male), with MEP royalty terms bound to the new collection and market. It does not burn or rewrite historical tokens.

| Contract | Previous | Replacement |
|---|---|---|
| Collection | `0x62ea36be228046393b1f876dec93db22c5ecc04c` | `0x7f2dad577a69d92eb9508883842b9bc7eaabb95c` |
| Inventory vault | `0x1608e1a66edd6b35e3784d80c2c29a70a1e3b9f2` | `0x67b5bd21f3aa77c8da102954adff72d490f82cb0` |
| Inventory sale | `0x7a0611Dc6Fa085E0549B00BF7c8E7598E6B428E8` | `0x656cAdB5DD63c1f11BdfCC6268a3EA4cF8862faA` |
| Task market | `0xd179ddef43480dce2dd1176941ba5bcbb779323c` | `0x15380e14f63a6188196ee98e05ff951b66582152` |

Adopt costs 0.01 tBNB, paid to the existing treasury router `0x1Bef7990Ea5d9C761aACe71c48432078AAC43708`. Breed costs 0.005 tBNB, including a 0.0001 hatch bounty. Founder provisioning is protected zero-cost minting into the vault. The launcher certifies every Founder profile for synchronous verification and enables collection token royalty accounting on the new market.

`js/launch_founder_inventory.mjs --vrf --base-enrollment --journal=<separate private journal>` validates admission version 2 and records `synchronous-vrf-v1` in its verification summary. Journals include signed transactions and must remain private. Do not reuse the old inventory journal or deploy another replacement when resuming an interrupted run.

## Service state and funding

Both Render services must use the same new mesh addresses in `render.yaml`. Environment updates preserve all unrelated settings and secrets. The gateway starts with `/var/data/gateway-synchronous-vrf-v1-state.json`; previous market state files remain on disk. Its adjacent admission ledger tracks the explicit lifetime VRF admission budget of 0.01 tBNB. This is a spending cap, not a subscription deposit or an automatic refill policy.

The Chainlink subscription is separately funded and the consumer already authorized. Admission revenue does not automatically fund that subscription. The real acceptance record documents its callback and balances. Operators must monitor both the subscription reserve and gateway admission budget.

Cutover order: finish and verify paused inventory; merge reviewed configuration; activate and test Adopt; update/deploy the relayer, then the gateway; publish the frontend from the merged commit. Final public receipts and service deployment evidence are recorded separately after verification. The legacy battery worker remains unavailable for VRF mode; this cutover does not imply that it has been adapted.

## Completed deployment

[PR #97](https://github.com/jianmliu/aigg-bnb/pull/97) merged as `8c143c41e87542ba1735cc8580c47ab6afdbcbb3`; both Render services are live on that commit. The gateway readiness endpoint reports the new market and a connected relay. The relayer serves all 204 profiles. The [frontend deployment](https://0a228078.aigg-fly.pages.dev) is published at [fly.ai.gg](https://fly.ai.gg); its public index matches the build from that commit.

At finalized block 132555857, both old and new collections had supply 200 and all 200 tokens in their respective vaults; the old sale was paused and the new sale was open. A real [0.01 tBNB Adopt transaction](https://testnet.bscscan.com/tx/0xde3c7ddfa48e463301290930a6128ec5e3a52873501a99f71f7318ec3c275b90) increased the treasury balance by exactly its price. Token #1 was returned and relisted, leaving all 200 available. The live page automatically loads 12 listings per page (17 pages), with no missing-configuration warning.

A read-only Breed simulation for female #1 and male #101 returned child #201 at the unchanged 0.005 tBNB fee. The simulation overrides only the vault's native balance because the inventory vault has no spending balance; no child was actually minted and no storage or authorization was overridden. This is a contract simulation, not a browser-wallet Breed transaction or a completed battery.

See the [public cutover record](../tasks/live-runs/vrf-cutover-2026-09-22.json) for operation hashes, finalized inventory evidence, service deployment IDs and UI checks. Earlier real VRF execution acceptance remains linked above; service cutover did not submit a second paid gateway task.
