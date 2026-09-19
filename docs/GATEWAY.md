# The gateway: a brain behind an inference API

Status: design, 2026-09-19. Nothing here is built. Where a statement is about code that exists it names the file;
where it is a proposal it says so. §8 records what was decided on 2026-09-19, and what is still open.

## 0. The analogy, and where it stops

ai.gg is an API gateway (`jianmliu/aigg-src`, a fork of sub2api): a user holds a platform key and a balance, names a
model, and the gateway finds somebody to serve the call and bills the tokens. This document puts the fly-brain mesh
behind that same door. Read as an inference platform, the mesh already has every part:

| an inference platform | this mesh | where |
|---|---|---|
| the router / aggregator | the gateway: the one on-chain task client | this document |
| a model | a MEP — a base brain, or any registered fly | `MEPRegistry`, the relayer's `/meps` |
| a model provider | **a browser tab**: a bonded instance hosting the brain | `InstanceRegistry` |
| onboarding, a provider's deposit | the bond, `joinMep` | `bond`, `bondFor` |
| the health check "is the model really loaded?" | the PoRW claim, every epoch — a proof, not a self-report | `PoRWClaimManager` |
| routing, load balancing | sortition: stake-weighted and random. **The caller does not choose** | `TaskMarket._draw` |
| the provider's revenue | its share of the task's fee, paid at settlement | `TaskMarket._pay` |
| the model author's licence fee | the MEP's terms: a share of every fee, to the owner of the fly | `termsOf`, `FlyCollection.settle` |
| auditing a provider | redundancy, bisection disputes, slashing | `ExecutionDisputes` |

Two differences are structural, and both are the point rather than a defect.

**A provider has no endpoint.** A tab cannot be called; it listens on a relay. A request becomes an on-chain task, the
chain draws the executors, and the client announces the task to exactly those tabs. Nobody can aim a request at a
provider, so nobody can arrange for a friendly one to answer it.

**The answer can be checked.** An ordinary platform trusts that a provider ran the model it says it ran. Here the
computation is deterministic, so the same request goes to *N* providers who do not know each other and the results are
compared bit for bit; a wrong one loses a bond. Every response can therefore carry a receipt. "Verifiable inference"
is the one thing this model family offers that no other model on the gateway does, and the API should expose it
rather than hide it.

The same repository already contains the off-chain version of this idea: p2papi's endpoint marketplace, where a user
locks a platform deposit to list an upstream subscription and earns from other users' calls, with a TEE standing in
for trust (`aigg-src: provider_deposit_service.go`, `p2papi_runtime_service.go`). The mesh is that marketplace with the
deposit on a chain, the slashing automatic instead of an admin's decision, and determinism plus redundancy where
p2papi needs an attested enclave.

## 1. What a request is

The chain's task (`aigg-porw: PorwMesh.sol`):

```solidity
struct Task { bytes32 mepId; uint32 stimulusSeed; uint32 steps; uint32 commitStride;
              bytes32 initStateRoot; uint256 fee; uint64 deadline; uint8 redundancy; }
```

| the API call | the task |
|---|---|
| `model` | `mepId`: `flywire-783-min5`, `flywire-783-min2`, `fly-<collection>-<token>`, or a raw `mep:0x…` |
| `seed` | `stimulusSeed` (both are a uint32) |
| `max_output_tokens` | `steps`. **One step is one token** |
| `n` | `runs` of `postBatch` (int-lif only, 2 … 65,536): one fee, one settlement |
| `input` | the experiment, as JSON: which neurons are stimulated, which are silenced, what to read out (§1.1) |
| `stream: true` | progress events, and the keep-alive that carries a minutes-long call through a proxy |
| the response `id` | `taskId` |
| `system_fingerprint` | the scheme digest and the exec kind: what "the same model" means here |
| `usage.output_tokens` | `steps × runs` |

`commitStride` is the gateway's to choose (int-lif: at most 512 segments and a stride of at most 512, so up to 262,144
steps — `TaskMarket._post`). `deadline` is hashed into the task id and **checked nowhere on-chain**; the clock that
matters is `TASK_TIMEOUT` from the block the task was posted in. `redundancy` is a policy of the gateway (§3).

