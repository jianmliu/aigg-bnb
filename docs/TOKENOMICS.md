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

Five stakes, five different jobs. Only the first is the user's.

| who | how much | what it is |
|---|---|---|
| **instance** (a browser tab) | `UNIT` 0.05 BNB per sortition vote, capped at `MAX_WEIGHT` 16 | the real bond: slashable, exit delay. The Sybil cost |
| **beacon committer** | 0.1 BNB per epoch | not a stake — a revolving deposit, refunded on reveal, forfeited if you never reveal |
| **challenger** | `OPENING_DEPOSIT` 0.01 BNB | anti-griefing; the honest responder wins it |
| **replicator** (anyone who re-executes a settled task) | `CHALLENGE_DEPOSIT` 0.02 BNB, doubling per challenge the task has already thrown out | standing, not a bond: it opens the executors' bisection against a settled result for `CHALLENGE_WINDOW` blocks. Right: deposit back plus the slash of every executor that signed the wrong digest. Wrong: half to the defender, half to the sink |
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

**Update — "one action, one price" now holds.** This section promised that a mint leaves its minter owning an individual
*and* being a bonded instance, while the contract's own comment said `MINT_BOND` had to be 0 because `bond()` bonds
`msg.sender`. That was not a constraint of the design, it was a function nobody had written: upstream now has
`InstanceRegistry.bondFor(instance, mepIds)` (which `bond()` calls). A payer can only add to a bond; exit and withdrawal
remain the instance's own calls. `FlyCollection.mint` bonds `MINT_BOND` for the minter and enrols them for the base
brain's MEP in the same transaction (`contracts/test/FlyCollectionBond.t.sol`). Enrolling somebody else takes at least
one `UNIT` upstream, so `MINT_BOND` is 0 or ≥ `UNIT` — which is what `MINT_PRICE = UNIT + fee` already meant. The same
call is what a breeding endowment for a child's owner would use.

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

Where the seed comes from is not a detail. `breed` does not make it: anything one transaction can read — a past
blockhash, the supply — the caller can read first, so a seed made at breeding could be simulated and the transaction
sent only when the answer suited (the sex is one bit of it). `breed` records the parents and a **seed block**, the one
after the block it lands in; `hatch(id)`, which anyone may call and which takes no input, turns that block's hash into
`seed = keccak(deltaHash_A, deltaHash_B, a, b, id, blockhash)` and the sex. The page can show the child a block after
breeding; until `hatch` lands it is `UNHATCHED` and cannot be registered, and a bred individual cannot itself breed
until it is registered, so both deltas are pinned before they go into a seed.

The EVM keeps 256 block hashes (about three minutes on BSC), and that expiry is the one lever left to a grinder: read
the hash off-chain, dislike it, wait it out. Two rules take it away. `HATCH_BOUNTY`, a part of `BREED_FEE` held by the
collection, is paid to whoever hatches, so hatching is a race from the first block it is possible and the grinder has
to win it against everyone for 256 blocks running — the relayer is the obvious standing entrant. And `rearm`, the only
way forward for an expired egg, costs a whole `BREED_FEE`: a new block is a new draw, priced like the breeding it
replaces. The threat model is the breeder, not the chain: a BSC block producer colluding with a breeder over one
individual's seed is out of scope, which is what buys hatching in seconds instead of an epoch. (The mesh's own epoch
beacon was implemented first and replaced for exactly that wait; it or a VRF would slot into `hatch` without changing
the on-chain record, if that assumption ever stops being comfortable.)

One honest boundary for whichever rule ships: the left/right differences the noise model is fitted to are
developmental noise under one genotype, not heritable variation. Treating an individual's realised noise as heritable
is a modelling choice; the heritability of synapse counts in Drosophila has not been measured.

