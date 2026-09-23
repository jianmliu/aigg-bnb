# Shared task-assignment beacon

The `synchronous-vrf-rounds-v1` mode restores shared-round task scheduling, using one Chainlink VRF request as each nonempty round's random source. It uses admission version 3 (`RoundVrfSynchronousTaskMarket` and `RoundVrfAdmission`). Existing deployments remain explicitly versioned; selecting this mode cannot upgrade an existing market.

This beacon assigns execution tasks. The existing PoRW epoch beacon and residency claims still determine candidate eligibility.

## Lifecycle

1. The first funded task opens a round with a fixed closing block. Subsequent tasks may join before that block, up to `maxRoundTasks` (1–64).
2. Each task freezes its eligible candidate pool, capped stake weights, asset and signer routing. Every candidate reserves one declared capacity slot and one bond hold for that task before randomness exists.
3. At or after the cutoff, anyone may call `sealRound(roundId)`. This requests exactly one VRF word. There is no early sealing, replacement request or automatic reroll.
4. The authenticated callback stores the shared word in constant work. Each task derives separate, domain-separated weighted draws from that word, its identity and its frozen snapshot, selecting two distinct hosts.
5. Anyone may allocate each task before the allocation deadline. Commit, reveal, dispute and settlement proceed independently for every task. An unresolved task does not prevent another task from submitting or settling.
6. Terminal tasks release their reservations and holds. Missing randomness or allocation times out independently per task, returning execution escrow. A round that requested VRF charges its admission cap divided by its frozen task count; if no request was made, the entire admission cap is credited back.

A host can stop future admissions without cancelling existing commitments. A host cannot join a different round until its current reservations drain. Signer routing is snapshotted; registry delegation revocation and signature authorization remain live.

## Deadlines

- Collection closes at `firstPostBlock + ROUND_BLOCKS`; no task joins at the closing block.
- Randomness must arrive by `closeBlock + WAIT_BLOCKS`, inclusive. Sealing is allowed from the closing block through that deadline.
- Allocation closes at `fulfilledAt + ACTIVATION_BLOCKS`, inclusive.
- Commit, reveal and total execution deadlines are anchored to that allocation cutoff, not the keeper's chosen allocation time.
- Late or duplicate callbacks cannot revive a task or change its draw.

## Host behavior

The browser defaults to one capacity slot. Hosts explicitly choose a larger bounded capacity if their machine and connection can complete multiple tasks within the shared deadlines. Slots are commitments, not proof of processing speed.

Round mode keeps separate durable task journals under a single host lock, plus a durable readiness/drain journal. Compute and evidence operations share a serialized worker with bounded task pins. The UI must not report that it is safe to close while a readiness authorization or task obligation remains outstanding. Local journal recovery requires the original session key and data.

The pool reservation policy is deliberately conservative: all candidates consume capacity before the draw. With two hosts each declaring one slot, two tasks cannot share those hosts in one round. More declared capacity or disjoint eligible pools are needed to amortize a round across more tasks. The ready roster remains bounded to 32 candidates.

## Costs and rollout

For a round containing N tasks, the VRF request charge is shared across N tasks. Each caller deposits the configured `admissionFeeWei` cap at posting. Once its task terminates, `floor(cap / N)` is credited to the fee recipient and the rest is credited to the caller; any remainder of the division goes to callers. A round with one task charges the entire cap, so permissionless sealing of single-task rounds cannot drain the subscription at a fraction of its request cost. A task that expires before the VRF request receives its entire cap back. Execution escrow follows the ordinary settlement rules.

The gateway reports the gross cap as `admission_deposit_wei`, the net charge as `admission_fee_wei`, and the credit as `admission_refund_wei`. Its durable lifetime admission budget reconciles the gross reservation to the net charge. If a terminal read fails, startup and the periodic recovery pass re-read finalized on-chain task state and repair any unreconciled budget and receipt. Unreconciled calls are retained even when completed call history is pruned. A failed API response still bills zero usage to its caller; its recovered net admission expense belongs to the gateway. Refunds initially reside in the market's credit ledger. In round mode the gateway withdraws its accumulated native-token credit back to its fee wallet once it reaches `GATEWAY_ROUND_CREDIT_SWEEP_MIN_WEI` (default 0.001 BNB), including after a restart; a failed withdrawal is retried after the next task or restart. Operators should set the threshold above the withdrawal gas cost. The withdrawal is not included in an individual task's gas bill.

Task posting, capacity reservations, allocation, result settlement, credit withdrawal and relayer sponsorship still incur gas. A one-task round provides no request-count saving. At the tested worst bound (32 candidates with 63 prior leases), token admission is about 15.05M gas; maximum-size rounds should not be assumed economical. The tested linked market runtime is 24,447 bytes, 129 bytes below the EIP-170 limit; contract changes must keep the code-size regression passing. The separate `RoundFeeAccounting` library must be deployed and linked before the market.

Set the per-round admission cap from a fresh measured VRF charge plus a safety margin. The recorded BSC testnet acceptance run on 2026-09-22 charged 237,182,400,000,000 wei for one callback; this is a historical sample, not a current price guarantee. The existing v2 cap of 1,000,000,000,000,000 wei is not automatically changed. Do not assume batch occupancy: the default browser host advertises one slot, and two tasks using the same two hosts require each host to opt into at least two slots. Measure total request and transaction cost with the chosen round size before enabling paid traffic.

At the current Render example of 100 steps, two hosts, a model/stimulus factor of 1 and 100,000,000,000 wei per step, total host reward is 20,000,000,000,000 wei (0.00002 BNB) per task. The historical VRF charge alone needs at least 12 tasks to fall below that reward per task. With a hypothetical 300,000,000,000,000 wei cap, 16 tasks would pay 18,750,000,000,000 wei each; the existing 1,000,000,000,000,000 wei cap would still charge 62,500,000,000,000 wei each. These calculations exclude per-task transaction and sweep gas. The eight-task schema example below demonstrates behavior, **not** an economical rollout target. Low demand or insufficient host slots still produces costly single-task rounds.

Deployment configuration uses:

```json
{
  "protocol": "synchronous-vrf-rounds-v1",
  "rounds": { "roundBlocks": 20, "maxRoundTasks": 8 }
}
```

These numbers illustrate the schema, not production timing recommendations. Choose windows for the target chain, confirmation policy and workload. Use the existing VRF subscription deployment flow with a fresh configuration-bound journal. It deploys the version-3 market/controller and authorizes the controller for capacity and bond holds. Inventory tooling accepts version 3 explicitly. Relayer, gateway and browser must all publish/use the matching capability.

No live addresses or Render configuration are changed by this implementation. A rollout requires deploying and enrolling the new consumer, checking subscription balance, running a real shared-round callback, and migrating bound integrations before switching services. Existing immutable collection or budget bindings must be inspected; changing a mode string alone is insufficient.

The battery worker continues to reject both VRF modes until battery budgets explicitly escrow admission fees. This is not a completed battery-budget migration.

## Verification

`npm run test:vrf:rounds` covers round service and browser unit tests, bounded contract tests, shared-round pricing and refunds, gateway restart/settlement/credit-sweep integration, local subscription deployment, founder inventory compatibility and a frontend build. It uses local Anvil/mock VRF; it does not certify a live callback or deploy production services.
