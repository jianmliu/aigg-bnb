# Tokenomics: a collection of brains, and who pays for the mesh

Status: **proposal**. Nothing here is deployed. Numbers marked *measured* come from the live BSC testnet runs and
the anvil suite; everything else is a choice still to be made. Read `docs/DESIGN.md` §4 for the parameters the
mesh already has, and the README's run records for where the measurements come from.

The question this answers: a browser tab that holds a fly brain resident, proves it, and executes research tasks
is asked to bond 0.05 BNB — slashable, with an exit delay — in exchange for a chance of being picked by
sortition. That is a deposit, and deposits convert badly. A collection of brains turns the same act into a
purchase, and pays for the one role in the mesh that currently earns nothing.

---

## 1. What already exists

Four stakes, four different jobs. Only the first is the user's.

| who | how much | what it is |
|---|---|---|
| **instance** (a browser tab) | `UNIT` 0.05 BNB per sortition vote, capped at `MAX_WEIGHT` 16 | the real bond: slashable, exit delay. The Sybil cost |
| **beacon committer** | 0.1 BNB per epoch | not a stake — a revolving deposit, refunded on reveal, forfeited if you never reveal |
| **challenger** | `OPENING_DEPOSIT` 0.01 BNB | anti-griefing; the honest responder wins it |
| **relay operator** | `RelayRegistry` bond 1 BNB | operator identity. Note the testnet relayer has never registered |

Two things about this are worth stating plainly before changing anything.

**Slashing is capped by the bond.** `InstanceRegistry.slash` does `amt = min(amount, bonded[inst])`. `SLASH_AMOUNT`
is 0.5 BNB, but an instance bonded at the 0.05 minimum loses 0.05 and the winner receives 0.05. So the effective
deterrent is whatever the attacker chose to bond, and the cheapest attacker has the thinnest margin. If
`SLASH_AMOUNT` is meant to mean something, either `UNIT` rises to meet it or `bond()` requires at least it —
today `bond()` requires only `msg.value > 0`.

**Nobody pays the relayer.** `TaskMarket.settle` splits the fee among the agreeing executors. The aggregator, the
beacon participant and the gas sponsor — the same process, and the thing the entire BSC posture depends on — take
nothing. The lazy beacon took its idle cost to zero, which makes a volunteer relayer viable at zero traffic, but
an active mesh means the relayer subsidises everyone. That is the hole a mint fee can fill.

---

## 2. What a brain individual is, now that deltas exist