**Update — the trust gap of "record the recipe, declare the result" is closed (`contracts/src/LineageRegistry.sol`).**
§3 and the `breed` comment call a wrong declared `model_id` self-punishing rather than trustless. With the in-place
layout (aigg-porw `proposals/flydelta-inplace`) a declared payload can be contradicted from one record, and the registry
makes the declaration accountable: `register(delta, model_id)` posts a bond and opens a challenge window;
`challengeRecord` / `challengeStatic` run aigg-porw's `FlyDeltaRecordVerifier` on a few 4 KB tiles (*measured:* 231k
execution gas for a fraud verdict with four tiles opened), strike the registration down and split the bond between the
challenger and a sink — half, so that a registrant cannot squat a recipe by striking down its own wrong claim for free.
An unchallenged registration becomes final, the bond returns, and only then can a child name it as a parent: a child's
check reads its parents' committed tiles, so lineages become final one generation at a time. A base is not declared but
proven from its first tile. `FlyCollection.registerDerived` binds a token to a MEP only through a *final* registration,
and for a bred token the recipe is not the owner's to choose: it must carry the seed drawn at breeding and name the
recorded parents — a true cross when both sit on one base, dam × base with the sire inside the seed otherwise.
What stays optimistic: a wrong claim nobody challenges within the window becomes final. The window and the bond are
immutable constructor parameters and should be sized against how long a watcher needs to rebuild a payload (seconds) and
what a fraud proof costs (well under 0.001 BNB at 0.1 gwei).

Recommendation (revised): ship (c) with the other-sex parent as entropy, specify (b) as the projection that later
replaces that entropy, and treat the male base export as the prerequisite it is. (Original: ship (a), specify (b).)

---

## 5. The binding constraint is memory, not CPU or storage or gas

The node runs in the user's browser, single-threaded (the page loads `sketch.wasm` and never passes a worker pool
to `PorwNode`; as of the worker refactor it runs off the main thread, but still on one core).

This section used to say a residency claim cost **5.1 s** and that CPU was the scarce resource. Scheme
`sketch-tile-keccak:v2` removed the reason for that (the current scheme is `:v3`, which additionally drops the claim's
self-declared `deviceId`). Breaking the old claim down on the real brain
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

   | brain | `maxSteps` 100 | `maxSteps` 5,000 | |
   |---|---|---|---|
   | female `min5` | 83 MB | 408 MB | |
   | male `min5` | **145 MB** | 534 MB | |
   | male `min1` | 439 MB | 829 MB | *not hosted — it is `applyDelta`'s input, see below* |

   A tab holding one of each at short tasks is 227 MB before any individual — so `h` counted in *brains* hides that
   the two sexes are not interchangeable units.

   **Sampling is a mint-time step, off-line** (decided), so `min1` is never a hosted MEP and that row is not a hosting
   cost — it is the input to `applyDelta`. And the collection is **two bases and N deltas**, so what gets published
   per individual is the 202 bytes, not a payload. At the sizes this is aiming for the alternative is not close:

   | N individuals | publish each payload | publish two bases + N deltas |
   |---|---|---|
   | 200 | 12.8 GB | 514 MB + 40 KB |
   | 1,000 | 64 GB | 514 MB + 202 KB |

   Two *hot* objects that every tab fetches and an edge cache serves once, against N cold ones fetched by one tab
   each. That is §2's argument and at these N it is not a trade-off.

   **What it costs is paid by the tab, not the CDN, and §5.1's table does not contain it.** *Measured* (this host,
   one thread, `FLYDELTAv2` apply at the male base's neuron count): 2.5 s at 6.0 M records, 4.7 s at 12.0 M — linear,
   so **~10 s at `min1`'s 25.6 M records**. (Consistent with §2's 0.9 s, which is the same apply over the female
   `min5` base's 2.7 M records.) And `applyDelta` takes the base as a JS `Uint8Array`: the base sits in the **JS
   heap**, outside the wasm memory `mem.js` prices, and a tab that hosts more than one individual keeps it there
   rather than re-fetching 257 MB per individual. So the real budget for a tab hosting `h` individuals of one sex is

   > **257 MB of JS heap (the base) + 145·h MB of wasm + 10·h s of startup**

   and one of each sex is 514 MB of JS heap before any individual. That is stricter than the table above, not looser,
   and it is the shape of the cost that suggests the fix: see item 2 below.
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

   **Update — the validity window is in (`CLAIM_VALIDITY_EPOCHS`).** A valid claim now keeps its instance eligible for
   `k` epochs, set once at deployment; eligibility is a single storage read for any `k`. *Measured on anvil
   (`test/e2e_validity.mjs`, `k = 3`):* one sponsored materialization (113k gas the first time an instance claims a brain,
   ~97k afterwards) keeps the instance eligible and drawn in epochs 2, 3 and 4; it ages out in epoch 5; the relayer
   sponsored one materialization across four epochs. The node page reads `k` from `/deployment` and materializes only when
   its standing would lapse next epoch. With `k = 6` (one hour at 10-minute epochs) the 200-individual example is ~0.09 BNB
   a day, down from ~1.9. What `k` trades away is how often residency is proven, not what is paid for: an instance that
   dropped its model inside the window times out on its task, and a residency fraud verdict ends its standing for the whole
   window at once.

