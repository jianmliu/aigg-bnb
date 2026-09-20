# FlyBnB: a whole-brain perturbation atlas, re-tested across individuals

Research proposal, draft v1, 2026-09-18. The living paper draft is [`paper.md`](paper.md); the pilot's code and results are in [`flybnb/`](../../flybnb/).

The name: Fly + BnB. The brains are hosted in many people's browsers (the bed-and-breakfast kind of bnb), tasks run on a peer-to-peer mesh, and settlement is on BNB Chain. The name needs a trademark check before it is used for anything but a dataset (Section 13).

## 1. In one paragraph

Silence and activate every cell type of the female (FlyWire) and the male (MaleCNS) fly brain, one at a time, under a battery of standard sensory stimuli, and record the output of every descending neuron. Then repeat each result in one hundred synthetic individuals whose wiring varies as much as the left and right hemispheres of a real brain do. The product is a public database in which every row is one whole-brain run (perturbation × stimulus × individual × seed) carrying a digest that anybody can recompute bit for bit. It supplies the control that connectome simulation owes: a conclusion drawn from one brain, does it hold in another?

## 1a. One dataset, three analyses

FlyBnB started as three questions, and they turn out to be three readings of one table. A row is one whole-brain run: *perturbation × stimulus × individual × seed*, with a digest. What differs is the axis that is opened.

| analysis | the rows it reads | the question |
|---|---|---|
| **the perturbation atlas** | every perturbation, in every individual | which simulation results survive a change of brain? (Sections 5 to 6, H1 to H4) |
| **the association analysis** | no perturbation, many individuals, with their wiring | which connections decide a phenotype? The pilot already has a first answer: the four direct gate connections do not (r = −0.27) |
| **the selection experiment** | individuals that are crosses, with their parents | is a circuit phenotype transmitted, and does selecting one behaviour break another? |

What makes it one dataset in practice is **the standard battery** ([`flybnb/battery/`](../../flybnb/battery/)): 13 stimuli × 3 seeds, the output of every descending neuron. Every individual gets it. The atlas perturbs it, the association analysis regresses its readouts on wiring, the selection experiment measures it in parents and offspring. Operationally there is one action: when an individual exists, minted or bred, its battery is posted as one batched task, the nodes that host that brain execute it, and its 39 rows land in the table. So an individual that somebody breeds because they like it is, without anybody deciding so, a data point in all three analyses, and holders of the included individuals are acknowledged using the release snapshot rule in Section 12.

The selection experiment is the one this system fits best, and the one a cluster cannot imitate: the crosses, the lineage and who chose to make them are on a chain. It was also the one with the most to prove, so it was piloted first (Section 3a): phenotypes are transmitted, and one generation of selection moves the selected one by two standard deviations.

## 2. What exists already

- **Two whole brains under one execution rule.** FlyWire v783 (139,255 neurons, 8,840 annotated cell types, 1,303 descending neurons, 16,907 sensory neurons) and MaleCNS v1.0, both exported as `FLYBRAINv2` payloads and simulated under `aigg:exec:int-lif:v1`, an integer leaky integrate-and-fire rule that is bit-exact across implementations.
- **The first entry of the atlas is done**: the gate experiment ([`tasks/flywire-gate/`](../../tasks/flywire-gate/)). With both ears' Johnston's organ neurons driven, two ascending gate neurons silence the descending neuron DNge145; deleting the four direct gate connections abolishes the silencing, and keeping only those four preserves it. Six digests agree across the reference implementation, the browser kernel and an end-to-end run on a local chain.
- **A model of individual variability.** A negative binomial on synapse counts, with a dispersion that depends on the count, fitted to the paired differences between the two hemispheres of one brain; the variance given to an individual is half that of a left-right pair. Three implementations (JavaScript, Python, Solidity) agree byte for byte on 85 test vectors.
- **Individuals whose identity can be checked.** An individual is a recipe of a few hundred bytes laid out in place on a base that keeps connections of two synapses or more (counts below five get weight zero), with an on-chain fraud proof that needs one record.
- **A fast reference runner** ([`flybnb/analysis/phenotype_variance.py`](../../flybnb/analysis/phenotype_variance.py)). It visits only the outgoing records of neurons that spiked, reproduces both published reference digests bit for bit, and runs 0.5 s of brain time in 3 to 4 s on one core, about twenty times faster than the dense reference.

