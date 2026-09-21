# Browser family hosting

A host chooses a base model family, loads its base once, bonds to its enrollment pool and makes residency claims for that base. Assigned descendants are reconstructed from delta recipes on demand. The task and payout still belong to the exact descendant MEP and its royalty/payment terms.

## Activation

Use matching contracts with `InstanceRegistry.mepRegistry` configured before the first bond. The relayer exposes `familyHosting` only when that registry matches the configured MEP registry. This does not migrate existing contracts or collections. Restart the relayer after initial configuration. Legacy deployments keep individual MEP hosting.

Pin a root explicitly in `PORW_MEP_IDS` to sponsor results for its future descendants. Roots loaded only as dependencies of whitelisted children do not expand sponsorship beyond that whitelist; existing client restrictions and gas budgets still apply.

Publish descendants as derived MEPs against their root. Publish FLYDELTAv3 in-place recipes, with each parent recipe available as `<0xdeltaHash>.delta` in the same directory as the child. HTTP(S) and configured Greenfield mirrors/providers are supported. Parent recipe IDs are content hashes, not MEP IDs.

## Task path

1. The browser checks the task and executor list directly on the configured chain at one block, including expiry, submitted/settled/disputed status, parameters and enrollment route.
2. It fetches only the delta graph. A new child need not appear in the startup catalog.
3. The worker checks every parent hash and family constraint, reconstructs from the resident base and verifies the exact resulting model and MEP identity.
4. A temporary node executes the task. The base remains resident; child allocations are released after execution.
5. Recipe graph, immutable task manifest and signed result are stored atomically in IndexedDB before delivery. The existing relayer submits the result. Native and token tasks follow the configured market's task identity and executor snapshot.

Invalid, unassigned or out-of-family requests fail before recipe download. Invalid reconstruction fails before signing/delivery. One browser task executes at a time; identical requests coalesce, competing requests are refused. A lost response can be served from the journal without another execution.

## Current bounds

- At most 8 ancestor recipes, depth 8, 64 KiB per downloaded recipe and 512 KiB total graph. The graph's byte limit may reduce the maximum ancestor count for unusually large recipes.
- One page resolver admission at a time, with a 45-second total download deadline and 15-second per-fetch deadline. Slow RPC operations keep that admission occupied until they finish.
- Up to 64 runs per batch. Tasks must fit the host's chosen step capacity. These browser-specific limits are not currently advertised to on-chain sortition; task producers must respect them for this host class.
- A conservative 2 GiB derivation/execution budget is reserved in addition to resident base estimates, within the browser's configured total memory budget. This is a software estimate, not proof of available physical RAM. Excessive ancestry or step counts fail closed.
- Replay journal: 32 records and 32 MiB per chain/market/instance namespace, with no automatic eviction. A full/unavailable journal refuses new results before delivery. Production continuous operation needs retention and archival management before these limits are reached.

## Replay and disputes

The Host activity panel offers **Verify replay** for recently completed tasks. Replay reconstructs from the stored manifest and recipes against the loaded base, compares execution commitments, and retains the original signature even after session-key rotation. Reloading the browser preserves IndexedDB records; the same base must be loaded again. The controller's `replayFamilyTask(taskId)` also permits replay by known task ID after reload.

The journal does not store full base payloads. Operators must preserve access to their verified base and browser storage. Do not clear site data while results remain challengeable. No automatic on-chain dispute responder or safe journal pruning policy is added here. A settled result is not treated as permission to delete evidence.

## Verification

`npm run test:family` covers resolver admission, bounded recipe graphs, actual-WASM family execution, persistent Chrome IndexedDB and the browser/Anvil path for a child registered after host startup. `node test/frontend_memory.mjs` checks combined resident and temporary memory budgets. Existing legacy browser-host tests remain applicable.