Items 2 and 3 below are both about the same fact — a tab holds one base and many deltas — and item 2 is now the
near one: it is a change to where `applyDelta` runs, not to the claim scheme.

1. ~~Register brains with a large stride.~~ Obsolete: stride is a task parameter now and a claim does not commit
   anything per stride. A task still chooses it, and `postTask` bounds the dispute rounds it implies.
2. **Apply in wasm, not in the JS heap.** The base is already the one payload a tab keeps for a whole lineage, but
   `applyDelta(baseBytes, deltaBytes)` takes it as a JS array and returns another, so the path is: base in the JS
   heap (257 MB, kept), applied bytes in the JS heap (64 MB, transient), then a copy into wasm. Putting the base in
   wasm once and applying there removes both JS copies, and — the part that matters for this section — it makes the
   base something `mem.js` prices instead of something invisible to it. No scheme change, no new on-chain artefact.
3. **Claim the base once, prove the delta.** Since `apply` is deterministic (and takes about a second for a
   procedural individual over the female base, so a variant need not even stay resident between tasks), residency of
   (base, delta) is residency of the variant, so one claim for the base plus a cheap proof of each delta would let a
   tab host a whole lineage from one payload. An upstream change to the claim scheme, and the one with the most
   behind it.
4. **Claims on demand**, or a longer epoch — noting that with a lazy beacon the epoch length is now the cold-start
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

What these two are really buying is in §9: a mint is what pays for measuring the individual it creates.
| `ROYALTY_BPS` | 1000 | of every fee settled for a task on a registered fly; inside the `mep_id`, so fixed for the collection's life |
| `BASE_SHARE_BPS`, `BASE_VENDOR` | 1000, the treasury | the base's part **of the royalty**, not of the fee: of a fee of 1 the hosts share 0.90, the owner gets 0.09, the base 0.01. One level -- it does not compound down a pedigree -- and the vendor is the treasury until a base has one of its own (docs/GATEWAY.md §4.1) |
| `TREASURY` | a `TreasuryRouter` | immutable in the collection, and a collection outlives any wallet, multisig or buyback scheme: so it is a fixed address whose *destination* can change. Not a proxy -- no delegatecall, no replaceable logic; everything it holds can leave only to the destination, which is why `sweep` / `collect` / `rescue` are anybody's to call. Its owner chooses the destination (two-step; renounceable) and reaches nothing else. `receive` does no work: the collection caps the gas it hands its treasury and credits what it will not take, and work belongs to the destination |
| `SALE_ROYALTY_BPS` | 500 | ERC-2981, to the treasury: what a marketplace is *asked* to pay on a resale. No venue is bound by it and a plain transfer pays nothing, which is why it is a different thing from the royalty the protocol enforces. Capped at 10% |

Not an admin key. The neighbouring project lets its owner change the mint price, the swap route and the buyback
recipient; that is a live hand on the economics. Immutable-with-known-flaws is a better failure mode than
mutable-at-will, and where something genuinely must change it should be governed explicitly rather than by an
owner address.

