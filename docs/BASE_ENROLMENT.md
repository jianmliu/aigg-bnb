# Base enrolment and eligibility

Implements the registration/eligibility portion of aigg-porw PR #36. No live migration is performed. Browser family hosting now supports automatic on-demand child loading. Sampled claims remain separate work.

## Identities and registration

Standalone MEP identifiers do not change. A newly registered derived profile is identified by:

```
raw = mepId(scheme, model, executionKind, neurons, synapses, synapseRoot)
derived = keccak256(keccak256("aigg:mep:base:v1") || raw || baseMepId)
withRoyalties = keccak256(derived || beneficiary || uint16(royaltyBps))
```

MEPRegistry exposes `baseOf`, `registerDerivedMEP` and `registerDerivedMEPWithTerms`. The base must already exist, must be a root, and must have the same scheme, execution kind, neuron and synapse counts. This supports the in-place family, not compact layouts. Public registration under another base or terms creates another identity; it cannot mutate the intended profile or front-run it into another pool. Descendants register directly against their root base; recipe ancestry remains independent of pool membership.

This is an immutable routing assertion, not a cryptographic proof that arbitrary submitted bytes actually derive from the base. FlyCollection retains the distinction between its legacy owner registration path and validated LineageRegistry path. Base pooling does not silently upgrade legacy lineage trust. A malicious compatible-size model/incorrect DA can still cause task non-response; paid-timeout policy and on-demand loader verification remain important.

## Stake, claims and task execution

Configure `InstanceRegistry.setMEPRegistry` once, before the first bond. `enrollmentMep` maps a derivative to its root and a standalone profile to itself. Bond membership, roster length, weight cap, vote reporting, eligibility and sortition all use this root. Stake remains global per host, capped under the existing rules. A base claim's validity and fraud invalidation cover its derivatives, including ones registered after the claim. Exits and slashes retain their existing semantics.

Task identity, execution profile, model, batch inputs, royalties and dispute proofs remain attached to the child. TaskMarket and MultiAssetTaskMarket keep snapshot executor lists. Repeated tokens do not create separate enrollment transactions or residency claims. Addresses are not evidence of independent economic ownership; pool size alone does not eliminate Sybil/collusion risk.

## Application behavior

FlyCollection detects base-mode configuration at construction, verifies its female/male base profile mapping, and records it immutably. Both founder and child registrations use derived IDs in this mode; cross-sex offspring route to their maternal base regardless of child sex. Pre-registered matching profiles can still bind, including collection royalty terms.

Relayer catalog rows expose `baseMepId` (null for roots) and `enrollmentMepId` (authoritative from InstanceRegistry). It retains child metadata, loads missing base dependencies, aggregates base claims only and shares provider/eligibility reads across the pool. `/epoch?mep=child` still reports the exact child's challenge and identifies its enrollment MEP; clients must request the base for residency. Failed RPC reads never silently choose legacy routing. Older contracts with unsupported getters preserve per-MEP behavior.

When `/deployment.familyHosting` is true, the browser Host catalog lists roots only. Hosts load and bond the base, announce/materialize base claims, and automatically answer assigned root or descendant tasks. The resolver reads the exact task, executor snapshot, enrollment route and child MEP directly from one chain block, so descendants registered after node startup do not need a catalog refresh. Legacy deployments retain per-MEP hosting.

A child recipe and content-addressed ancestors are fetched only after assignment validation. The worker checks ancestor hashes, family/layout, reconstructs the payload from resident base bytes and verifies the exact child MEP including royalty terms. Each task uses a temporary WASM node; the root stays resident for audits and later tasks. See [browser family hosting](FAMILY_HOSTING.md) for limits and replay behavior.

## Activation and migration

`BASE_ENROLMENT=true` in a **new** DeployBNB run configures pooling before any bond. Default false preserves existing deployment behavior. Deploy matching new registries, markets and collection, register root bases first, then start the relayer and hosts. Restart the relayer if enabling the one-time setting before initial use; route metadata is startup/catalog-discovery state, not an extra per-tick RPC.

Existing deployed non-upgradeable contracts and already bound NFT MEP IDs are unchanged. They cannot be relabeled in place. An explicit migration and operational plan is required before production activation. No keys, Render variables, balances, contracts or live collections were changed by this implementation.

## Validation

Tests cover immutable hashes and JS/Solidity vectors, compatibility/rejection cases, future child eligibility from real aggregate base claims, base fraud slashing/exit, snapshot task rosters, child token-payment disputes, collection royalties and pre-registration, configured/unconfigured relayer behavior, cold-epoch materialization, whitelist changes, and browser claim deduplication.
