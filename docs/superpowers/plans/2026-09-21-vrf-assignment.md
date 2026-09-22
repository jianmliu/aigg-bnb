# Locked VRF Assignment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Replace caller-grindable assignment with irreversible task/candidate locking followed by one authenticated VRF request.

**Architecture:** A versioned synchronous market delegates snapshot/VRF admission to a bounded controller; existing execution/dispute machinery remains compatible. Services and browser understand pending randomness and immutable assigned signers.

**Tech Stack:** Solidity 0.8.33/Foundry, Chainlink VRF v2.5 ABI, Node/viem, React and real-WASM browser host.

## 1. Spec and interface gate
- [x] Review `docs/superpowers/specs/2026-09-21-vrf-assignment.md`, challenge gas/locking/callback/timeout rules, and freeze concrete ABI with implementer.
- [x] Preserve original worktree/user changes; use isolated `codex/vrf-assignment` branch based on main 914dc7d.

## 2. Contracts and economic accounting
Files: new `contracts/src/VrfAdmission.sol`, `contracts/src/VrfSynchronousTaskMarket.sol`, official coordinator ABI adapter; minimal hooks in `SynchronousTaskMarket.sol`; tests `contracts/test/Vrf*.t.sol`.
- [x] Write failing attack regressions before production changes; run targeted forge tests and retain RED evidence.
- [x] Implement immutable snapshot/leases, fixed task signer, authenticated one-shot callback, weighted allocation, no-reroll expiry and positive admission fee accounting.
- [x] Exercise native/ERC20 single/batch, duplicate requests, malformed callbacks, late fulfillment, timeout/allocation races, mutable stake/readiness/capacity, and terminal release.
- [x] Measure runtime bytecode and worst-case candidate gas, then run complete Foundry regression.

## 3. Services, clients and Host UX
Files: `relayer/synchronous.mjs`, `relayer/env.mjs`, `relayer/relayer.mjs`, `gateway/gateway.mjs`, `battery/worker.mjs`, `frontend/src/core/synchronous-*.js`, session/status components, corresponding tests.
- [x] RED tests for explicit VRF mode, phase6 wait/finality, original request recovery, task signer routing, admission fee quote/payment/refund reporting, and Host safe-close.
- [x] Implement reads and bounded authorized allocation/expiry endpoints; keep legacy v1 behavior verified.
- [x] Adapt supported budget clients or reject unsupported VRF accounting explicitly; no implicit retries or hidden fee subsidy.
- [x] Browser shows awaiting randomness and candidate release; test actual lifecycle in built browser.

## 4. Integration, review and handoff
- [x] Run actual Anvil coordinator + market + gateway/host flow, including delayed/out-of-order callback, agreement, random timeout and no rearm.
- [x] Independent spec-compliance and security/code-quality review; fix concrete findings.
- [x] Add deployment/calibration tooling and operator documentation; no live activation with mock coordinator or unfunded/unknown subscription.
- [x] Commit and push reviewable implementation; record validation and any live deployment prerequisites accurately.

## Implementation notes

- Design review replaced historical registry scanning with a bounded global expiring ready roster: historical one-wei enrollments cannot block posting. The measured gas limit reduced the roster from 64 to 32, with the full admitted pool preserved.
- Battery policy adaptation is deliberately fail-closed; existing budgets cannot enable VRF accidentally.
- Gateway failure billing remains unchanged for callers, with admission expense explicitly borne by gateway and capped by a durable operator budget. Signed posting bytes are persisted before broadcast; hash-loss recovery reads the exact posting block.
- Contract spec/security reviews and services spec/quality reviews completed. Fixes included family-manifest deadlines, broadcast recovery, confirmed expense accounting, chat usage and finalized preflight bounds.
- Deployment/calibration tooling is read-only configuration preflight. Live real-coordinator calibration and funded-subscription acceptance are prerequisites, not claimed completed work.

Final local evidence: 338 Foundry tests and 104 focused JS tests passed; production frontend build, legacy gateway/services E2Es, VRF gateway hash-loss restart/no-word expiry/late callback, three-candidate browser release/rearm, and VRF batch disagreement/reload/slash all passed. No live deployment was performed.