## 3. The pilot: do phenotypes differ between individuals at all?

The project only makes sense if calibrated wiring noise moves a phenotype, and moves it by more than the noise of the assay. The pilot measures that and nothing else.

Design: 100 in-place founders × 10 stimulus seeds × 2 stimuli (both ears' Johnston's organ neurons; the same plus the two gate neurons), 5,000 steps each. The only randomness in int-lif is the stimulus spike train, so a "seed" is another realisation of the same sound. Every individual sees the same seeds, so variance separates into between-individual, between-seed and interaction components. Individual 0 is the base wiring itself and reproduces the published result digit for digit. The full run was done twice; the second pass reproduces the first field for field.

Results ([`flybnb/results/pilot/variance.md`](../../flybnb/results/pilot/variance.md); 2,000 runs):

| phenotype (spikes in the last 250 ms) | mean over founders | base wiring | SD between individuals | range of individual means | ICC, one assay | ICC, mean over seeds |
|---|---|---|---|---|---|---|
| DNge145, sound only | 8.18 | 6.40 | 5.57 | 0.0 to 25.6 | 0.87 | 0.99 |
| DNge145, sound + gate | 2.41 | 0.70 | 2.81 | 0.0 to 13.7 | 0.80 | 0.99 |
| gate suppression of DNge145 (paired difference) | 5.78 | 5.70 | 3.60 | 0.0 to 16.4 | 0.83 | 0.99 |
| giant fibre, sound only | 20.41 | 25.00 | 6.48 | 5.8 to 36.2 | 0.88 | 0.99 |
| gate effect on the giant fibre (paired difference) | 1.50 | 3.00 | 2.97 | −7.3 to 10.7 | 0.74 | 0.97 |
| DNp12, sound only | 21.71 | 14.90 | 10.90 | 1.6 to 49.2 | 0.87 | 0.99 |
| listening layer (38 phase-locked cells) | 289.9 | 272.3 | 41.4 | 194.6 to 425.7 | 0.69 | 0.99 |
| whole-brain spikes (0.5 s) | 29,235 | 29,410 | 319 | 28,731 to 30,472 | 0.36 | 0.89 |

Three conclusions.

- **The premise holds.** For the readout of a single cell type, the intraclass correlation of one half-second assay is between 0.65 and 0.89: an individual's phenotype is a property of its wiring that one run measures. For whole-brain totals it is much lower (0.36 to 0.40). Individuals differ in particular pathways, not in how active the brain is.
- **The published gate result holds as stated in a minority of individuals.** On the base wiring the gate takes DNge145 to nearly zero. Across one hundred individuals the gate still removes about seventy percent on average (8.18 to 2.41), but complete silencing is not the rule: 39% of runs are fully silenced, 8% of individuals are silenced under every seed, and 37% are never fully silenced. That is what H1 will measure over the whole atlas; the gate is its first data point.
- **The four direct connections do not explain who leaks.** They sum to 102 ± 23 synapses across individuals (52 to 165), and that sum correlates only −0.27 with the residual DNge145 activity under the gate. What decides the difference between individuals is the rest of the input to the same cell. That is the question of H2, and the answer will not be "count the direct synapses".

The wiring itself: in each individual about 800,000 base connections fall below the threshold and about 790,000 rise above it, while the number of connections and of synapses stays stationary. On every phenotype the base wiring sits between the 29th and the 87th percentile of the individuals: it is an ordinary individual, not a special case.

Not measured: narrow-sense heritability under the cross (it needs parent-offspring pairs); the other stimuli; the male brain. The variability model redraws every connection independently and may overstate the turnover of near-threshold connections; the dose-response of Section 9 is there for that.

## 3a. The breeding pilot: is a phenotype transmitted?

