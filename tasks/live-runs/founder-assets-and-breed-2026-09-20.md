# Replacement Founder assets and real-model Breed verification

This release prepares 100 Female FlyWire founders and 100 MaleCNS founders for a replacement collection. It publishes execution profiles and hash-addressed delta recipes. It does not replace the live collection or register its royalty-bound MEPs on BSC.

## Reproduction

Use Node and the checked-out PoRW WASM runtime:

```sh
node flybnb/genesis/build_genesis_v2.mjs --check
node js/build_founder_profiles.mjs /path/to/aigg-brains /tmp/aigg-founder-assets https://aigg-founder-assets.pages.dev
node js/verify_founder_assets.mjs /tmp/aigg-founder-assets
node js/mirror_pack.mjs /path/to/aigg-brains/flywire-783-min2.bin /tmp/aigg-founder-assets/bases/flywire-783-min2.bin
node js/mirror_pack.mjs /path/to/aigg-brains/malecns-v1.0-min2.bin /tmp/aigg-founder-assets/bases/malecns-v1.0-min2.bin
FOUNDER_BASE_DIR=/path/to/aigg-brains FOUNDRY_BIN=/path/to/foundry/bin node test/e2e_real_founder_breed.mjs
```

The generator verifies each base's SHA-256 against its manifest, recomputes its model commitment, applies every published recipe, computes the resulting model/CSR/execution profile, and records the runtime WASM digest. The separate verifier recomputes profile IDs, checks execution parameters and all recipe hashes against the versioned genesis manifest. It is a consistency check, not a second full reconstruction of all model/CSR roots; reconstruction is performed by the generator. `verify_founder_publication.mjs` separately downloads every public delta and all base parts, comparing them with the generated artifacts and known base SHA-256 digests.

## Profile identity and availability

`profiles.json` contains **bare profile IDs** in its `mepId` fields. FlyCollection binds these to its address and royalty basis points when registering a Founder. A replacement address necessarily produces different royalty-bearing MEP IDs; old collection IDs must not be reused.

Each Founder points directly to `/deltas/<deltaHash>.delta`, with no `#delta` fragment. Base objects exceed the Pages file limit and use `.bin.parts.json` plus contiguous `.partN` files. The host reconstructs the base and verifies its model commitment before applying a delta. Both base MEPs must be served/discoverable by the new relayer configuration.

The male execution kind uses `wUnitQ16=7209`; the female kind uses `18022`. Before male tasks can be posted, call `MEPRegistry.declareLifKind(7209)` and verify `lifWeightUnit(execKind)`. Registering a MEP alone does not declare its execution kind.

## Deterministic Breed rule: pairing-as-entropy v1

The current collection uses the female parent's base commitment for the child. Its chain seed binds both parent delta hashes, their token IDs, the child token ID and the seed block hash.

`js/breed_recipe.mjs` materializes that rule: use the maternal recipe's population parameters and layout, sample with the low 64 bits of the chain seed, and fit the child's deterministic name to the base name's byte length for in-place recipes. Parent pointers inside the procedural recipe are zero because the two connectomes do not share neuron indices. Parent provenance remains in the collection and chain seed.

This is **not anatomical inheritance across male and female connectomes**. An offspring labeled male may still use the female base and female execution kind. Host selection, battery selection and weight units must follow the base/profile rather than the NFT sex label. Cross-connectome cell-type mapping remains separate research work.

The legacy `register` route remains owner-attested: this test does not add an on-chain proof that the child's declared recipe follows its seed. Verifiable `LineageRegistry` registration is a separate integration requirement.

## Verification scope

`test/e2e_real_founder_breed.mjs` uses the actual Female FlyWire and MaleCNS files, the 200-entry Merkle root, real recipes and actual contracts on a local Anvil chain. It exercises two inventory purchases, treasury receipts, Founder royalty MEP identity, funded Breed, chain-seed calculation, deterministic child materialization, child registration, two bonded hosts, residency claims, paid task execution, matching outputs, settlement, delivery and unused-budget refund.

Execution in this test is **two stimulus runs of four steps**, not the 39-run/5000-step scientific battery. The existing battery queue integration test separately exercises restart recovery, output publication and refunds using a small synthetic model. Neither test measures biological validity or assigns scientific rarity to the new collection.

The publication is isolated in `aigg-founder-assets`; it does not overwrite `aigg-brains`, `fly.ai.gg`, `ai.gg`, Render configuration or existing chain records. Production cutover, complete inventory minting, full battery runs and final royalty-bound MEP registration remain separate deployment steps.

## Published release and results

- Canonical origin: https://aigg-founder-assets.pages.dev
- Deployment-specific origin: https://369857c9.aigg-founder-assets.pages.dev
- Profiles: https://aigg-founder-assets.pages.dev/profiles.json
- Genesis: https://aigg-founder-assets.pages.dev/genesis-v2.json
- Local artifact: `flybnb/genesis/founder-profiles-v2.json` (200 Founder profiles, 2 base profiles).
- Download evidence: `founder-publication-2026-09-20.json` (200/200 deltas, female 77074432 bytes, male 154169344 bytes, both SHA-256 matches).
- Real-model local chain evidence: `founder-breed-2026-09-20.json` (PASS).
- Checks passed: genesis/Breed recipe unit tests; vault/sale/battery contract tests; frontend Flies integration; battery queue integration; real-model Founder Breed integration; asset consistency and public download verification.

The real-model test also checks the 0.01 native task fee's 0.001 royalty allocation: 0.0009 credited to the child NFT holder and 0.0001 to the base recipient. These are local smoke-test amounts, not new production pricing.

A first canonical-URL read immediately after deployment briefly returned 404; the deployment-specific URL and subsequent canonical reads returned the correct bytes. The recorded complete public verification ran successfully after propagation.

The female base profile reproduces existing ID `0x79af9764440ecfefecac3056fccfa3720c1cbb09600eb0d2facad53da4315f50`. If it is already registered, its original immutable availability hint stays in force; keep its existing working mirror, or expose compatible object paths. The generated manifest does not rewrite existing registry entries.
