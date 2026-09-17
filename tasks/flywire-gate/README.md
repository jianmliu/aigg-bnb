# First task: the fly-brain gate-synapse ablation (from jianmliu/flyaudio, tasks/mesh-first-task)

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
  `initStateRoot` (= the task's `inputCommit`), the six task nonces and expected digests, and the anvil run.
- `*.manifest.json` — the two edited payloads (`ablate4`, `keep4`), derived from `flywire-783-min5.bin`
  (sha256 fd246cc2…1da; `mesh/groups_min5.json` gives the record indices).
- `stimulus_sets.json`, `init_state_roots.json`, `reference_digests.json` — inputs and the reference runner's outputs.
- `wasm_digests.json` — the same six runs through the browser kernel (`sketch.wasm`): all match the reference.
- `e2e_gate_task.mjs`, `e2e_anvil_log.json`, `e2e_anvil_run.log` — the end-to-end run on a local anvil.
- `bench_real_payload.mjs`, `wasm_digests.mjs`, `init_state_roots.mjs`, `assemble_task.py` — the tooling.

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

The MEP ids in `task.json` are network independent (they hash the registry fields only). On BSC testnet, with the
deployer key funded: upload the three payloads to Greenfield (`node js/greenfield_admin.mjs upload aigg-brains
flywire-783-min5.bin <file>` etc. in aigg-bnb), register each MEP (`node js/register_mep.mjs <fields.json>
gnfd://aigg-brains/<name>.bin`, fields = the `mep` block of `task.json`), have the relayer serve the three MEP ids,
and post the six tasks with `TaskMarket.postTask({mepId, stimulusSeed: 7, inputCommit, fee, deadline, redundancy: 2},
nonce)` using the nonces and `inputCommit`s in `task.json`; the client then sends `task-announce {taskId,
stimulusSeed: 7, stimulusIds}` to the chosen executors over the relay. A settled task whose digest equals
`expectedExecDigest` is a third-party replication of that row of the table.