The assay is deterministic: for fixed seeds a phenotype is a function of the wiring and nothing else, so all of its variance between individuals is genetic. What is not given is how much of it a parent passes on. Under the collection's cross an offspring takes each connection from one parent or the other and then one connection in eight is redrawn around the base. A purely additive phenotype therefore regresses on the midparent with slope 7/8 = 0.875. That is an expectation for additive phenotypes and not a bound (a thresholded response can regress more steeply); a slope well below it means that part of the phenotype lives in interactions between connections, which recombination breaks up.

Design ([`flybnb/results/breeding/design.json`](../../flybnb/results/breeding/design.json)): the pilot's 100 founders; 100 offspring of founders paired at random (every founder a parent twice), for the midparent regression; and two divergent selection lines of 50 offspring each, bred among the 20 founders with the highest and the 20 with the lowest DNge145 response to sound. Every individual gets the full battery.

<!-- BEGIN GENERATED: breeding -->
**Design.** 100 founders, 100 randomly mated offspring, and 50 + 50 offspring of two divergent selection lines; every individual under the full battery (39 runs). 674 phenotypes: named cell types, per-stimulus totals, and every descending cell type that is active in at least half of the founders.

**Phenotypes are transmitted.** The midparent regression slope, the narrow-sense heritability under this cross, has median 0.67 (quartiles 0.55 to 0.80); 82% of phenotypes are above 0.5. Against the additive expectation of 0.875 (slope ± 2 SE): 248 phenotypes are clearly below it, 422 are consistent with it, 4 clearly above. So for about 37% of phenotypes a measurable part lives in interactions between connections, which recombination breaks up.

**Selection works, in one generation.** Selected trait: DNge145 | sound (founder mean 9.55). The high line's parents were 8.89 above the mean and their offspring 7.01 above it; the low line's parents 7.18 below and their offspring 5.43 below. Realised heritability 0.77 (high 0.79, low 0.76); the midparent regression gives 1.06 ± 0.12. The two lines end 2.09 founder standard deviations apart.

**What else moved.** Of 674 phenotypes, 14 differ between the two lines at a false discovery rate of 0.05, and 10 of those are not DNge145 phenotypes: DNg24 | sound (-0.99 SD); DNge041 | head_bristle (-0.83 SD); DNg38 | sugar (+0.75 SD); DNp35 | sound (-0.75 SD); DNpe020 | eye_bristle (-0.67 SD); DNg35 | eye_bristle (-0.64 SD). Selection on one response is mostly specific, and not entirely. The one trade-off that matters here is inside the selected circuit: the line bred for a strong response to sound also leaks more through the gate (DNge145 under `sound_gate`: 6.45 against 0.93).

| phenotype | founder mean ± SD | h² (midparent slope ± SE) | high line | low line | high − low, in founder SDs |
|---|---|---|---|---|---|
| DNge145 | sound | 9.55 ± 5.95 | 1.06 ± 0.12 | 16.55 | 4.12 | +2.09 |
| DNge145 | sound_gate | 3.02 ± 3.27 | 1.02 ± 0.11 | 6.45 | 0.93 | +1.69 |
| gate suppression of DNge145 (sound - sound_gate) | 6.53 ± 3.80 | 0.94 ± 0.13 | 10.10 | 3.19 | +1.82 |
| giant fibre | sound | 20.30 ± 6.41 | 0.57 ± 0.13 | 19.37 | 19.89 | -0.08 |
| DNp12 | sound | 21.17 ± 10.78 | 0.82 ± 0.12 | 23.13 | 17.87 | +0.49 |
| descending spikes, all | sound | 251.79 ± 50.54 | 0.69 ± 0.11 | 240.48 | 258.39 | -0.35 |
| descending spikes, all | sound_left | 124.98 ± 35.45 | 0.35 ± 0.09 | 123.91 | 119.33 | +0.13 |
| descending spikes, all | sound_gate | 212.76 ± 50.84 | 0.66 ± 0.15 | 195.58 | 206.52 | -0.22 |
| descending spikes, all | wind | 771.73 ± 415.71 | 0.34 ± 0.11 | 715.40 | 970.61 | -0.61 |
| descending spikes, all | sugar | 1744.91 ± 447.14 | 0.54 ± 0.11 | 1762.97 | 1605.57 | +0.35 |
| descending spikes, all | bitter | 310.28 ± 529.57 | 0.44 ± 0.09 | 285.11 | 300.28 | -0.03 |
| descending spikes, all | taste_peg | 532.29 ± 448.73 | 0.68 ± 0.12 | 508.43 | 503.87 | +0.01 |
| descending spikes, all | head_bristle | 4084.33 ± 405.70 | 0.29 ± 0.12 | 4016.03 | 4157.74 | -0.35 |
| descending spikes, all | eye_bristle | 1318.08 ± 245.70 | 0.28 ± 0.11 | 1261.56 | 1367.51 | -0.43 |
| descending spikes, all | ocelli | 397.29 ± 46.00 | 0.81 ± 0.13 | 416.77 | 395.77 | +0.46 |
| descending spikes, all | moist | 1245.34 ± 791.63 | 0.79 ± 0.15 | 1435.25 | 1215.23 | +0.28 |
| descending spikes, all | pheromone | 2914.71 ± 290.64 | 0.81 ± 0.12 | 2931.90 | 2908.31 | +0.08 |
| descending spikes, all | cold | 2695.76 ± 339.98 | 0.78 ± 0.12 | 2745.14 | 2691.51 | +0.16 |
<!-- END GENERATED: breeding -->

