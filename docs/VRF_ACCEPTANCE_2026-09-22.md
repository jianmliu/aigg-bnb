# Real VRF acceptance on BSC testnet — 2026-09-22

The staged VRF market received an actual Chainlink v2.5 callback for a paid task. Three temporary hosts were locked before the request; two were selected, independently ran the local WASM implementation, and submitted matching commitments/results. This is a direct on-chain integration run with test hosts under one operator, not evidence of operator independence or browser/gateway cutover.

- Market: `0x15380e14f63a6188196ee98e05ff951b66582152`
- Consumer: `0x311B256d75F3B37fAc0F49158D8f40517094Ac18`
- Task: `0xdae53ab189788391eaf346955cd6c1d2152de76704f36545d95dd102460c845a`
- [Task request](https://testnet.bscscan.com/tx/0x901bfa6dd6f4149f4034ee5c3f5d1e1f68a6c7481256ffb0a4d521218c47fa66)
- [Actual callback](https://testnet.bscscan.com/tx/0xec0a581ad6f7258865008ed15a4c6ff5af3ae78d9d881957e12fd9334132f04c)
- [Allocation](https://testnet.bscscan.com/tx/0x854fb34705f9b7c3082046a93263a14b6af517513e791e64b63c2100bf1fe869)
- [Completion](https://testnet.bscscan.com/tx/0x02bed818ec2aa985cf934a8e0b9478f74c876fd88436a9291a17a693cdea91ce)

The exact certified female FlyWire min5 base has 139,255 neurons and 2,700,513 synapses. Hosts built real residency claims under a committed/revealed epoch challenge. The task bound its canonical initial state root, seed 7, four simulation steps and stride 1. This small run validates the execution path, not a complete scientific battery or rarity classification.

## Funding observation

The initial 0.01 tBNB subscription remained pending. A further 0.02 tBNB was added to the **same subscription without changing or rerequesting the task**. The callback arrived four blocks after the top-up. This matches Chainlink node behavior: fulfillment simulation checks affordability at the configured maximum gas price, not just the current low transaction price. The on-chain lane maximum was 50 gwei, callback gas 200,000 and native premium 60%.

Actual VRF charge was **0.0002371824 tBNB**; remaining subscription balance was **0.0297628176 tBNB**. Maintain a maximum-price balance buffer; do not interpret the much smaller actual charge as the minimum usable subscription balance. The observed 0.03 tBNB bootstrap worked for this one request and is not a general multi-request funding guarantee.

Execution escrow was 0.001 tBNB, paid in two equal host credits. Admission cost was a separate 0.001 tBNB treasury credit. The subscription pays Chainlink separately; admission revenue does not automatically replenish it.

## Evidence and recovery

The callback came through a batch transaction whose top-level destination was not the coordinator. Verification matched the admission controller's event address, task ID and request ID in receipts from the exact fulfillment block. No mock callback or beacon fallback was used for allocation.

The live harness was resumed from its private signed-transaction journal: once before posting to correct initial-state binding, and during final accounting to include the top-up and avoid rereading pruned historical state. Original task nonce, VRF request and all signed transactions were retained. The public RPC returned `missing trie node` for an old state read; already verified pool snapshots were retained privately at the original observation instead of requiring an archive RPC.

The public [acceptance record](../tasks/live-runs/vrf-acceptance-2026-09-22.json) contains the finalized terminal state, pool, assignments, result roots, subscription accounting and host withdrawal/exit transactions. The [top-up record](../tasks/live-runs/vrf-acceptance-topup-2026-09-22.json) records the additional deposit. Secret keys, salts and raw signed transactions remain outside the repository.

Run harness: `test/live_vrf_acceptance.mjs --broadcast` with owner key and real payload path provided securely via `VRF_SMOKE_OWNER_KEY` / `VRF_SMOKE_PAYLOAD`. Preserve the private journal. Its `--cleanup` path refuses hosts still reserved or held; it does not bypass a live task. Only remove a stale lock after confirming the recorded process is no longer running.

At the time of this acceptance, Render and the active NFT inventory still used the previous market. The subsequent service and inventory migration is tracked in [VRF cutover](VRF_CUTOVER_2026-09-22.md).
