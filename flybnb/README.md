# flybnb/ — the pilot's code, results and dataset export

FlyBnB is a whole-brain perturbation atlas of the fly, re-tested across individuals, in which every row can be recomputed bit for bit. The [proposal](../docs/flybnb/proposal.md) says what it is and why; the [paper](../docs/flybnb/paper.md) is a living draft. This directory is everything needed to reproduce the pilot and to build the dataset from it.

| here | what |
|---|---|
| `analysis/phenotype_variance.py` | the pilot: founders × stimulus seeds × stimuli, under a sparse int-lif runner. `--verify` checks the runner against the published reference digests first |
| `analysis/phenotype_variance_report.py` | variance components and intraclass correlations → `results/pilot/variance.{json,md}` |
| `analysis/groups_flywire783.json` | payload indices of the stimulus sets and readout groups (Johnston's organ A/B per side, the two gate neurons, DNge145, DNp12, the giant fibre, the 38 phase-locked cells) and the four direct gate connections |
| `results/pilot/runs.jsonl` | one line per individual: its recipe, its model id, how its wiring differs from the base, and every run with its digest and readouts (101 individuals, 2,020 runs) |
| `results/pilot/variance.{json,md}` | the analysis the paper's pilot section is generated from (`docs/flybnb/results/variance.json` is a copy) |
| `dataset/README.md`, `dataset/build_dataset.py` | the Hugging Face dataset card and the export (parquet). Uploading is a separate, deliberate step and nothing here does it |

## Reproducing the pilot

Python 3 with numpy (pandas and pyarrow for the dataset export, scipy optionally for p-values), and this repository's `contracts/lib/aigg-porw` submodule: `gpu/triton/demo/fly_brain/flywire_delta.py` is the individual sampler, and the scripts find it there.

The brains are not in the repository. They are identified by content address, and the scripts refuse a payload that is not the one the pilot used.

| payload | what | bytes | sha256 | `model_id` |
|---|---|---|---|---|
| `flywire-783-min5.bin` | FlyWire v783, connections of ≥ 5 synapses. The published wiring; on Greenfield as `gnfd://aigg-brains/flywire-fafb-v783-min5.bin` | 28,123,136 | `fd246cc2c0ac74e8928cf5b0012c5d4c48a0a03475595213b301f85f5fe4e1da` | `0x9747cc81830375103eae957a93d3800875223c17bdc6399f5783be62a19da93a` |
| `flywire-783-min2.bin` | the same export at ≥ 2 synapses: the base individuals are laid out on, so that connections can cross the threshold of five in both directions; on Greenfield as `gnfd://aigg-brains/flywire-fafb-v783-min2.bin` | 77,074,432 | `10a9e16f08174e4c2421f64d10ee17466d39ff88847ba7ab0c1ef57c1a9022a5` | `0x53a7b48e9265bea68fbd3f3640eda751f8dd7742ac76ae6f9c69f1cddc528135` |

Both are served, public-read, by the Greenfield testnet storage provider `https://gnfd-testnet-sp2.bnbchain.org` (`/view/aigg-brains/<object>`); fetch either and check it before use, as the scripts do:

```bash
curl -O https://gnfd-testnet-sp2.bnbchain.org/view/aigg-brains/flywire-fafb-v783-min2.bin && shasum -a 256 flywire-fafb-v783-min2.bin
```

The min2 object was fetched back on 2026-09-18 and verified: 77,074,432 bytes, the sha256 above, and `model_id` `0x53a7b48e…` recomputed over its tiles (`js/greenfield.js: fetchVerified`). A testnet is not an archive; the content addresses are what identify the brains, wherever the bytes come from.

Both can also be rebuilt from the public FlyWire v783 release through `contracts/lib/aigg-porw/gpu/triton/demo/fly_brain/flywire_export.py`; its README describes the inputs. The payload's name is part of its bytes, so the content address is reproduced only with the same name: `--min-syn 5 --name flywire-fafb-v783-min5` and `--min-syn 2 --name flywire-fafb-v783-min2`.

```bash
python flybnb/analysis/phenotype_variance.py --verify --min5 flywire-783-min5.bin
```

```bash
python flybnb/analysis/phenotype_variance.py --base flywire-783-min2.bin --individuals 100 --seeds 10 --workers 8 --out runs.jsonl --rows-dir rows/
```

```bash
python flybnb/analysis/phenotype_variance_report.py
```

The first reproduces the two published digests (`0x8614eda1…`, `0x017258be…`) in a few seconds each. The second is about 40 minutes on eight cores and is deterministic: a second pass reproduced the first field for field, and every digest in `results/pilot/runs.jsonl` is what you should get. The third rewrites `results/pilot/variance.*` from `results/pilot/runs.jsonl`; it reproduces the committed `variance.json` byte for byte.

## Building the dataset

```bash
python flybnb/dataset/build_dataset.py --base flywire-783-min2.bin --rows-dir rows/
```

writes the Hugging Face layout to `flybnb/dataset/build/` (ignored by git) and checks that every stored spike-count vector hashes to its row's digest. `rows/` is what `--rows-dir` of the pilot wrote: the sparse spike-count vector of every run.

## Updating the paper

```bash
node docs/flybnb/build.mjs --results flybnb/results/pilot/variance.json
```

regenerates the pilot block of `docs/flybnb/paper.md`. Prose is never touched.

## Licence of the data

FlyWire's public release data (v783 included) is under **CC BY-NC 4.0**: "FlyWire's public release data is made available under license CC BY-NC 4.0" (<https://flywire.ai/guidelines>, read 2026-09-18). The results and recipes here are adaptations of that wiring, so they are released under CC BY-NC 4.0 too: share and adapt with attribution, **not for commercial use**. Cite FlyWire as its guidelines ask. The male brain, when it is added, comes under different terms: "The Male CNS is licensed under CC-BY" (4.0; <https://male-cns.janelia.org/download/>), which allows commercial use.

That distinction matters beyond the dataset. Minting an individual of the female brain for a price, or charging a fee for a task against it, is plausibly a commercial use of FlyWire-derived data. This is not legal advice and nobody here has asked FlyWire; it should be asked before either happens on a public network.

This repository has no licence file yet (the contracts carry 0BSD headers); until it has one, the code here has no stated licence.