## 4. Why the individual axis

- A connectome is a sample of one: one female, one male. The available comparisons between brains, and between the two hemispheres of one brain, show that synapse counts between the same two cell types differ considerably. That is what the variability model is calibrated on.
- Simulation results tend to rest on a few pathways. The whole effect of the gate is carried by four records whose counts change between individuals, and near-threshold records appear and disappear altogether.
- So every prediction of the form "silence X and behaviour Y disappears" carries an untested premise: that it is robust to individual differences in wiring. FlyBnB turns that premise into a number on every row.

## 5. The dataset

### 5.1 Four axes

| axis | values | note |
|---|---|---|
| perturbation | 8,840 cell types × {silence, activate}, one set per sex; plus connection-level edits (the gate kind) | a cell-type perturbation is a task input, not a model variant (5.3) |
| stimulus | about 10 to 15 standard sensory input sets | sets of sensory neurons defined from the annotations and driven at about 150 Hz: Johnston's organ A/B (sound) and C/E (wind), looming, wide-field optic flow, sugar and bitter gustatory neurons, a few olfactory glomeruli, antennal mechanosensation (grooming), temperature and humidity. Each definition ships with the dataset |
| individual | the base wiring + 100 founders, one set per sex; offspring of crosses in a second phase | an individual is a brain hosted on the network, and a token of the collection |
| seed | 3 to 10 | another realisation of the stimulus train; gives the noise of the assay |

The readout is not chosen in advance. Every run stores the spike count of every neuron that spiked (about 560 of 139,255 in the pilot), so a row is a sparse vector of a few kilobytes. The 1,303 descending neurons are the default behavioural readout, but the same data answer other questions.

### 5.2 Two exact prunings

- **Silencing a neuron that never spikes changes nothing, bit for bit.** int-lif is deterministic and has no background activity, so this is a theorem and not an approximation. The silencing atlas needs only the cell types that are active in that individual under that stimulus: a few hundred per stimulus, not 8,840. Every other cell of the table is the digest of the unperturbed run, and verifiably so.
- The activation atlas cannot be pruned like that, but an activation is itself a stimulus and need not be crossed with the stimulus axis.

### 5.3 How a perturbation enters the system