### 1.1 The prompt is an experiment

Which neurons are stimulated and which are silenced is not in the `Task`. It is in `state_0`, whose Merkle root is
`initStateRoot` (`LifRowCheck`: flags bit 0 stimulated, bit 2 silenced; silence wins). The id lists travel off-chain in
the announcement, and an executor that builds a different `state_0` from them refuses to sign
(`node_service.js`: `result-refused`). So a request body is:

```json
{ "model": "flywire-783-min5", "seed": 7, "max_output_tokens": 5000,
  "input": { "stimulate": {"set": "joLR"}, "silence": {"cell_type": "DNa02"}, "readout": {"ids": [91022, 91023]} } }
```

`stimulate` and `silence` take a named set, a cell type, or explicit payload indices. Named sets and cell types are
resolved by the gateway from tables published with the brain (`tasks/flywire-gate/stimulus_sets.json` today; the
FlyBnB atlas's cell-type table for the rest), and the resolved id lists are echoed in the response so the call can be
repeated by anybody without the gateway. With neither, the canonical set derived from the seed is used.

### 1.2 What comes back, and a gap that is smaller than it looks

Today an executor returns `{taskId, execDigest, execRoot, signature}` and nothing a person can read. But for int-lif
`execDigest = keccak(LE32 n ‖ counts[n])`: the digest **is** the hash of every neuron's spike count
(`aigg-porw: web/porw-browser/lif.js`). The counts are computed in `PorwNode._runLif` and dropped by `_execute`.

So the output needs no new proof system. **Proposal (an aigg-porw change):** an announcement may ask for `counts`; the
executor returns them with its result (139,255 × 4 bytes ≈ 557 KB); the gateway checks
`keccak(n ‖ counts) == settledDigest(taskId)` and answers from them. The response carries the readout the caller asked
for as rates, the digest, and a way to fetch the full vector:

```json
{ "id": "0x9c…", "object": "response", "model": "flywire-783-min5", "status": "completed",
  "output": [{ "type": "message", "role": "assistant", "content": [{ "type": "output_text",
     "text": "{\"readout\":[{\"id\":91022,\"spikes\":41,\"hz\":82.0},{\"id\":91023,\"spikes\":0,\"hz\":0.0}]}" }] }],
  "usage": { "input_tokens": 0, "output_tokens": 5000 },
  "receipt": { "chain": 97, "market": "0x7112…", "task": "0x9c…", "post_tx": "0x…", "settle_tx": "0x…",
               "executors": ["0x…", "0x…"], "exec_digest": "0x…", "exec_root": "0x…",
               "finality": "settled", "final_after_block": 131890400,
               "stimulate_ids_sha256": "…", "silence_ids_sha256": "…", "counts_url": "/v1/tasks/0x9c…/counts" } }
```

One caveat is stated in the receipt rather than hidden. The chain's agreement is on `execRoot`; `settledDigest` is the
digest a strict majority of the paid executors gave, and nothing on-chain ties a digest to a root
(`TaskMarket._same`). At `redundancy` 1 the counts are one bonded executor's word. At 2 or more with equal digests
they are what independent providers agreed on. A per-neuron opening against `execRoot` exists for the day that is not
enough (`PorwNode.lifOpenState`): the last committed state carries the cumulative count.

Until the upstream change lands, **v0** returns the receipt alone and, for the project's own use, counts recomputed by
the gateway (~11 s per 5,000-step run in Node).

## 2. The life of a call

The relayer has no task queue and no `/tasks` route: delivery is client to executor, over the relay. The gateway is
therefore `tasks/flywire-gate/post_tasks.mjs: runTasks` behind an HTTP handler:

1. resolve `model` and `input`; build `state_0`, take its root.
2. **capacity check** (§3). Refuse here and nothing has been spent.
3. `postTask{value: fee}` from the gateway's wallet; read `executors(taskId)`.
4. find each executor's session key (`SessionKeySet` logs) and send `task-announce` to its relay inbox.
5. the tabs run, sign an EIP-712 `Result` with their session keys, and hand it to the relayer's `/tx/result`, which
   pays the gas. **The relayer sponsors results only for tasks of the clients in `PORW_TASK_CLIENTS`**, so the
   gateway's address goes on that list — and with it there, "third-party tasks are not open" stays true on-chain
   while everybody with an ai.gg key can run an experiment.
6. all submitted, or `TASK_TIMEOUT`: `settle`. Fee split, royalty accrued.
7. fetch and check the counts; answer.

| event on the stream | meaning |
|---|---|
| `response.created` | posted: `taskId`, the executors drawn |
| `response.in_progress` | one per `ResultSubmitted`; and a comment line every 20 s (the gateway in front cuts a stream silent for 180 s) |
| `response.completed` | settled, counts verified, receipt attached |
| `response.failed` | see §3 |

**Latency.** A 5,000-step run is ~11 s in a tab; posting, the results and settlement are each a transaction at ~0.45 s
blocks. Warm, a call is tens of seconds. **Cold is worse, and it is the real limit:** `postTask` requires the current
epoch's beacon, the testnet beacon is lazy, and executors are eligible only with a claim no older than six epochs —
after an idle period the first call waits up to two epochs (200 blocks each). The gateway keeps the network warm while
it has traffic. **Proposal (relayer):** `/wake` accepts a listed task client, not only a bonded host.

**Async.** `background: true` returns `{id, status: "queued"}` at step 3 and `GET /v1/responses/{id}` polls it — the
Responses API's own shape. `aigg-src` has no async path of its own, but it does not need one: it sets no write timeout,
waits 600 s for response headers, and bounds only the gap between stream chunks.

**Finality.** `settled` means the paid executors agreed. For `challengeWindow` blocks afterwards (200 on the testnet)
anybody who did not execute may put up a deposit and a different result; if they win the digest is void
(`ResultRepudiated`) though the fee is not returned. `final_after_block` moves forward on every failed challenge, so
`GET /v1/responses/{id}` re-reads it, and reports `finality: "final" | "repudiated"`.

**Determinism is a cache.** Same model, seed, steps, stimulus and silence is the same result, forever. A repeated call
is answered from the first one's receipt with `usage.input_tokens_details.cached_tokens` set, at a lower price.

## 3. When the network cannot serve

Providers are tabs; they close. And every fly is its own model: an adopter is bonded for the *base* brain
(`FlyCollection.mint` → `bondFor`), so a newly registered fly has no host until somebody joins it. The bytes are cheap
— a fly is its base plus a 231-byte recipe, and a host of the base already has the base — but a second resident brain
is a second brain's worth of a tab's memory, which is the binding constraint (docs/TOKENOMICS.md §5). A cold model is
the normal case, not the exception.

| situation | how the gateway knows | answer |
|---|---|---|
| fewer eligible hosts than the redundancy it requires | `eligibleVotes(mepId, epoch)` — the only view of eligible weight | `503 model_cold`, `Retry-After`; nothing posted |
| the epoch has no beacon yet | `claimManager.beacon(epoch) == 0` | wake, hold the stream; `503` past a bound |
| no executor ever answers | `settle` after `TASK_TIMEOUT` refunds the whole fee to the client | `504`, not billed |
| some answer, and agree | they are paid; there is no partial refund | normal response; `receipt.executors` is shorter |
| they disagree | `DisputeOpened` | `response.failed: disputed`; the user is not billed; the gateway's fee is locked until the dispute resolves, and **a dispute where both sides go silent never resolves** — a cost of being the client, to be budgeted |

`TaskMarket` silently draws *fewer* executors than asked when too few are eligible, so the gateway's floor
(`min_redundancy`, default 2) is enforced in step 2, not by the chain. `GET /v1/models` lists every served MEP with
`providers` (eligible instances), `votes`, `royalty_bps` and the owner's collection, and marks a model `available`
only above the floor.

## 4. Money

```
user ──(platform balance: USD or GCC)──▶ ai.gg ──(the gateway's BNB)──▶ TaskMarket.postTask{fee}
                                                                          ├─ royalty = fee × bps  → the MEP's beneficiary
                                                                          │     (FlyCollection → whoever owns the fly now)
                                                                          └─ the rest, equally   → the executors that agreed
```

Providers and owners are paid on-chain, by the contracts that exist, in the transaction that settles the task. The
gateway pays nobody and keeps no ledger of what it owes: it sells balance and spends BNB, and its margin is the
difference. That is also why none of `aigg-src`'s payout machinery (`provider_owner_user_id`, the withdrawal queue) is
needed here.

**Price.** `fee = steps × runs × redundancy × p(model)`, with `p` wei per step. In `aigg-src` it is a row per model in
the channel pricing table — the resolver already puts channel prices ahead of every other source — in token mode with
the output price set to `p` converted at the gateway's BNB rate, plus its margin. No code change.
`billing_mode = "per_request"` exists too, for fixed-length products such as "one atlas row".

**Who pays is a separate question from who is paid.** Three payers, and they compose:

1. *the user*, from their balance: the default.
2. *the model's vendor*, as a subsidy. A lab that publishes a brain, or a collection that wants its flies used, funds
   calls to its models. `aigg-src` has the pieces — a rate multiplier of 0 makes a group's calls free, channel pricing
   is a per-model discount, `platform_credit_ledger` already records "the platform paid instead of the user" — but no
   notion of a *third party's* budget. **Proposal (aigg-src):** a `model_subsidies` row — model pattern, sponsor's user
   id, share covered in bps, a budget and a daily cap — debited in the same billing transaction as the user's share.
   The providers and the owner are paid in full either way; a subsidy changes who is charged, never what is earned.
3. *the project*, for the FlyBnB atlas: the dataset's own tasks, which is every task today.

### 4.1 Base models and their descendants

The shape generalises beyond flies, and it is the commercial argument. An open-weights vendor publishes a base; the
world makes variants of it; each variant is a MEP — a delta on the base, content-addressed, with an owner. Usage of a
variant pays its owner through the MEP's terms. What the base's vendor gets from a descendant's usage is the part that
is **not built**:

- a MEP's terms name one beneficiary and one rate. `FlyCollection` is that beneficiary for its flies and forwards the
  whole royalty to the token's owner; the collection's treasury sees mint and breed fees and nothing from usage.
- `LineageRegistry` records, for a derived brain, its base and its two parents (`baseModelId`, `parentA`, `parentB`),
  under a bond and a challenge window: the ancestry a split would be computed from is on-chain and accountable. The
  testnet collection was deployed without it (`LINEAGE = 0`).

**Proposal (FlyCollection, before mainnet — the collection is immutable):** the forwarded royalty is split once, in
`_settle`: `BASE_SHARE_BPS` of it to the base's vendor, the rest to the owner. One level, fixed at deployment, no
recursion — a chain of cuts up a pedigree is a tax that grows with every generation, and it would make a bred fly worth
less than a founder. **Decided: `BASE_SHARE_BPS = 1000`, and until a base has a vendor of its own the vendor is the
collection's `TREASURY`.** Stated plainly in the terms the page shows: *of every fee, 10% is the royalty; of the
royalty, 10% is the base's and 90% the owner's* — on a fee of 1, the hosts share 0.90, the owner gets 0.09 and the
base 0.01. The recipient is a constructor argument (`BASE_VENDOR`, defaulting to `TREASURY`), not a constant: FlyWire's
vendor is the treasury for now, another base's need not be. This belongs in the same revision as ERC-2981, `owner()`
and `tokenURI`.

So a vendor has two levers on the same model family: **collect** (its share of every descendant's royalty) and
**subsidise** (pay for calls to grow usage). Both are visible, and the second can be funded by the first.

## 5. Where it attaches to `aigg-src`

**Now — no gateway code change.** The adapter is a service of its own (§6) registered as an account with
`platform = openai`, `type = apikey`, `credentials.base_url` = the adapter. Three facts from the code decide its shape:

- the OpenAI path normalises everything to the **Responses API**: `/v1/chat/completions` from a user is converted and
  forwarded as `POST /v1/responses` (`openai_gateway_chat_completions.go`). The adapter implements `/v1/responses`
  first; chat-completions users are served by the conversion.
- usage is read as `input_tokens` / `output_tokens` from the final frame, and a stream is billed once, at its end.
- `GET /v1/models` is the union of the accounts' `model_mapping` keys, so the mapping is what publishes the models —
  the adapter syncs it from `/meps` through the admin API.

**Later — a `PlatformMEP`.** `GatewayService.Forward` is already a switch on the platform with a pluggable forwarder
(p2papi's). A MEP forwarder beside it gets `/v1/models` with live `providers`, the 503 semantics, the receipt as a
first-class field, and the subsidy debit, without the fiction of being an OpenAI account. About the size of
`p2papi_runtime_service.go`.

The adapter's key is a platform-owned wallet, not a user's secret, so it does not have to live in the TEE, and
(decided) it does not: it is an environment secret of the adapter, like the relayer's. What bounds the damage of a
leaked key is that the wallet is a float, topped up from a treasury that is not online, never the treasury itself.

## 6. The adapter

A Node service in this repository, `gateway/`, beside `relayer/` and sharing its chain client and ABIs. It is *not*
part of the relayer: it holds money, and the relayer's key should never have to.

| route | |
|---|---|
| `POST /v1/responses` | §1, §2; `stream`, `background` |
| `GET /v1/responses/{id}` | status, receipt, current finality |
| `GET /v1/models` | served MEPs with `providers`, `votes`, `available`, `royalty_bps`, `price_per_step` |
| `GET /v1/tasks/{id}/counts` | the verified count vector, binary |
| `POST /v1/chat/completions` | a thin alias, for callers that reach the adapter directly |

Environment: `GATEWAY_KEY` (secret; the fee wallet), `GATEWAY_BEARER` (secret; what `aigg-src` presents),
`PORW_RELAYER_URL`, `GATEWAY_MIN_REDUNDANCY`, `GATEWAY_PRICE_*`. State: one table of calls keyed by `taskId` — a call
must survive a restart between `postTask` and `settle`, because the fee is already spent.

It is tested the way the rest is: an anvil mesh, two headless tabs hosting a synthetic brain, a request in, a receipt
out whose digest the test recomputes; then the failure rows of §3, one by one.

## 7. Order of work

| | | repo |
|---|---|---|
| M0 | the adapter, receipt-only responses, capacity check, refunds; the gateway's address in `PORW_TASK_CLIENTS` | aigg-bnb |
| M1 | `counts` in the announcement and the result; verified readouts | aigg-porw, aigg-bnb |
| M2 | registered in `aigg-src` as an OpenAI-compatible account with channel pricing; model-mapping sync | aigg-src (config only) |
| M3 | wake by task client; `providers` in `/meps`; the Host view as a provider's dashboard (requests served, earned, models online) | aigg-bnb |
| M4 | `model_subsidies` | aigg-src |
| M5 | `BASE_SHARE_BPS`, with ERC-2981 / `owner()` / `tokenURI`, in the mainnet collection | aigg-bnb |
| M6 | `PlatformMEP` | aigg-src |

## 8. Decided, open, and to verify

Decided, 2026-09-19:

- **`min_redundancy` defaults to 2** — the first value at which a result is something two providers agreed on. A
  model with fewer than two eligible hosts is `503 model_cold` (§3); a caller may ask for more, never for less.
- **The fee wallet is not in the TEE** (§5).
- **`BASE_SHARE_BPS = 1000`** — 10% of the royalty, which at a 10% royalty is 1% of the fee — **to the collection's
  treasury** until a base has a vendor of its own (§4.1).

Open:

- **`p(model)`, the price of a step.** The testnet's working number is what `post_tasks.mjs` already pays: 0.001 tBNB
  for 5,000 steps at redundancy 2, i.e. 0.1 gwei per step per executor. The mainnet number wants a measurement first:
  what a host's tab costs to keep a brain resident, against how often sortition draws it.

To verify:

- that a production `aigg-src` deployment keeps `security.url_allowlist` off or lists the adapter's host, and that
  nothing in front of it (nginx, Cloudflare) cuts a stream shorter than the 180 s the gateway allows.
