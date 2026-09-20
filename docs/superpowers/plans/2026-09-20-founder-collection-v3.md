# Founder collection replacement and direct delta publication

User-approved scope: replace the testnet collection; include real male founders; sell pre-minted inventory at 0.01 tBNB. Preserve the existing TreasuryRouter as revenue recipient. AIGG is infrastructure; this does not issue FLYBNB.

- [x] Reproduce the current 100 female pilot recipes and add the 100 male pilot recipes as a versioned genesis manifest. Do not relabel female brains as male.
- [x] Obtain and verify the male min2 base against the research battery's model commitment, preserving male weight unit 7209 (female 18022).
- [x] Publish 200 hash-addressed delta objects and verified chunked bases; compute all bare model profiles with no legacy #delta URLs. Public byte/hash checks passed.
- [ ] Bind all 200 profiles to the replacement collection address and register final royalty-bearing MEPs on BSC.
- [ ] Add a constrained inventory vault: fixed collection, existing treasury recipient, owner-controlled collection calls and listing, sale receipts forwarded to treasury. Test purchase, custody, mint, registration and access control.
- [ ] Make deployment accept the new genesis file; disable mint-time host bonding, preserve sale price 0.01 tBNB and explicit breed fees.
- [ ] Dry-run new collection, vault, sale, full mint and MEP registration. Validate female/male parents and emitted identifiers before broadcast.
- [ ] Deploy, populate and list inventory; keep old NFTs and records intact. Remove old collection from default discovery only after the replacement is ready.
- [ ] Configure relayer, frontend genesis publication and APIs; verify public inventory, purchase receipt, delta loading and terms-bound host identity.

Resolved input blocker: the male base is now at `/Users/jianmingliu/Projects/aigg-brains/malecns-v1.0-min2.bin`. Independently computed SHA-256 `38227caa7f35af4913a85d0f59c473c4b870e5f9373bb4e07e143163e7a571ba` matches its manifest; size is 154169344 bytes, header has 166700 neurons and 15283237 synapse records. Recomputed PoRW model commitment `0x7a22e8b8a1eae502ea7528be8ed0699b5c31ce5bf6fd2d4e56aedb46bf17394e` matches all 100 male Founder recipes. Battery weight unit is 7209. Remaining evidence: The male research recipes are committed in flybnb/results/male/pilot/rows.jsonl.gz. Old founder weightsDA contains a #delta fragment (live gateway report), rather than the downloadable delta. Old genesis has 100 females, no males. Old collection has one NFT and cannot be rewritten.

## Implementation progress (not deployed)

`genesis-v2.json` contains 200 verified recipe hashes and Merkle openings, with sex-specific base commitments. `FounderInventoryVault` provides typed mint/register/list/cancel operations and forwards sale receipts and collected royalties to a fixed recipient. It creates its own `TreasuryInventorySale`; its owner has a two-step handover, no arbitrary execution or ability to redirect receipts.

`DeployCollection` accepts `GENESIS_FILE=genesis-v2.json`, derives the male base from that manifest, rejects mismatched overrides and requires `BASE_MEP_MALE` before broadcasting a mixed collection. Replacement deployment must explicitly set `MINT_BOND=0`; the generic script keeps existing defaults for old callers. A dedicated bootstrap still needs to prevent third-party public minting during inventory population. Do not use an unprotected zero-price public mint.

Before cutover, publish the verified male base and direct delta objects, compute each derived MEP, then exercise a female/male Breed and its battery queue end to end. No new collection has been deployed, and the legacy fragment URL issue is not yet fixed on chain.

## Asset publication and Breed verification completed

See `tasks/live-runs/founder-assets-and-breed-2026-09-20.md`, the adjacent Breed/publication JSON reports, and `flybnb/genesis/founder-profiles-v2.json`. Asset release: https://369857c9.aigg-founder-assets.pages.dev ; canonical origin: https://aigg-founder-assets.pages.dev . All 200 deltas and both complete base payloads passed public download/hash validation. Real-model local Anvil testing passed two Founder adoptions, funded Breed, hatch, child MEP, two bonded hosts, 2x4-step execution, settlement, royalty split, delivery and unused-budget refund. This is not a complete scientific battery run and does not constitute a BSC deployment.