`FLYDELTAv1` (aigg-porw PR #4) expresses a variant of a released brain as a sorted, unique edit list — 10 bytes
per op (`u32 pre`, `u32 post`, `i16 w`) — bound to the base by the base's `model_id` in the header. `apply`
rebuilds the target payload byte for byte as `flywire_export.py` would write it, so the result carries an
ordinary `model_id` and registers as an ordinary MEP.

*Measured:* a 467-record edit of the real brain is a **4.7 KB delta**; diff 0.6 s, apply 0.5 s; the JS and Python
implementations produce byte-identical deltas.

Three consequences, and they are what make a collection possible at all:

- **Storage is not a constraint.** One shared 28 MB base, downloaded once, plus kilobytes per individual. A
  thousand variants is not 28 GB, it is 28 MB and a few megabytes.
- **The genome fits on-chain.** 4.7 KB as calldata is roughly 56k gas; as contract storage ~3.25M gas; via
  SSTORE2 ~940k. At the *measured* 0.1 gwei that is 0.0000075 / 0.00033 / 0.00009 BNB. A brain individual's
  genome can live entirely on the chain, and unlike a collection whose "genome" is a few hundred floats, this one
  is a real edit to a real connectome that a browser will really execute.
- **The CDN story improves.** One hot object instead of N cold ones is exactly what an edge cache is for.

**Update — procedural deltas (aigg-porw PRs #5, #6, merged).** An *individual* is not a 467-record edit: resampling
a brain under a realistic inter-individual noise model changes almost every record, so an explicit `v1` delta of an
individual would be ~27 MB. Two further formats carry the recipe instead of the edits, and both apply to an ordinary
payload with an ordinary `model_id`:

| format | what it is | size | apply (*measured*, real brain) |
|---|---|---|---|
| `FLYDELTAv2` | a synthetic individual: base `model_id` + u64 seed + noise model. Every synapse count is resampled by a deterministic integer sampler (negative binomial, Q256 fixed point) that JS and Python reproduce byte for byte | **202 bytes** | 0.9 s JS, 1.5 s Python |
| `FLYDELTAv3` | a same-base cross: two parent delta ids + seed + inheritance granularity + mutation rate | **231 bytes** | 1.9 s with three ancestors |

The noise model is *measured*, not chosen: it is fitted to the left/right mirror connections of the FlyWire brain
itself (709,769 neuron-level mirror pairs), and two sampled individuals differ from each other the way the two
hemispheres do (SD of the log count ratio 1.06 sampled vs 1.01 measured at 5–9 synapses, 0.63 vs 0.65 at 20–49). So
the on-chain genome of an individual is ~200 bytes — about 3k gas as calldata, ~155k gas as seven storage slots
(0.0000155 BNB at the *measured* 0.1 gwei) — and the statement above gets stronger: the recipe for a real,
executable, statistically calibrated connectome variant fits in a single transaction's calldata many times over.

**A delta cannot add or remove neurons** (`v1`), and its ops address neurons by array index into the base's
root-id table. That matters in §4.

---

## 3. The proposal

**An NFT is a MEP individual. It is not the stake, and it is not an execution licence.**

- **The token** carries: which base, the delta (on-chain), the resulting `model_id`, the `mepId` once registered,
  sex, generation, parents. Owning it means owning a research subject.
- **The bond stays fungible and slashable**, and the mint pays for it. A mint of `MINT_PRICE` splits: `UNIT` is
  bonded in `InstanceRegistry` for the minter, the remainder goes to the treasury that funds the relayer. The
  user performs one action at one price and ends up owning something *and* being a node.
- **Anyone may execute any MEP.** The token owner earns a share of the fees paid for tasks against that brain;
  they do not get to be the only one who runs it.

That last line is the load-bearing one. `TaskMarket.executors` draws sortition over the instances bonded *for a
given mepId*; redundancy 2 means two of them must hold that brain. If a token were both the brain and the sole
right to run it, every MEP would have exactly one executor, no task could ever be cross-checked, and **no dispute
could ever happen** — which would delete the one property this project has that its neighbours do not, and which
`test/e2e_dispute.mjs` and the BSC testnet run exist to demonstrate.

### Why not stake the NFT itself

Because slashing has to move liquid value. Burn the token and the punishment is denominated in the floor price of
an illiquid asset; transfer it to the winner and the honest executor is paid in a collectible instead of the gas
it just spent. And `weightOf = bonded / UNIT` is a parameter the protocol controls; "one token, one vote" hands
that parameter to a secondary market the protocol does not run, where votes get cheap exactly when attacking gets
profitable.

Keep the purchase framing. Keep the slashable BNB underneath it.

---

## 4. Two bases, two sexes, and what breeding can honestly mean

The collection sits on two bases: the female FlyWire FAFB v783 export (139,255 neurons, 2,700,513 synapse
records, 28,123,136 bytes, published and registered on BSC testnet) and a male CNS base (165,733 neurons,
~25.6M connections) that **does not yet exist as a `FLYBRAINv2` payload** — a different source dataset, needing
its own exporter. That is a prerequisite, not a detail.

Breeding requires one of each sex. As a supply mechanic this works: the minority sex sets the breeding rate, so
a deliberately skewed genesis ratio is a throttle you can choose rather than one you discover.

**But a hybrid brain is not expressible.** A delta's ops are indices into one base's root-id table; female index
5,000 and male index 5,000 are unrelated neurons in different animals. Merging two parents' edit lists across
bases produces index-space noise — still a valid payload, still deterministic, still disputable, and
biologically meaningless. Presenting that as a cross-sex hybrid would forfeit the one thing that separates this
project from a generative-art collection: that it is real.

A child is always a variant of **one** base. So breeding has to be defined, and there are two honest options.

**(a) Pairing as entropy.** The child takes one parent's base; the edit list is derived deterministically from
that parent's delta, with the variation seeded by both parents' `deltaId`s. Holding both sexes is required, the
child is a real executable brain, and nothing false is claimed. Implementable on-chain today.

**(b) Pairing as projection.** Express the other-sex parent's edits at **cell type** level and project them onto
the child's base through a cross-sex type correspondence, dropping the types with no counterpart. This is
scientifically defensible — "what does this male circuit modification do in a female connectome" is a real
question, and exactly the kind of task this mesh exists to run. It needs a type table for both datasets, which is
external data this project does not have yet, and it should compile down to an ordinary index-level
`FLYDELTAv1` so the on-chain artefact stays what it already is and anyone can re-run the compile and check it
reproduces the same delta and the same `model_id`.

**Update — two of the premises above have moved.**

*The type table exists.* The male CNS release carries its own cross-dataset match: the annotation table has a
`flywireType` column (and a `dimorphism` column). *Measured* against the FlyWire v783 annotations: 7,784 shared type
names (of 8,840 FlyWire types); 95.1% of female neurons sit in a shared type; **91.9% of the records of the published
≥5-synapse female graph have both ends in a male-mapped type** (92.0% of synapses); 4,889 shared types have the same
cell count in both sexes and 6,144 are within ±1; 1,258 male neurons are labelled male-specific and 270 female
neurons female-specific. So (b) is limited by what a type-level projection can mean (it cannot address individual
neurons, the male VNC third has no counterpart, the sex-specific cells stay in their own base), not by missing data.

*There is a third option, and it is implemented.* **(c) Same-base cross with real inheritance** (`FLYDELTAv3`).
Inheritance acts on the genotype (the count of every base record before the export threshold); per inheritance unit
(record, or all outputs of a neuron, or all inputs of a neuron) a hash bit picks one parent; each record then mutates
with a set probability into a fresh draw around the base count, which keeps the population stationary over any number
of generations (no drift of record counts or of unrelated distances). *Measured* on the real brain, mutation 1/8,
mean |ln ratio| over the 2.7 M published records: parent–child 0.36, siblings 0.40, grandparent–grandchild 0.52,
unrelated 0.64 = founder–founder 0.64. Under (a) a child is no closer to its second parent than to a stranger; under
(c) the pedigree is visible in the bytes. The constraint is the one this section already states: both parents must be
individuals of the *same* base.

How (c) fits "one of each sex": the child takes one parent's base; that parent contributes by inheritance (`v3`,
crossed against the published base so half of the genotype is species-typical), and the other-sex parent contributes
entropy — its `deltaId` goes into the seed — until (b) exists, at which point its projected genotype replaces the
published base as the second `v3` parent. Nothing about the on-chain record changes between the two stages: it is
parents + seed either way.

One honest boundary for whichever rule ships: the left/right differences the noise model is fitted to are
developmental noise under one genotype, not heritable variation. Treating an individual's realised noise as heritable
is a modelling choice; the heritability of synapse counts in Drosophila has not been measured.

Recommendation (revised): ship (c) with the other-sex parent as entropy, specify (b) as the projection that later
replaces that entropy, and treat the male base export as the prerequisite it is. (Original: ship (a), specify (b).)

---

## 5. The binding constraint is memory, not CPU or storage or gas

The node runs in the user's browser, single-threaded (the page loads `sketch.wasm` and never passes a worker pool
to `PorwNode`; as of the worker refactor it runs off the main thread, but still on one core).