The collection does have an `owner()`, because marketplaces hand the collection's page to whoever that names. It has
one power: choosing the contract that draws a token (`tokenURI`; the first one, `FlyRenderer`, is on-chain and needs no
server). Not a price, a rate, the treasury, the genesis set or anybody's fly. It moves in two steps and can be
renounced, which freezes the renderer. A renderer that reverts or burns its gas takes the picture down, never the token.

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
2. Genesis size and sex ratio, against the §5 bounds. The memory measurement is in (§5.1) — but read it as the
   per-tab budget for *individuals*, `257 MB of JS heap + 145·h MB of wasm`, not as the ~25-brain figure, which
   counts only wasm and predates the decision that individuals arrive as deltas. The tighter bound either way is
   standing gas (§5.4: five sponsored materializations per instance per epoch).
3. `MINT_PRICE` split between bond and treasury, and what the treasury may spend on.
4. ~~Whether the token owner's share of task fees is a protocol rule or a social one.~~ A protocol rule, in two
   halves. aigg-porw's MEP **terms** (`registerMEPWithTerms`) put a beneficiary and a rate inside the `mep_id`, and
   `TaskMarket._pay` sets that share of every settled fee aside before the executors split the rest. `FlyCollection`
   is the beneficiary of every individual's MEP and forwards: `settle(id)` credits the token's *current* owner, a
   transfer settles to the seller first, `withdraw()` is the owner's own call. So there is no royalty before adoption
   (an unadopted individual has no MEP, and the base brains are plain profiles), it starts when the owner registers
   the brain, and a sale needs no address update because the address on-chain never was the owner's. What is left to
   decide is the number: `ROYALTY_BPS` is immutable and inside every id. It does not have to be priced against a
   royalty-free copy of the same bytes. The MEP registry is permissionless, so such a copy can always be registered --
   but the system has a **whitelist, and its unit is the collection** (`CollectionWhitelist`), the way a marketplace
   verifies a collection rather than its items. A listed collection answers for its own brains
   (`FlyCollection.listed(mepId)`): its bases and every brain bound to one of its tokens. So a bred fly is recognised
   automatically when its owner registers it -- it is a token of a recognised collection like any other -- while a
   collection somebody deploys for themselves, or a MEP registered with no collection at all, is not; then the page does
   not show it, the relayer does not aggregate claims or sponsor gas for it, and the dataset does not count what is run
   against it. The list has a curator, the first admin in these contracts, and its power stops at the list: removing a
   collection un-recognises it and touches no token, bond, royalty or settled task. The job is handed over in two
   steps or renounced, which freezes the list.
5. ~~Who exports the male base, and when.~~ Done: aigg-porw PR #11 (`malecns_export.py`, Janelia MaleCNS v1.0 as
   `FLYBRAINv2`; `min5` 6.24 M records / 63.8 MB, `min1` 25.58 M / 257 MB). One thing it raises for §4: the exec kind
   pins a single weight unit calibrated on FlyWire counts, and this dataset reports more synapses per connection, so
   the male brain is markedly more excitable under the same exec kind. A per-dataset weight unit is a **new exec
   kind** — which under scheme v2 means a different `mep_id` family and its own residency set, since `execKind` is
   bound into the id. That fragmentation is correct here (two different computations), unlike the step-count
   fragmentation v2 removed.
6. ~~How an individual reaches a host.~~ Decided: two bases and N deltas, so the base plus the 202 bytes, applied in
   the tab (§5.1). What is left of it is an implementation question, not a design one — §5's item 2, moving the apply
   into wasm so the base stops being 257 MB of JS heap that nothing prices.