- A connection-level edit (delete an edge, change a weight) is a model variant, expressed as a `FLYDELTAv1` delta. The gate task was done this way.
- A cell-type perturbation as a model variant would be 100 individuals × 8,840 types, close to a million registered models. It is a task input instead: a **silence set** beside the stimulus set. Activation is already expressible as a stimulus set.
- **Done upstream** ([aigg-porw#26](https://github.com/jianmliu/aigg-porw/pull/26)): the silence set is bit 2 of the `flags` field of `state_0`. `state_0` already carries the stimulus set in bit 0 and the task already commits to it, so silencing a cell type is one more bit in a state the chain already binds, and nothing new on chain. Four implementations (the WebAssembly kernel, JavaScript, Python, Solidity) agree state by state.

### 5.4 Scale

| part | runs (per sex) |
|---|---|
| unperturbed baseline: 15 stimuli × 101 individuals × 10 seeds | about 15,000 |
| silencing atlas: about 300 active types × 15 stimuli × 101 individuals × 3 seeds | about 1.4 million |
| activation atlas: 8,840 types × 101 individuals × 3 seeds | about 2.7 million |
| total | about 4 million; 8 million for both sexes |

## 6. Hypotheses

The database is the main product and does not depend on any hypothesis. These four analyses are published with it.

### H1. The distribution of robustness

Prediction: of the perturbation effects detected on the base wiring, only a part replicate in most individuals, and effects fall into a robust and a fragile group rather than a continuum. Measured by the distribution of each (perturbation, stimulus, readout) effect across individuals, its replication rate, and the ratio of effect size to between-individual standard deviation. The pilot gives the first data point: the gate's suppression replicates in most individuals, complete silencing under every seed in 8% of them.

### H2. Robustness can be predicted from wiring

Prediction: an effect carried by many parallel, high-count connections is robust; one carried by a few near-threshold connections is fragile. If so, there is a robustness index that needs no simulation and applies to any connectome pathway paper. Measured by regressing replication rate on the number of records, the number of synapses and the size of the minimum cut between the perturbed cells and the readout.

### H3. Robust effects hold across brains

Two external tests that need no experiment. The two hemispheres of one brain are two natural individuals: perturbing a left cell type and its right homologue should give mirror effects. Between the female and the male brain, effects in non-dimorphic circuits should agree. Prediction: effects that are robust across synthetic individuals agree across hemispheres and sexes significantly more often than fragile ones. If they do not, the variability model is missing the structure of real individual differences, and that is reported.

### H4. Robust predictions stand up to experiment

Published silencing and activation experiments with clear phenotypes (the giant fibre and escape, moonwalker neurons and backward walking, the antennal grooming circuit, feeding circuits, and published whole-brain simulation predictions) are mapped onto rows of the database. Prediction: they are recovered more often among robust rows than fragile ones. The database also ships a list of predictions with no experiment yet, ranked by robustness and effect size, for laboratories that hold the split-GAL4 lines.

## 7. Why this fits the mesh, and what it is not

What it is not: a computation only a mesh can do. Eight million runs at 3.4 s are about 7,600 core-hours, a day or two on an ordinary cluster. In the browser kernel a run takes about 11 s, and at redundancy 2 the atlas is about 50,000 core-hours: a thousand browser tabs for two days. Compute is not the reason.

The reasons are three.

- **Every row can be checked.** The execution rule is bit-exact, a result is settled by its digest, runs are executed redundantly and a wrong one can be proven wrong by bisection. Each row carries who computed it, who agreed, and how anybody recomputes it. For a resource that will be cited for years, that matters more than speed.
- **Individuals have holders.** Hosts execute the brains; holders are recorded independently. The dataset acknowledges the holders of included individuals at its release snapshot block (Section 12).
- **It is open-ended.** Anybody can post new stimuli and new perturbations against the same individuals, and the results land under the same identifiers. This is also where real task demand on the network comes from.

## 8. What the system needed, and where that stands

1. **A silence set as a task input.** Done upstream (5.3).
2. **Batched tasks.** One task used to be one run, settled on its own; measured at 864,187 gas at redundancy 2, which millions of runs cannot pay. Done upstream in the same change: a batch is one task whose input is the Merkle root of its runs and whose result is the root of the per-run results. A batch of 1,000 runs costs 860,709 gas on the honest path, **860 per run**. A disagreement is bisected to the first run the parties differ on, and from there it is that run's dispute, unchanged. Still to do: the browser node does not yet execute a batch and the relayer does not announce one.
3. **The cost of a task grows with the number of hosts.** Found while measuring: about 55,000 gas per enrolled instance per task, because the executor list is rebuilt from every enrolled instance. It needs a sortition that does not scan, and it bounds how many people can host one brain until it is fixed.
4. **On-chain proof of a phenotype** (optional): open leaves of a settled execution root to prove a descending neuron's spike count. Needs a check of what the execution root commits.

Until the node and the relayer speak batches, rows are generated offline with the reference runner and published with their digests, and settlement on the mesh accumulates as independent replication. The science is not held up by the system.

## 9. Analysis

- Variance components and intraclass correlation for every phenotype (as in the pilot), as the repeatability of the assay.
- An effect is the paired difference between the perturbed run and the unperturbed run of the same individual and seed, so that seed noise is not counted as effect.
- Robustness: the fraction of individuals in which the effect has the same sign; the between-individual coefficient of variation of its size.
- Multiple comparisons: about 10⁶ (perturbation, stimulus, readout) combinations; a p-value per row from paired permutation across seeds, controlled by FDR.
- Dose-response of the variability model: a subset re-run at 0.5×, 1× and 2× the dispersion. A robustness conclusion that holds only at 1× is not a conclusion.

## 10. Risks

- **Model error.** The simulator has no neuromodulation, no gap junctions and no cell-type-specific parameters. The atlas measures the phenotypes of this model. H4 measures that gap against the literature, stratified by robustness.
- **The variability model may over- or understate individual differences.** It is calibrated on one brain's two hemispheres and redraws every record independently, whereas real differences are probably correlated along a neuron or a lineage. Addressed by the dose-response (Section 9) and the hemisphere and sex tests of H3.
- **Stimulus sets are artificial.** Driving a set of sensory neurons at 150 Hz is not a natural stimulus. Every set ships with its definition, the annotations it came from and its limits.
- **Activity is sparse.** About 560 neurons are active in half a second, so many perturbations have no measurable effect. That is part of the result, but "no activity" must not be read as "no function". The activation atlas covers what the silencing atlas cannot see.
- **It is not a new idea.** Activation and silencing predictions have been made for selected circuits. What FlyBnB adds is completeness, the individual axis and rows that can be recomputed, and the proposal claims nothing else.

## 11. Phases

1. The variance pilot (done, Section 3).
2. Stimulus set definitions; the unperturbed baseline for both sexes; the silence set in the reference runner. Three days.
3. The female silencing atlas, generated offline; first round of H1 and H2. One week.
4. The activation atlas; the male brain; H3. Two weeks.
5. Comparison with the literature (H4) and the list of predictions. One week.
6. Batches in the browser node and the relayer, and settlement on the mesh. In parallel with 3 to 5.

## 12. Authorship and acknowledgments

The dataset paper uses the [CREDIT policy](CREDIT.md): acknowledge the holders of NFTs actually included in each release's research at one specified block. Record the release identifier, chain, collection, block number and hash, included token IDs and holder addresses. The default list requires no reconstruction of adoption, breeding, payment or transfer histories.

Freeze the list when the release is published. Transfers before the snapshot change eligibility; later transfers do not change an already published list. Each new release takes its own snapshot. Addresses are the default display; a name or ORCID requires the holder's authorization. Authorship follows intellectual contribution. Royalty rights follow the contracts independently. Optional recognition of funders, breeders or compute providers uses separate evidence and is not a condition for publishing the holder list.

## 13. The name

FlyBnB means three things: hosting (bed and breakfast), a peer-to-peer mesh, and BNB Chain. One thing has not been checked: Airbnb is known to object to "-bnb" names close to the idea of hosting, and BNB is Binance's mark. The risk is probably low for a dataset name in a paper and higher for a product or a token. Check the trademark before the name is used for anything else.

## 14. What success and failure look like

Success: the database is published and every row can be recomputed; H1 at least gives a clear distribution of robustness, with a list of predictions that experiments can test. There is only one kind of failure: perturbation effects do not vary between individuals at all (then the individual axis is redundant), or they never replicate (then single-brain simulation results are unreliable in general). The pilot has ruled out the first. The second, if true, would be a more important result than the database.