This section used to say a residency claim cost **5.1 s** and that CPU was the scarce resource. Scheme
`sketch-tile-keccak:v2` removed the reason for that. Breaking the old claim down on the real brain
(139,255 neurons, 2,700,513 synapse records, 100 steps, stride 10):

| phase | time | what it is | still in a claim? |
|---|---|---|---|
| sketch | 11 ms | the actual proof that the weights are resident | yes |
| commit | 23 ms | the claim's own commitment | yes |
| infer | 1,843 ms | the 100 LIF steps | no |
| disputeCommit | 5,033 ms | a Merkle tree over 139,255 state leaves at every stride boundary | no |

The last two rows were never adjudicated. A claim is invalidated by exactly one verdict — the tile fraud proof —
and that proof reads `partialsRoot` and the model root. `execDigest` reached the chain only inside the claim's own
hash; nothing ever compared it. v2 drops it, and with it the run that produced it.

**A residency claim is the first two rows: 34 ms.** Same brain, same laptop, ~200× less than before. Execution is
still attested, per *task*, by `TaskMarket.Result`, where `execDigest` is compared between redundant executors and
a mismatch opens the dispute — which is the only place it was ever read.

Two knock-on effects for a collection:

**The step count and the commit stride left the MEP.** They are per-task fields now, which is where the dispute
machinery reads them. Before, two MEPs differing only in step count were two bonds, two claims per epoch and two
disjoint sortition pools for one identical brain. One fly is now one `mep_id`, and `mep_id` is a pure function of
the model bytes — which is exactly what an NFT that *is* a brain should mean.

