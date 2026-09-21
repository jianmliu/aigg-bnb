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

## The male battery (`battery-male-v1.json`)

The same assay for the male brain (Janelia MaleCNS v1.0, brain **and** ventral nerve cord, CC-BY 4.0): 14 stimuli × 3 seeds = 42 runs, the readout every descending neuron (1,314). Built by `flybnb/male/build_battery.py` from the release's body annotations.

| stimulus | neurons | reached on the base wiring, descending neurons active |
|---|---|---|
| `sound` | 114 | 181, 23 — a **left-ear** stimulus, see below |
| `sound_gate` | 116 | 129, 15 — sound plus the two `AN02A001` neurons, the male type matched to FlyWire's `AN_multi_8` |
| `wind` | 475 | 1,877, 210 |
| `taste_labellar`, `taste_peg`, `taste_leg` | 163, 60, 768 | 571, 28 · 590, 80 · 2,002, 129 |
| `ppk23` (contact pheromone) | 269 | 2,491, 145 |
| `touch_leg`, `grooming` | 213, 65 | 535, 13 · 296, 38 |
| `chordotonal`, `campaniform`, `haltere` | 425, 426, 205 | 773, 11 · 1,222, 21 · 1,703, 47 |
| `hygro`, `thermo` | 66, 25 | **5,562**, 123 · **5,598**, 130 — ignited |

