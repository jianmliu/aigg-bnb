# flybnb/ — the pilot's code, results and dataset export

FlyBnB is a whole-brain perturbation atlas of the fly, re-tested across individuals, in which every row can be recomputed bit for bit. The [proposal](../docs/flybnb/proposal.md) says what it is and why; the [paper](../docs/flybnb/paper.md) is a living draft. This directory is everything needed to reproduce the pilot and to build the dataset from it.

| here | what |
|---|---|
| `analysis/phenotype_rank.mjs`, `results/phenotypes/` | **where an individual stands among the founders**, phenotype by phenotype: the reference distribution (89 phenotypes over the hundred founders) and, per individual, what stands out. Keyed by the delta hash its token carries, so the page can show measured standing instead of an invented rarity; a fly with no runs has no entry, which is the answer until its battery is run |
| [`docs/flybnb/CREDIT.md`](../docs/flybnb/CREDIT.md) | **who is named in the dataset, for what, and how it is checked**: the roles, the thresholds, what credit is not (it is neither authorship nor for sale), and the conflict of interest, stated. Written before the paper on purpose |
| `battery/` | **the standard battery every individual gets**: 13 stimuli × 3 seeds, the output of all 1,303 descending neurons; how it is built from the annotations; its form as one batched task. It is what makes the atlas, the association analysis and the selection experiment one dataset |
| `male/` | **the male brain's line** (MaleCNS v1.0): how its counts compare with FlyWire's (`count_scale.py`), which weight unit puts it in the same regime (`unit_scan.py` → 7209), its own variability model (`lr_conditional.py`, `founder_density.py`), and its battery (`build_battery.py` → `battery/battery-male-v1.json`). Results in `results/male/` |
| `analysis/battery_variance_report.py` | how much of a battery phenotype belongs to the individual: ignition rates and single-run ICCs from battery rows, the same script for either brain → `results/variance/` |
| `analysis/intlif.py` | the int-lif runner the battery uses: exact, 0.6 s per run (the reference takes 75 s), silence sets included. `--verify` holds it to the published digests and to the rule as written |
| `analysis/run_battery.py`, `breeding_design.py`, `breeding_report.py` | the breeding pilot: founders, randomly mated offspring and two divergent selection lines in the collection's recipe format; midparent regression, realised heritability, tested correlated responses |
| `results/breeding/` | the design, every run of 301 individuals under the battery (digest and descending-neuron spikes per run), and `heritability.{json,md}` |
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
| `malecns-v1.0-min2.bin` | MaleCNS v1.0 (brain and ventral nerve cord), connections of ≥ 2 synapses: the base male individuals are laid out on, and what the male battery's `population` names; on Greenfield as `gnfd://aigg-brains/malecns-v1.0-min2.bin` | 154,169,344 | `38227caa7f35af4913a85d0f59c473c4b870e5f9373bb4e07e143163e7a571ba` | `0x7a22e8b8a1eae502ea7528be8ed0699b5c31ce5bf6fd2d4e56aedb46bf17394e` |

All three are served, public-read, by the Greenfield testnet storage provider `https://gnfd-testnet-sp2.bnbchain.org` (`/view/aigg-brains/<object>`); fetch either and check it before use, as the scripts do:

```bash
curl -O https://gnfd-testnet-sp2.bnbchain.org/view/aigg-brains/flywire-fafb-v783-min2.bin && shasum -a 256 flywire-fafb-v783-min2.bin
```

The female min2 object was fetched back on 2026-09-18 and verified: 77,074,432 bytes, the sha256 above, and `model_id` `0x53a7b48e…` recomputed over its tiles (`js/greenfield.js: fetchVerified`). The male min2 was uploaded on 2026-09-20 and verified without downloading it, because the bucket's read quota would not cover 154 MB: the object is sealed at 154,169,344 bytes and the seven Reed-Solomon checksums the chain holds are recomputed from the local file segment for segment. A testnet is not an archive; the content addresses are what identify the brains, wherever the bytes come from.

The female ones can also be rebuilt from the public FlyWire v783 release through `contracts/lib/aigg-porw/gpu/triton/demo/fly_brain/flywire_export.py`, the male one from the MaleCNS v1.0 flat-connectome release through `malecns_export.py` (`--min-syn 2 --name malecns-v1.0-min2`); their READMEs describe the inputs. The payload's name is part of its bytes, so the content address is reproduced only with the same name: `--min-syn 5 --name flywire-fafb-v783-min5` and `--min-syn 2 --name flywire-fafb-v783-min2`.

That rebuild was carried out end to end on 2026-09-20, from files downloaded fresh from Zenodo and GitHub with nothing of this project's in the path. Both payloads came back byte-for-byte: the sizes and sha256s in the table above, `model_id` recomputed over the tiles, and both `mep_id`s already registered on BSC testnet against those same `model_id`s (`MEPRegistry.claimBinding` at `0xC779151b…`). The export took 16.8 s for min5 and 14.0 s for min2; the one real cost is the 812.6 MB connections table. The record, with the inputs' own hashes, is `tasks/live-runs/live-gateway-2026-09-20T07-55-00Z.rebuild.json`.

This is what the content addresses are for. Greenfield, the Cloudflare mirror and every host's cache are conveniences: a brain that no one is serving is still recoverable by anyone holding the papers, and a brain served by someone hostile is still checked against the same address. What is *not* covered is the individuals — each founder is a 228-byte delta on min2, and a delta is only as recoverable as wherever it was published.

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

## Reproducing the breeding pilot

```bash
python flybnb/analysis/intlif.py --verify --min5 flywire-783-min5.bin
```

```bash
python flybnb/analysis/run_battery.py --base flywire-783-min2.bin --individuals flybnb/results/breeding/design.json --out rows.jsonl --workers 8
```

```bash
python flybnb/analysis/breeding_report.py --rows rows.jsonl
```

The second is about 100 minutes on eight cores (301 individuals × 39 runs) and deterministic; the committed `results/breeding/rows.jsonl` has every digest. `breeding_design.py` rebuilds `design.json` from the variance pilot's rows: who is crossed with whom is decided by the founders' measured phenotype and fixed seeds, nothing else.

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

**The two FlyWire statements do not agree, and that is worth knowing before asking.** The files the female payload is actually built from, `proofread_connections_783.feather` and `proofread_root_ids_783.npy`, are deposited by the FlyWire Consortium on Zenodo (<https://doi.org/10.5281/zenodo.10676866>) under **CC BY 4.0**, without the NC clause (the record's licence field, read through Zenodo's API on 2026-09-19: `cc-by-4.0`). The website's guidelines say CC BY-NC 4.0 for "public release data". The neuron annotations (`flyconnectome/flywire_annotations`, used here for transmitter signs and for the battery's stimulus rules) state no licence in the repository at all; they are the supplementary data of Schlegel et al. 2024. Until FlyWire says which statement governs, this directory stays with the stricter one.

That distinction matters beyond the dataset. Minting an individual of the female brain for a price, or charging a fee for a task against it, is plausibly a commercial use of FlyWire-derived data. This is not legal advice and nobody here has asked FlyWire; it should be asked before either happens on a public network.

This repository has no licence file yet (the contracts carry 0BSD headers); until it has one, the code here has no stated licence.