**CPU stops being the cap.** A tab hosting `h` brains now spends `0.034h` seconds of one core per epoch, so `h` is
bounded by something else long before it is bounded by time. What binds instead:

1. **Memory.** Each hosted brain is a 28 MB payload resident in wasm memory, plus its weights tree, its CSR
   commitments and its per-slot regions. That is the real ceiling on `h` for a laptop tab, and it is the number to
   measure next — the 200-individual figure this section used to give was a CPU figure and no longer applies.
   *Measured* (Node, `sketch.wasm`, real 28 MB brain, wasm memory growth per `loadModel`):

   | `maxSteps` the slot is sized for | per hosted brain | brains before failure |
   |---|---|---|
   | 1 | 75 MB | ≥ 12 (915 MB) |
   | 100 | 83 MB | ≥ 12 (992 MB) |
   | 1,000 | 142 MB | ≥ 12 (1.7 GB) |
   | 5,000 | 408 MB | **5** — the sixth fails at 2.07 GB |

   Two things follow. The payload is a third of the footprint at best; the rest is the weights tree, the CSR
   commitments and, dominating at large `maxSteps`, the LIF checkpoints (one 2.2 MB state every 32 steps: 350 MB at
   5,000 steps). And the ceiling *was* **2 GB, not the 4 GB of wasm32**: the sixth 5,000-step brain died with
   `Start offset -2128355728 is outside the bounds of the buffer`, a signed 32-bit offset in the JS glue.

   *That one is fixed.* A wasm `i32` result reaches JS signed, and `porw.js` handed the pointers from `alloc` and
   `mark` straight to `new Uint8Array(buffer, ptr, n)`, so every heap address past 2 GiB arrived negative. Coerced
   with `>>> 0` where a pointer crosses out of the module; *measured* after the fix, allocation and readback run
   through **2.13 GiB**, where before they threw at exactly 2 GiB. So the second column is the wasm32 4 GB, and with
   it about 25 resident brains at `maxSteps ≤ 100`, 14 at 1,000, 10 at 5,000. Sizing checkpoints lazily (on the first
   long task, not at load) would still make the first two rows the only ones that matter for hosting.

   The same measurement now exists as code rather than a one-off: `mem.js` states the per-brain cost as a closed form
   of (tiles, neurons, synapses, `maxSteps`, exec) — every allocation in `loadModel` is sized by the shape, never by
   the weight values — and `test_mem.mjs` holds it against the real bump allocator, whose mark is an exact
   high-water mark. They agree to 0.00%, and the test fails if a new allocation appears in `loadModel`. It
   independently reproduces this table (82.6 MB at `maxSteps` 100, 407.7 MB at 5,000). `maxStepsWithin(shape, budget)`
   is the bound a host needs; the frontend was bounding its capacity input by `TaskMarket`'s dispute-round limit
   instead, which for int-lif admits `maxSteps` 262,144 — **17.5 GB for one brain**. Those are different bounds and
   memory binds first by orders of magnitude, so the page now projects the real figure and refuses the impossible.

   **The male base is not the same size, and §4's two bases have to be priced together** (aigg-porw PR #11:
   `malecns-v1.0-min5`, 166,700 neurons, 6,242,118 records, 63.8 MB, 15,566 tiles). Priced with the model above:

   | brain | `maxSteps` 100 | `maxSteps` 5,000 |
   |---|---|---|
   | female `min5` | 83 MB | 408 MB |
   | male `min5` | **145 MB** | 534 MB |
   | male `min1` (the sampling base) | 439 MB | 829 MB |

   A tab holding one of each at short tasks is 227 MB before any individual — so `h` counted in *brains* hides that
   the two sexes are not interchangeable units. The male `min1` export exists to sample individuals from and is 439 MB
   resident on its own; if sampling has to happen in the tab rather than ahead of it, that is the number that decides
   whether a laptop can breed.
