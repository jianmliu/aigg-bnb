---
pretty_name: FlyBnB
license: cc-by-nc-4.0
language: [en]
tags: [neuroscience, connectomics, drosophila, flywire, simulation, reproducibility]
size_categories: [1K<n<10K]
configs:
  - config_name: runs
    data_files: [{split: pilot, path: pilot/runs.parquet}]
  - config_name: individuals
    data_files: [{split: pilot, path: pilot/individuals.parquet}]
  - config_name: neurons
    data_files: [{split: female, path: neurons/flywire-783-female.parquet}]
---

# FlyBnB

A whole-brain perturbation atlas of *Drosophila*, re-tested across individuals, in which every row can be recomputed bit for bit.

**Status: pilot.** This release holds the pilot only: the unperturbed female brain in synthetic individuals under two auditory stimuli. The silencing and activation atlas, the male brain and the other stimuli are planned and are not here. The living paper draft says what exists: <https://github.com/jianmliu/aigg-bnb/blob/main/docs/flybnb/paper.md>.

## What a row is

One row of `runs` is one whole-brain simulation: a brain, an individual, a perturbation, a stimulus, a stimulus seed.

| column | meaning |
|---|---|
| `row_id` | `brain|individual|perturbation|stimulus|seed|steps` |
| `brain`, `base_model_id` | the connectome and the content address (Merkle root of 4 KiB tiles) of the base payload the individual is laid out on |
| `individual`, `individual_delta_id`, `individual_model_id` | 0 is the base wiring itself (the published connectome thresholded at five synapses). Others are founders; `delta_id` is the hash of the recipe, `model_id` the content address of the payload the recipe produces |
| `perturbation` | `none` in the pilot |
| `stimulus`, `seed`, `steps` | the named set of driven sensory neurons (`stimuli.json`), the seed of their spike trains, and the number of 0.1 ms steps |
| `exec_kind` | `aigg:exec:int-lif:v1`, the integer simulator the digest is defined under |
| `digest` | Keccak-256 of `LE32(neurons) || LE32(spike count of every neuron)`. Recompute it and you have replicated the row |
| `total_spikes`, `active_neurons` | summaries of the run |
| `neuron_index`, `spike_count` | the whole result, sparsely: every neuron that spiked and how often. Indices are rows of `neurons` |
| `late_dnge145`, `late_gf`, `late_dnp12`, `late_locked38` | spikes in the last half of the run for the readout groups used in the paper (per cell) |

`individuals` has one row per individual with its recipe (`recipe_hex`, a FLYDELTAv3 file of a few hundred bytes), ids, and how its wiring differs from the base. `neurons` maps a payload index to a FlyWire root id.

## How the individuals are made

Every synapse count of the base is redrawn from a negative binomial whose dispersion was fitted to left-right differences within one brain; the variance given to one individual is half that of a left-right pair. Draws are a pure function of the recipe's seed and the connection, in fixed point, so the recipe alone determines the individual. Individuals are laid out in place on a base that keeps connections of two or more synapses; counts that fall below five get weight zero.

## Replicating a row

Decode the base payload, apply the recipe, run the stimulus for `steps` steps with `seed` under `int-lif:v1`, hash the spike counts. The reference implementations (Python, JavaScript/WebAssembly) and the payload formats are in <https://github.com/jianmliu/aigg-porw>. The same rows are executed redundantly by browser nodes and settled on BNB Chain, where a wrong digest can be proven wrong.

## Limits

The simulator has no neuromodulation, gap junctions or cell-type-specific parameters. A stimulus is a set of sensory neurons driven at a fixed rate. The variability between individuals is a model, calibrated on one brain's two hemispheres and applied independently to every connection.

## Source data and licence

The wiring comes from the FlyWire connectome (v783), whose public release data is under CC BY-NC 4.0 (<https://flywire.ai/guidelines>). This dataset contains simulation results and recipes, not the connectome; the base payload is identified by its content address. As an adaptation it is released under **CC BY-NC 4.0**: share and adapt with attribution, not for commercial use. Cite FlyWire as its guidelines ask.

## Acknowledgments

The individuals are hosted by the people who hold them. The list is read from the chain and is in Appendix A of the paper.
