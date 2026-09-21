# Family Hosting Implementation Plan

> **For agentic workers:** Use subagent-driven-development for bounded runtime implementation and independent review.

**Goal:** Turn a base-resident browser host into an automatic executor for future descendants.

**Architecture:** Reuse base enrollment and capacity contracts. Add runtime family inbox service with a validated resolver and ephemeral child execution; page resolves chain authorization and recipes; worker persists replay records. Filter Host UI by enrollment pools while leaving browsing all MEPs unchanged.

**Tech Stack:** JS, React, Web Worker/WASM, viem, IndexedDB, Anvil/Playwright.

- [x] Runtime: add upstream family_service.js with serialized dynamic dispatch, exact MEP verification, result reuse/replay and node lifetime bounds; hook browser worker; tests first.
- [x] Resolver: add frontend/src/core/family-task.js chain snapshot authorization, bounded DA and ancestor retrieval, native/token task binding; unit tests.
- [x] Integration: controller request/response bridge with immutable host config; per-family loading and UI family catalog/status; preserve base residency claims.
- [x] Test real chain/browser late child task and independent output equality; negative tests; full runtime regressions and frontend build.
- [x] Independent spec and code review, fix findings, document current limits and locally commit both repositories.

## Verification record

- Resolver/relayer admission: 18 unit cases pass, including invalid assignment without downloads, parent hashes, abort/concurrency, 64-run cap and pinned-root sponsorship boundaries.
- Actual-WASM runtime: multiple children, inherited batch, replay after key rotation, malformed ancestry and journal failure; base heap remains unchanged.
- Real Chrome IndexedDB: reload, binary records, atomic capacity enforcement, no eviction and unavailable storage.
- Real browser + Anvil: host starts with only root; later derived MEP receives a real task, downloads one delta, matches independent execution, submits on chain and replays after submission without refetching the base.
- Legacy browser hosting, memory reservations, wallet selection, RPC/capacity checks and runtime batch/count/handler regression checks.
- Independent review findings resolved: resolver timeout concurrency and batch admission mismatch. Integration test additionally found and verified the late-child relayer sponsorship fix.

Remaining scope: live migration/deployment, sampled claims, automatic dispute transactions and replay-journal archival/pruning. See `docs/FAMILY_HOSTING.md` for operational bounds.