2. **First load.** 28 MB over the network before a tab can claim anything, once per base.
3. **Redundancy.** Still `N ≤ T · h / 2` in shape, with `h` now set by memory rather than seconds.

4. **Standing gas — and it binds before memory does.** To be eligible in epoch `e` an instance needs a materialized
   claim for `e−1` *per MEP*. *Measured* on anvil under v2: `materializeClaim` ≈ 285k gas, `postEpochRoot` ≈ 98k gas
   per MEP per epoch, `submitResult` ≈ 180k. At the *measured* 0.1 gwei and the testnet's 10-minute epochs (144 a
   day), keeping one brain continuously eligible on one instance costs 285k × 144 = 41M gas ≈ **0.0041 BNB a day** —
   the 0.05 BNB bond's worth in twelve days — and redundancy 2 doubles it per individual. For a 200-individual
   collection kept continuously eligible with two hosts each: ~1.6 BNB a day in materializations plus ~0.28 BNB a day
   in epoch roots, all of it currently the relayer's. The sponsorship guard already expresses this: its default
   budget of 1.5M gas per instance per epoch pays for **five** materializations and nothing else. In the gate run
   (three brains, six tasks in one epoch) 8 of 12 results were sponsored and 4 were refused and paid by the executors.
   So under sponsorship `h ≤ 5`, well below the memory bound — which is the quantitative case for "claims on demand"
   (item 3) and for item 2, and the number the mint fee's treasury share has to be set against.

   **Update — the first two fixes are in (aigg-porw "claims: one storage word per claim, one epoch root").** A claim
   on-chain is now a single word (a commitment; the contents go to the event log and a challenger passes them back),
   and the relayer posts one root per epoch over the claims of every MEP. *Measured:* `materializeClaim` 208,999 →
   59,643 execution gas (92k as a sponsored transaction, was ~285k); `postEpochRoot` 71,894 per MEP → 51,215 per epoch.
   The 200-individual example drops from ~1.9 BNB a day to ~0.5, and its root cost no longer depends on the collection
   size at all. In the gate run the default sponsorship budget now covers everything: 12 of 12 results sponsored,
   where 4 were refused before. What remains proportional to the number of brains is the materialization itself, which
   base-inherited eligibility (item 2) or materialize-when-selected would remove.

This is why item 2 below is still the one that matters, but for a different reason than before. It is no longer
about paying twenty dispute-commitment bills; it is about a tab holding twenty variants of one base as one 28 MB
payload plus twenty kilobyte deltas, instead of twenty resident payloads.

1. ~~Register brains with a large stride.~~ Obsolete: stride is a task parameter now and a claim does not commit
   anything per stride. A task still chooses it, and `postTask` bounds the dispute rounds it implies.
