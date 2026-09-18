# First task: the fly-brain gate-synapse ablation (source: jianmliu/flyaudio, tasks/mesh-first-task)

The DREGONFLY gate experiment (docs-jo-audio-mapping.md §26o, outline E4) published as verifiable tasks for the
aigg mesh (jianmliu/aigg-porw + jianmliu/aigg-bnb). One task = one whole-brain run of the FlyWire v783 female
connectome (139,255 neurons, ≥5-synapse connections, 2,700,513 records) under `aigg:exec:int-lif:v1` for 5000 steps
(0.5 s of brain time), redundantly executed by bonded browser-style instances and settled on chain by digest agreement.

**Claim encoded by the six digests** (`task.json`): with both ears' JO cells driven, adding the two AN_multi_8 gate
cells silences DNge145 (2.8 → 0.0 spikes / 100 ms); deleting only the four direct gate→DNge145 records abolishes the
silencing (3.6); keeping only those four records preserves it (0.0). Without the gate drive all three models give
the *same* digest (the removed records never carry a spike), which is the built-in control.

| # | model (MEP) | stimulus set | execDigest | DNge145 (last 250 ms, per 100 ms) |
|---|---|---|---|---|
| 1 | flywire-783-min5 (full) | joLR (359 ids) | 0x8614eda1… | 2.8 |
| 2 | flywire-783-min5 (full) | joLR+gate (361) | 0x017258be… | **0.0** |
| 3 | …-ablate4 (4 direct records removed) | joLR | 0x8614eda1… | 2.8 |
| 4 | …-ablate4 | joLR+gate | 0x9a06ec1e… | **3.6** |
| 5 | …-keep4 (only the 4 direct records kept) | joLR | 0x8614eda1… | 2.8 |
| 6 | …-keep4 | joLR+gate | 0xd96bc436… | **0.0** |

## Files