7. ~~Tile-local derivation.~~ Decided and implemented upstream (in-place layout, one-record verifier) and here
   (`LineageRegistry`). What is left to decide: `REGISTRATION_BOND`, `CHALLENGE_BLOCKS`, the sink, and whether the
   breeding fee should sit in the registration bond while the claim is at risk. Original text: Tile-local derivation. A procedural individual drops sub-threshold records and re-sorts, so tile `t` of a child
   depends on every record before it and a wrong declared `model_id` is self-punishing but not provable. Keeping
   dropped records in place as zero weights makes `child_tile[t] = G(parent tiles[t], seed)`, which admits a one-step
   fraud proof on a single record (the sampler's Q256 arithmetic is the EVM's word size). It fixes the payload layout,
   so it has to be decided before the first child is registered.

---

## 9. Who pays for the atlas, and what a measurement costs

Measured, not assumed. One battery run of the real brain (`flywire-783-min2`, 139,255 neurons, 7,595,967 synapses;
5,000 steps, commit stride 500) in the wasm node on one core of an M-series Mac:

| | |
|---|---|
| one run | **32.3 s** (30.6 s of it the simulation, 1.6 s the segment commitments), 196 MB resident, 377 MB while loading |
| one individual's standard battery (13 stimuli × 3 seeds = 39 runs) | **21 minutes of CPU** per host — 42 at redundancy 2 |
| its fee at 0.1 gwei per step per provider | 195,000 steps × 2 × 10⁻¹⁰ = **0.039 BNB** |
| its gas | one `postBatch` + one `settle` for all 39 runs: ~0.00004 BNB, three orders of magnitude below the fee |
| what a mint puts in the treasury | `MINT_PRICE − MINT_BOND` = **0.05 BNB** (the bond is the minter's own stake, and stays theirs) |
| what a breed puts in | `BREED_FEE − HATCH_BOUNTY` = **0.049 BNB** |

**So a mint buys, almost exactly, one measurement of the individual it creates.** At the breeding study's scale — 301
individuals, 11,739 runs — the compute costs about 11.7 BNB, and 100 adoptions plus 201 breedings bring in about 14.8.
The atlas is funded by the people who adopt and breed the flies, not by the project: **the treasury is a conduit**, and
the project is the task client only in the sense that it spends what adopters put in.

### Where the price comes from, and where it does not

The 0.1 gwei per step per provider is **derived from the budget, not from the cost**: it is what the atlas can pay per
row if a mint is to cover an individual's battery. Against the cost of the compute it is very high — 0.0195 BNB per
host per battery is **0.056 BNB per CPU-hour**, some three orders of magnitude above what an ordinary cloud core costs.

That is a choice, not an error: a host must be paid enough to bother keeping a brain resident, and early on the price
has to be generous. But it should be said plainly, because two things follow. First, hosting is profitable long before
it is efficient, so the margin is where competition will show up. Second, the headroom is large enough to spend on
**redundancy** instead of profit: three or five independent providers per row, at the same total price, buys more
agreement than a fatter margin does.

**The invariant to keep.** `MINT_PRICE − MINT_BOND ≥ steps × runs × redundancy × p(model)` for the standard battery:
a mint must cover the measurement of the individual it creates. It holds today (0.05 against 0.039) with about 20%
spare. Change the price, the battery's size or the redundancy and the other side has to move with it, or the collection
sells individuals it cannot afford to measure.

### The circle, and what opens it

While the project is the only task client, the money goes: minters → treasury → task fees → hosts (and a royalty back
to the individuals' owners). A holder's royalty is therefore, today, a rebate of other minters' money. **This is
disclosed, not hidden** — the paper says it, and so does the page. The circle opens when fees arrive from outside:
that, and not the token, is what the gateway (docs/GATEWAY.md) is for. Until then the atlas has a budget, not a
revenue: 100 founders sell once, and breeding is what continues it.

### What it means for a call's latency

A real battery task is 5,000 steps: half a minute of CPU per provider on one core, less with a worker pool, and about
three times less on the ≥ 5-synapse export. A host's page sizes its slot for 100 steps by default; an individual's
battery needs 5,000, which is why `GATEWAY_MAX_STEPS` and what the hosts load have to be raised together.
