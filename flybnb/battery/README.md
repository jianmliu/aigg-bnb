# The standard battery

The fixed set of assays **every** individual gets. It is what makes FlyBnB one dataset instead of three projects:

| analysis | what it does with the battery |
|---|---|
| the perturbation atlas | runs it with a silence set (or an activation) on every run, and compares with the same individual's unperturbed battery |
| the association analysis | regresses its readouts on the wiring, across individuals |
| the selection experiment | measures it in parents and in offspring: heritability, response to selection, correlated responses |

Operationally it is one action. When an individual exists (minted, or bred), its battery is posted as one batched task (`battery_batch.mjs`: 39 runs, the stimulus sets named once), executed by the nodes that host that brain, and its 39 rows land in the same table as everybody else's.

## Battery v1 (`battery-v1.json`)

13 stimuli × 3 seeds (7, 8, 9) = 39 runs of 5,000 steps (0.5 s); commit stride 500. The readout is every descending neuron (1,303), spikes in the last 250 ms. A stimulus is a set of **sensory** neurons chosen by an annotation rule (FlyWire v783 annotations) and driven at about 150 Hz for the whole run; the rule is recorded beside the ids so that the set can be rebuilt and argued with.

| stimulus | modality | neurons | what it drives on the base wiring (mean of 3 seeds) |
|---|---|---|---|
| `sound` | hearing | 359 | 220 neurons reached, 29 descending neurons active |
| `sound_left` | hearing, one side | 205 | 61, 12 |
| `sound_gate` | hearing + the two gate neurons | 361 | 150, 25 — not purely sensory: the first entry of the atlas, kept so that every individual has it |
| `wind` | wind and gravity | 484 | 462, 59 |
| `sugar` | taste | 129 | 507, 68 |
| `bitter` | taste | 65 | 115, 3 |
| `taste_peg` | taste | 146 | 310, 49 |
| `head_bristle` | touch (head grooming) | 305 | 1,475, 160 |
| `eye_bristle` | touch | 1,112 | 1,736, 180 |
| `ocelli` | vision (whole-field light) | 273 | 55, 16 |
| `moist` | humidity | 16 | 886, 74 |
| `pheromone` | smell | 429 | **6,990**, 142 — ignited |
| `cold` | temperature | 9 | **6,779**, 142 — ignited |

**Two regimes, and the battery keeps both on purpose.** Most stimuli stay sparse: a few hundred neurons. A few tip the whole network into a high-activity state (about 7,000 neurons, a quarter of a million spikes), and they end up looking alike downstream whatever they started as: nine cold-sensing neurons drive the same 142 descending neurons as 429 pheromone receptors do. That is a property of the model (no neuromodulation, uniform parameters), not a finding about flies, and a readout in that regime says little about the stimulus. It is kept because *whether and how an individual ignites* is itself a phenotype that varies.

What is not in it: anything that needs spatial or temporal structure (looming, optic flow, song), because an int-lif stimulus is a set of neurons at a fixed rate. Photoreceptors other than the ocelli are left out for the same reason.

## Rebuilding it

```bash
python flybnb/battery/build_battery.py --annotations annotations.tsv --payload flywire-783-min5.bin
```

`annotations.tsv` is the neuron annotation table of `flyconnectome/flywire_annotations` (v783). The script maps root ids to payload rows, applies the rules, runs the base wiring under every stimulus with `flybnb/analysis/intlif.py`, and writes the table above into the file. Indices are rows of the payload's neuron table, which is the same for the ≥ 5 and the ≥ 2 synapse export.

A changed battery is a new version and a new file. Rows of different battery versions are not comparable, and the version is part of every row.