2. **Claim the base once, prove the delta.** Since `apply` is deterministic (and takes about a second for a
   procedural individual, so a variant need not even stay resident between tasks), residency of (base, delta) is
   residency of the variant, so one claim for the base plus a cheap proof of each delta would let a tab host a
   whole lineage from one payload. Still an upstream change to the claim scheme, still the highest-value one
   available.
3. **Claims on demand**, or a longer epoch — noting that with a lazy beacon the epoch length is now the cold-start
   latency, so it cannot be stretched freely.

## 6. Parameters

Proposed. Everything in the first group is a constructor immutable in the existing contracts and **cannot be
changed after deployment**; that is the point, and it is also the risk, because every one of them is a fixed
nominal amount in a volatile asset.

| parameter | proposal | note |
|---|---|---|
| `UNIT` | 0.05 BNB | one sortition vote; see §1 on its relation to `SLASH_AMOUNT` |
| `SLASH_AMOUNT` | 0.5 BNB | capped by the bond in practice |
| beacon `DEPOSIT` | 0.1 BNB | prices biasing one epoch's randomness; fixed while task value grows (§7) |
| `MINT_PRICE` | `UNIT` + fee | the fee is the treasury's only income |
| genesis size | to set against the §5 memory bound | the old ≤ 200 was a CPU figure and no longer applies; split between the two sexes, since a skewed ratio throttles breeding |
| `BREED_FEE` | to decide | the second sink, and the rate limit on new MEPs |

Not an admin key. The neighbouring project lets its owner change the mint price, the swap route and the buyback
recipient; that is a live hand on the economics. Immutable-with-known-flaws is a better failure mode than
mutable-at-will, and where something genuinely must change it should be governed explicitly rather than by an
owner address.

---

## 7. What to watch

**The beacon deposit is a fixed price on a growing prize.** The last revealer can withhold to reroll sortition
for the cost of 0.1 BNB. Today one epoch's fees are ~0.001 BNB, so it is over-collateralised a hundredfold. It is
also immutable, and task value is supposed to grow. When one epoch's extractable value approaches the deposit,
biasing becomes profitable and the deposit cannot be raised. That is the economic argument for the VRF adapter in
`DESIGN.md` §3 becoming necessary rather than optional — and it would also delete the beacon's share of the
standing gas cost.

**Every individual is an immutable on-chain MEP, forever.** Breeding without a cap grows that set without bound,
and §5 says the mesh cannot host an unbounded set — the ceiling is a tab's memory now, not its CPU, but it is
still a ceiling. The fee is the rate limit; choose it as one.

**Transfer and bond must stay separate.** The token is transferable; the bond belongs to an address, not a token.
Transferring an individual does not transfer the right to be slashed for it, and the new owner bonds themselves if
they want to run a node. Do not make "transferring a staked token" a state anyone has to reason about.

---

## 8. Still to decide

1. Breeding rule: (a), (b) or (c) from §4 — this blocks the contract. (c) is implemented and measured; the on-chain
   record (parents + seed) is the same for all three, so the contract need not wait for (b).
2. Genesis size and sex ratio, against the §5 bounds. The memory measurement is in (§5.1: ~25 resident brains per tab
   at short tasks); the tighter bound is standing gas (§5.4: five sponsored materializations per instance per epoch).
3. `MINT_PRICE` split between bond and treasury, and what the treasury may spend on.
4. Whether the token owner's share of task fees is a protocol rule or a social one.
5. Who exports the male base, and when. The source data (edges, annotations with `flywireType`, consensus
   neurotransmitters) is already prepared in the flyaudio project; what is missing is a `FLYBRAINv2` exporter for it.
6. Tile-local derivation. A procedural individual drops sub-threshold records and re-sorts, so tile `t` of a child
   depends on every record before it and a wrong declared `model_id` is self-punishing but not provable. Keeping
   dropped records in place as zero weights makes `child_tile[t] = G(parent tiles[t], seed)`, which admits a one-step
   fraud proof on a single record (the sampler's Q256 arithmetic is the EVM's word size). It fixes the payload layout,
   so it has to be decided before the first child is registered.
