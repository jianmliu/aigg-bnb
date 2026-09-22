# Base enrolment implementation plan

Goal: implement aigg-porw #36 base registration, enrolment and eligibility. Preserve per-derived execution identity, tasks, royalties and fraud adjudication. No live redeployment or sampled claim change.

Architecture: a derived MEP explicitly registers an immutable root base MEP. The base association is domain-separated into the derived MEP ID before royalty wrapping; public plain registration cannot squat or mutate it. Base must exist and itself be a root. Match scheme, execution kind and neuron layout; this is routing validation, not proof of scientific lineage. FlyCollection remains responsible for token/lineage provenance. Standalone MEP IDs retain existing identity.

InstanceRegistry gets a one-time registry configuration. In configured mode bond/enrolled/weightCap/isBondedFor/isEligible/eligibleVotes/sortitionPick resolve derivative IDs to base IDs. Claims are made and materialized for the base, not each derivative. Tasks still bind and dispute the child MEP, and task rosters remain snapshots. Legacy unset-registry deployments retain per-MEP behavior.

- [x] Upstream: MEPRegistry derived registration, hash helper and base lookup, InstanceRegistry base routing, tests for distinct identity, immutable linkage, descendants, malformed bases, weighting, base claim eligibility and slashing/exit.
- [x] Browser runtime: derived MEP hash helper and load options; tests for Solidity/JS matching and unchanged legacy identities.
- [x] Collection/deployment: opt into derived registration in a new deployment when the instance registry is configured for bases; validate maternal base link and preserve royalties. Wire DeployBNB registry configuration. Test cross-sex child uses maternal base, front-running and legacy registrations.
- [x] Relayer/UI: publish base metadata, aggregate base claims only; host eligibility/capacity uses base grouping and provider count sharing. Host claims base while child execution remains exact MEP. Explicitly document on-demand model loading limits; do not claim a host loader exists unless implemented/tested.
- [x] Integration: base-only bond and base claim makes future derived MEP task drawable; existing native/token task settlement and disputes remain valid. Run tests, independent review, docs and commit.

Use test-first implementation and subagent-driven-development for independent upstream and application pieces. No deployment, no key/environment modifications. New contracts require deployment migration before activation.

Completed with on-demand execution loading explicitly deferred; browser serves prepared child models and deduplicates their base claims. Deployment flag smoke-tested against local Anvil; no live deployment.