**A battery names its population.** What differs between connectomes is not the assay but the individuals: the base they are drawn on, their variability model, and the weight unit of their exec kind. The male file carries them in `population`, and `run_battery.py` reads them from there (a battery without one is the female brain's):

| | female (FlyWire v783) | male (MaleCNS v1.0) | where the male value comes from |
|---|---|---|---|
| in-place base | `flywire-fafb-v783-min2` | `malecns-v1.0-min2` (154,169,344 bytes, sha256 `38227caa…71ba`) | `malecns_export.py --min-syn 2` |
| weight unit (Q16) | 18022 | **7209** = 0.40 × | `male/count_scale.py`: MaleCNS counts are 1.55–1.62 × FlyWire's over 222,457 homologous connections; `male/unit_scan.py`: at 18022 every male stimulus ignites, at 7209 the male brain is in the female brain's regime. The unit is a parameter of the exec kind, declared on chain (`MEPRegistry.declareLifKind`) |
| dispersion table | 423, 479, 677, … | 218, 347, 520, 635, 923, 1339, 1907, 2899, 4305, 4797 | `male/lr_conditional.py`: the male brain's own two hemispheres, the female table's derivation |
| mean ratio | 0.92 | **0.93** (Q16 60948) | `male/founder_density.py`: a founder then has 100.6% of the real male's synapses of ≥ 5; the mirror data independently give 0.931 |

**A reconstruction is not symmetric, and the battery says where.** Every male stimulus records its outgoing synapses by side of entry. The right antenna's auditory neurons are nearly disconnected in this release (835 synapses of ≥ 5 against 25,201 on the left; driving them alone reaches 2 neurons), and `wind` is lopsided the same way (38,037 against 108,209). So the male `sound` is a left-ear stimulus and there is no separate `sound_left`. The other stimuli are balanced within 30%, `hygro` excepted (30,945 right, 16,805 left).

Male results are **provisional** until the male kind is declared and the base registered on a public network: nothing here has been executed by anyone else yet.

## Posting a battery to the network (`post_battery.mjs`)

```bash
FLYBNB_REQUESTER_KEY=0x… node flybnb/battery/post_battery.mjs --relayer https://<relayer> --payload individual.bin --name <payload name> \
    --battery flybnb/battery/battery-male-v1.json --offline rows.jsonl --id M000 --out attestation.json
```

A requester needs a funded key (it pays the task's fee and the gas of one `postBatch`, nothing else; the key is read from the environment and never written), the relayer's URL and the brain's payload. The script checks that the brain is registered under the weight unit the battery's population names **before paying**, posts the battery as one batched task, finds the drawn executors' session keys on chain (`SessionKeySet`), announces, and collects.

What comes back is an **attestation**, not numbers: the task, its executors, the batch root they signed, and per run the `execRoot` and the counts digest. The readout of a row is recomputed by whoever wants it (`run_battery.py`); what the network adds is that bonded executors drawn by the chain ran the same runs of the same registered brain and signed the same result, with any single run open to dispute. `--offline` joins the two: the network's digests are `run_battery.py`'s digests for that individual, or the mismatching runs are named.

`test/e2e_post_battery.mjs` does all of it on a local chain under the male kind (unit 7209): two independent implementations, the wasm kernel in the nodes and numpy offline, agree on every digest; the same payload run offline under 18022 does **not** join. (That last check is what showed the first version of the test to be hollow: over 40 steps nothing leaves the stimulated set and a run does not depend on the unit at all.)

## The male battery, run on the live network (2026-09-20)

Task `0xc832cc87…0648` on BSC testnet: the 42-run battery as **one** batched task on the registered male base, executed by a bonded instance holding MaleCNS v1.0 at weight unit 7209, submitted through the relayer and settled on `0x5750bdc1…8df2`. The rows in `flybnb/results/male/live/attestation.json` hash to exactly that root, and `test/flybnb_battery.mjs` recomputes it rather than trusting the file.

**All 42 counts digests equal what numpy computes offline**, at a weight unit that is not the default — so nothing is passing by accident on FlyWire's constant. `test/live_male_battery.mjs` is the run; `flybnb/male/recompute_live.py` builds the reference.

Redundancy was 1, because one instance is enrolled for this brain. That settles and attests a result; it does not cross-check it. `agreed` stays false and the attestation says so.

**And on the published wiring** (task `0x553db67d…c6c6`, settled on `0xcdada85b…5c4d`): all 42 digests equal the dataset's `base` row. This is the run the substrate could not be, and the pair is now the evidence for the distinction below — the same battery, the same weight unit, two male payloads, and **not one of the 42 digests is shared between them**. `test/flybnb_battery.mjs` checks both directions.

**And then on a minted fly** (task `0x4df627a8…7d32`, settled on `0xc8ccb0f9…5ec6`). `fly #101` of the founder collection is, by delta id, the pilot founder `M000` of `flybnb/results/male/pilot/`: the same FLYDELTAv3 recipe, seed 1000, the male dispersion table and mean ratio. Its battery was posted as one task, executed, settled — and **all 42 counts digests equal the row already committed in this repository**, checked against those rows themselves rather than a summary.

That run needed no special reference, which is the individual case being clean: a genotype zeroes what falls under `min_syn`, so a fly's payload and its offline row are the same network. Two things it did need, both of which a base payload does not: the payload is the substrate with the fly's delta applied (`FD.apply_any`), and the MEP id **wraps the collection's royalty terms** (1000 bps), so a node must be told them or the same bytes reproduce a different id — `loadModel({ terms })`, exactly as the relayer does.

**The reference is not the dataset's `base` row, and the difference is the point.** `run_battery.py` calls the *published wiring* the base: the ≥ 2-synapse export thresholded at the population's `min_syn` (five). What `registerMEP` points at is the ≥ 2 export itself — the substrate individuals are drawn on — which keeps 15,283,237 records against 6,242,118 and is a denser network with different dynamics. A node holds the payload as it is. Joining the run against the dataset's base row makes all 42 digests differ, which is the right answer to the wrong question; it is how this was found. Individuals do not have the problem: a FLYDELTA genotype zeroes what falls under `min_syn`, so an individual's payload and its offline row are the same network. If a task should reproduce the dataset's base row, what belongs on chain is the ≥ 5 export as its own MEP — which is what the female brain already has, and the male does not yet.

## Rebuilding it

```bash
python flybnb/battery/build_battery.py --annotations annotations.tsv --payload flywire-783-min5.bin
```

```bash
python flybnb/male/build_battery.py --annotations body-annotations-male-cns-v1.0-minconf-0.5.feather --payload malecns-v1.0-min2.bin
```

`annotations.tsv` is the neuron annotation table of `flyconnectome/flywire_annotations` (v783). The script maps root ids to payload rows, applies the rules, runs the base wiring under every stimulus with `flybnb/analysis/intlif.py`, and writes the table above into the file. Indices are rows of the payload's neuron table, which is the same for the ≥ 5 and the ≥ 2 synapse export.

A changed battery is a new version and a new file. Rows of different battery versions are not comparable, and the version is part of every row.