- `task.json` — the publication record: three payloads (sha256, FLYBRAINv2 sizes), their MEP fields (modelId,
  synapseRoot, execKind, steps 5000, commit stride 500, mepId), the two stimulus sets (payload indices) with their
  `initStateRoot` (the task's field of that name), the six task nonces and expected digests, and the anvil run.
- `*.delta` + `*.delta.manifest.json` — the two edited models as **FLYDELTAv1 deltas** of the base (169 B and
  4.7 KB; aigg-porw `delta.js` / `flywire_delta.py`): applying them to `flywire-783-min5.bin` reproduces
  `ablate4` / `keep4` byte for byte, with the model ids in `task.json`. `*.manifest.json` describe the applied payloads.
- `stimulus_sets.json`, `init_state_roots.json`, `reference_digests.json` — inputs and the reference runner's outputs.
- `wasm_digests.json` — the same six runs through the browser kernel (`sketch.wasm`): all match the reference.
- `e2e_gate_task.mjs`, `e2e_anvil_log.json`, `e2e_anvil_run.log` — the end-to-end run on a local anvil under this checkout's scheme (v2).
- `post_tasks.mjs` — posts the tasks of `task.json` on any deployed mesh and drives them to settlement (executor
  session keys resolved from the instance registry's `SessionKeySet` logs); the anvil run goes through it too.
- `fields/<model>.v1.json`, `fields/<model>.v2.json` — the MEP fields per scheme (`js/register_mep.mjs` input).
- `recompute_ids.mjs` — recomputes every scheme-dependent id from the real base payload with an aigg-porw checkout
  (`--porw dir`, default this repo's submodule) and keeps them per scheme in `task.json` (`models[*].mepByScheme`,
  `tasks[*].taskIdByScheme`); `--check` exits 1 when stale. The `mep` block of each model is the v1 profile the
  tools in this folder still use.
- `build_variants.py`, `bench_real_payload.mjs`, `wasm_digests.mjs`, `init_state_roots.mjs`, `assemble_task.py` — the tooling.

## Reproduce

Reference digests (numpy runner `mesh/int_lif_fast.py`, bit-exact with the wasm kernel; ~75 s per run on one core):
decode the payload, run seed 7 for 5000 steps on a stimulus set from `stimulus_sets.json`, and hash
`LE32 neurons || LE32 counts` with keccak-256; `joLR+gate` on the full model gives 0x017258be….

Browser kernel (Node, ~11 s per run) and the anvil end to end (~5 min; needs Foundry, `npm install` in the aigg-bnb
checkout and in `contracts/lib/aigg-porw/web/porw-browser`, and the forge-std submodule):

```bash
PORW_DIR=/path/to/aigg-bnb/contracts/lib/aigg-porw/web/porw-browser node <flyaudio>/tasks/mesh-first-task/wasm_digests.mjs
```

```bash
FOUNDRY_BIN=$HOME/.foundry/bin AIGG_BNB=/path/to/aigg-bnb node <flyaudio>/tasks/mesh-first-task/e2e_gate_task.mjs
```

## Publishing on a public network

The MEP ids in `task.json` are network independent (they hash the registry fields only). The aigg-bnb BSC testnet
deployment (chain 97, 2026-09-17) already serves the full payload from Greenfield
(`gnfd://aigg-brains/flywire-fafb-v783-min5.bin`, same model_id 0x9747cc81…), but under a 100-step / stride-10 MEP;
this task needs the 5000-step / stride-500 MEPs below, registered by a funded deployer key:

1. `node js/register_mep.mjs <flyaudio>/tasks/mesh-first-task/fields/flywire-783-min5.json gnfd://aigg-brains/flywire-fafb-v783-min5.bin https://gnfd-testnet-sp2.bnbchain.org`
   (no upload needed: the pointer already serves these bytes);
2. the two edited models need no 28 MB uploads: publish `flywire-783-min5-ablate4.delta` and `…-keep4.delta` (a few
   KB) and register their field files; a node holding the base applies the delta (`PorwNode.loadDelta`) and gets the
   registered model id (`flywire_delta.py apply` reproduces the payload for anyone who wants the bytes);
3. add the three MEP ids to the relayer's `PORW_MEP_IDS`; instances bond on them and claim for an epoch;
4. `AIGG_BNB=/path/to/aigg-bnb node <flyaudio>/tasks/mesh-first-task/post_tasks.mjs --env /path/to/.env.bsc-testnet --relayer http://<relayer>:8788 --fee 0.001`
   posts the six tasks (nonces and `initStateRoot`s from `task.json`), announces them with the stimulus ids to the
   sortitioned executors over the relay, waits for the sponsored results, settles, and writes `posted-97.json`.

A settled task whose digest equals `expectedExecDigest` is a third-party replication of that row of the table.

## Schemes

| | `sketch-tile-keccak:v1` | `:v2` | `:v3` (this repo's submodule) |
|---|---|---|---|
| mep_id | keccak(scheme, modelId, execKind, steps, stride) | keccak(scheme, modelId, execKind, neurons, synapses, synapseRoot) | as v2 |
| the Claim | with `execDigest`, `stimulusSeed`, `deviceId` | residency only, with `deviceId` | residency only; the sketch seed is the claiming instance's |
| full | 0x1569abaa… | 0x29d28a93… | 0x312dda12… |
| ablate4 | 0xb831be52… | 0x365bec00… | 0x37d237e3… |
| keep4 | 0x08aa989d… | 0xd3b6a4b1… | 0x62e321e1… |
| steps 5000, stride 500 | in the MEP | on the Task (and in the `task-announce`) | on the Task |
| taskId | keccak(mepId, seed, nonce) | keccak(abi.encode(Task, nonce)): exists only at post time | as v2 |
| residency claims, 3 brains x 2 executors | ~70 s (six 5000-step runs) | 0.11 s | 0.11 s |

`modelId`, `synapseRoot`, `execKind`, and every `execDigest`, `execRoot` and `initStateRoot` are the same under all three:
only the scheme digest inside `mep_id` moves. `fields/<model>.v1|v2|v3.json` are the registration inputs per scheme, and
`post_tasks.mjs` picks the profile of the scheme of the checkout it runs against.

## End to end under the checkout's scheme (`e2e_gate_task.mjs`, record in `e2e_anvil_log.json` / `e2e_anvil_run.log`)

```bash
FOUNDRY_BIN=$HOME/.foundry/bin node tasks/flywire-gate/e2e_gate_task.mjs /path/to/flywire-783-min5.bin
```

Only the base payload is needed: the two edited brains are rebuilt from their deltas, and the registered MEP ids are
checked against the v2 ids in `task.json`. The six tasks go through `post_tasks.mjs` with `steps` and `commitStride`
on the Task. All six settle with the expected digests. Two things the run records about the guarded relayer:

- **Sponsorship budget.** With one root per epoch and one-word claims, a materialization costs ~92k gas as a sponsored
  transaction (was ~285k), so the default 1,500,000 gas per instance per epoch covers the three materializations and
  all six `submitResult`s: 12 of 12 results sponsored. Before that change the same run had 4 of 12 refused (429) and
  paid by the executors themselves; the run keeps that fallback and records how many were needed.
- **Settle.** The relayer sponsors `settle` only out of an executor's budget, so `post_tasks.mjs` has the client that
  posted the task settle it (permissionless on chain, paid by the party that wants the result).
