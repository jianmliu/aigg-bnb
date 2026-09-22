# Flies paged tabs implementation plan

Goal: implement the approved Adopt/My flies split with 12-card pages and bounded browser reads.

- [x] Add relayer/flies-page.mjs: snapshot index, configured sale binding, bounded/batched reads, validated view/owner/sex/page/minBlock; wire GET /flies/page. Test filtering, pages, cache and failure behavior first.
- [x] Replace frontend whole-collection reads with page IDs; preserve live quote checks, race protection, receipt-aware refresh and fresh parent validation.
- [x] Render tabs, filters and pager. Only render owned cards, Breed and battery in My flies; persist selected parents across pages and reset on identity changes.
- [x] Adapt and run relevant adoption/breeding browser integration tests, build, visually inspect, independent review, then commit changes.

## Verification

- `node --test test/flies_page.mjs test/provider_stats.mjs`: 12 checks passed, covering 200-token paging, sex/owner filters, cache refresh, invalid queries, concurrent receipt snapshots, and failure recovery.
- `node test/e2e_adopt.mjs`: real Anvil inventory purchase, stale-quote rejection, disconnected/owned views, 12-card bound, page navigation, filtering, refresh failures, and mobile overflow.
- `node test/e2e_flies.mjs`: native/token-funded breeding, preserved selection across filters, egg preview, hatch and re-arm.
- Frontend production build, wallet and memory regression checks, desktop/mobile screenshot inspection.
- Independent code review completed; all reported state and cache races addressed.

Deployment requires the relayer's new `/flies/page` endpoint before publishing the frontend. No contract or environment-variable changes are required. This branch has not been deployed.
