# Treasury inventory adoption

The Adopt panel now sells existing FlyCollection NFTs from a fixed selling treasury. It does not mint, acquire the treasury's initial inventory with AIGG, create Host bonds, swap tokens, or add liquidity. This implementation has not been deployed to a public chain.

## Contract and custody

`TreasuryInventorySale(collection, treasury)` fixes both addresses at deployment. The treasury remains NFT owner until purchase and is the only address allowed to list, reprice or cancel. Use an EOA or a multisig that can execute arbitrary calls, approve NFTs and receive native BNB. An existing TreasuryRouter that only forwards balances is not by itself an inventory-management wallet.

Each listing specifies a token ID, a positive native-BNB price in wei, expiration as a Unix timestamp in seconds, and an incrementing revision. `buy(tokenId, expectedPrice, expectedRevision, deadline)` requires exact payment, active approval and current treasury ownership. The buyer receives the NFT through safe transfer; the entire payment then goes to treasury. Either both succeed or all state and value transfers revert. No pending refund balance is created. A reverted transaction still costs network gas.

This venue charges no additional ERC-2981 resale royalty: the full advertised price goes to the selling treasury. Existing FlyCollection execution royalties are settled by its transfer hook, so past accrued revenue stays with the prior owner and future holder rights move to the buyer. The selling treasury and the collection's historical `TREASURY` recipient can be different addresses; configure and disclose them deliberately.

Listings are noncustodial. **Cancel before transferring listed inventory elsewhere.** If a token returns to treasury before expiry and the sale contract again has approval, an uncancelled listing can become executable again. Listing/cancellation revisions prevent stale quotes after explicit repricing, cancellation or resale. Prefer per-token approvals, bounded expiration and explicit cancellation to open-ended operator approval.

## Deploy and configure

1. Set `SALE_COLLECTION` to the existing collection and `SALE_TREASURY` to the inventory-owning wallet. Confirm chain, custody, recipient, and that the recipient accepts BNB.
2. Use Foundry's `script/DeployInventorySale.s.sol:DeployInventorySale` with the intended RPC and configured signer. Simulate before adding `--broadcast`. No signing key belongs in source, shell history or deployment metadata.
3. From treasury, call collection `approve(saleAddress, tokenId)` and sale `list(tokenId, priceWei, expiresAt)`. These require treasury authority, not merely the deployer's authority. To withdraw or reprice an offer, call `cancel` or `list` from treasury.
4. Configure relayer `PORW_INVENTORY_SALE` alongside `PORW_COLLECTION`, or supply `addresses.inventorySale` in its deployment configuration. Restart/reload the relayer and verify `/deployment` returns the intended addresses and chain.
5. Publish the frontend only after inventory is configured. The Adopt panel verifies the sale's collection address, reads its treasury, and shows only approved, unexpired, treasury-owned listings. Missing or mismatched configuration exposes no buy action; there is no mint fallback.

The panel currently checks the first 500 sequential FlyCollection IDs and reports truncation. Larger inventories require an indexer. Visitors can inspect listings without a wallet. Purchasing requires a wallet on the deployment chain; each transaction binds the displayed price and revision and a ten-minute deadline based on the chain timestamp. Refresh after a rejected/stale quote.

BNB enters treasury directly. Budget allocation and AIGG/BNB liquidity management are separate treasury operations, not side effects of Adopt. AIGG acquisition of the initial Founder inventory and multi-asset Host settlement remain separate implementation work.

## Verification

- `forge test --root contracts --match-contract TreasuryInventorySaleTest -vv`
- `npm run build:frontend`
- `node test/env_mapping.mjs`
- `FOUNDRY_BIN=<local-foundry-bin> node test/e2e_adopt.mjs`

Use a supported modern Node runtime. The end-to-end test launches its own Anvil and relayer; it purchases from treasury through the real UI, checks walletless browsing, exact prices, invalidated quotes, unchanged NFT supply, seller proceeds, absent buyer bonds, sold inventory and missing configuration.
