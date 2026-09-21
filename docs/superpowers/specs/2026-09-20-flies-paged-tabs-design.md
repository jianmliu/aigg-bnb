# Flies: Adopt and My flies

Approved in conversation: default Adopt tab, 12 cards per page, all/female/male filtering; separate wallet-only My flies tab with breeding. Remove the full Colony presentation.

The relayer exposes a read-only paginated collection index. It caches a coherent block snapshot of ownership, sex and sale availability; BSC reads are batched through Multicall, other chains use bounded reads. Responses contain at most 12 candidate IDs, counts and snapshot block, scoped to configured collection/sale. Browser reads only those individuals and their quotes, verifying ownership/availability on chain. No full collection scan in the browser. A mined transaction's block is supplied when refreshing to avoid an older index hiding a purchase.

My flies shows no inventory until a wallet is connected, then only that wallet's tokens, also paginated. Breed and battery panels exist only here. Parent selection survives pagination, but resets with wallet/network/collection changes; breeding rechecks selected parents on chain. Battery reads cover only the visible owned page. Purchases stay in Adopt and refresh its current page; users switch to My flies to see purchases.

Filter and tab changes reset page to one. Refresh retains the active filter/page; out-of-range pages clamp to the last page after sales. Loading and error states never expose stale actionable cards. Empty inventory, disconnected wallet, missing sale and no owned NFTs have explicit messages. Overlapping loads cannot replace newer page state.

No token economics, transaction pricing, royalty rights, contract deployments or scientific policy changes. No new general-purpose indexer or persistent database.

Verify backend filter/pagination/cache invalidation/error handling, browser RPC/card bounds, automatic first-page adoption, male/female filtering, disconnected My flies, wallet purchase and cross-page selection/race behavior. Build and visually inspect responsive layout.
