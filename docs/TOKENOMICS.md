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

Recommendation: ship (a), specify (b), and treat the type table as its own piece of work.

---

## 5. The binding constraint is a browser tab, not storage or gas

The node runs in the user's browser, single-threaded (the page loads `sketch.wasm` and never passes a worker pool
to `PorwNode`; as of the worker refactor it runs off the main thread, but still on one core).

*Measured:* one residency claim for the real brain is **5.1 s** on a laptop. An epoch is 800 blocks ≈ **600 s**.

Where that goes is the surprise, and it decides what to do about it. Breaking a claim down on the real brain
(139,255 neurons, 2,700,513 synapse records, 100 steps, stride 10):

| phase | time | what it is |
|---|---|---|
| sketch | **11 ms** | the actual proof that the weights are resident |
| commit | 23 ms | the claim's own commitment |
| infer | 1,843 ms | the 100 LIF steps |
| **disputeCommit** | **5,033 ms** | **72%** — a Merkle tree over 139,255 state leaves at every stride boundary |

**Proving residency costs 11 ms.** The rest proves *execution*, so that a claim can be audited and disputed by the
same machinery a task is. Which means every instance pays, every epoch, for every brain it hosts, the full cost of
being ready for a dispute that will almost certainly never come.

The commitments are per stride boundary, and stride is `clampQ16` — a **per-MEP field chosen at registration**,
not a global immutable. So this is tunable today, per brain, with no contract change. *Measured,* same brain:

| stride | commitments | infer | disputeCommit | claim |
|---|---|---|---|---|
| 10 | 10 | 1,843 ms | 5,033 ms | **6.96 s** |
| 25 | 4 | 1,878 ms | 2,304 ms | 4.26 s |
| 50 | 2 | 1,871 ms | 1,388 ms | 3.34 s |
| 100 | 1 | 1,870 ms | 935 ms | **2.88 s** |

A **2.4× cheaper claim** for choosing stride 100 at registration. The cost moves to the dispute's refine phase,
where `postStepRoots` posts a 100-entry array instead of a 10-entry one — roughly an order of magnitude more gas
for that one move, paid once, by the two parties, in a rare event. Moving cost off the path everyone walks every
epoch and onto the path almost nobody walks is the right direction; the anvil dispute measured `postStepRoots` at
207,044 gas with stride 5, so even ten times that is small against what it buys.

So a tab hosting `h` brains spends `2.9h`–`7h` seconds of one core per epoch depending on stride. `h` of 3–5 is a
reasonable ask of a visitor's laptop; ten brains at stride 10 is seventy seconds every ten minutes and they will
notice.

With `T` tabs online, each hosting `h`, and redundancy 2, the number of individuals that can actually be claimed
every epoch is

> **N ≤ T · h / 2**

A hundred live tabs at four brains each supports about **200 individuals** at stride 10, or about **480** at
stride 100. Beyond that the extra members of the collection get no residency claims, so no task can be assigned to
them, so they are dead tokens.

This is the number that should set the genesis size and the breeding rate — not demand. Storage stopped mattering
when deltas landed; gas never mattered at 0.1 gwei; **attention-seconds of other people's laptops** is what is
scarce.

Three ways to buy room, in increasing order of how much has to change:

1. **Register brains with a large stride.** Available today, per MEP, 2.4×. Do this regardless.
2. **Claim the base once, prove the delta.** This is the one that matters for a collection. A tab hosting twenty
   variants of one base holds *one* 28 MB payload and twenty kilobyte deltas — but pays twenty full claims,
   because the claim scheme treats each variant as an unrelated model. Since `apply` is deterministic, residency
   of (base, delta) is residency of the variant, so one claim for the base plus a cheap proof of each delta would
   take `5.1h` seconds to `5.1 + ε`. That is an upstream change to the claim scheme, and it is the single
   highest-value one available — deltas created this inefficiency and deltas are what make the fix obvious.
3. **Claims on demand**, or a longer epoch — noting that with a lazy beacon the epoch length is now the cold-start
   latency, so it cannot be stretched freely.

Worth stating plainly for whoever picks this up: the claim is expensive because it is built as a miniature task
execution, so that the same audit and dispute machinery covers it. That is a coherent design, not an accident.
But if what a claim is *for* is residency, the 11 ms sketch already establishes that, and the other 6.9 seconds is
buying a property — disputability of the claim's execution — whose value should be weighed against being paid by
every tab, for every brain, every epoch, forever.

---

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
| genesis size | ≤ 200 initially (§5) | split between the two sexes; a skewed ratio throttles breeding |
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
and §5 says the mesh cannot host an unbounded set. The fee is the rate limit; choose it as one.

**Transfer and bond must stay separate.** The token is transferable; the bond belongs to an address, not a token.
Transferring an individual does not transfer the right to be slashed for it, and the new owner bonds themselves if
they want to run a node. Do not make "transferring a staked token" a state anyone has to reason about.

---

## 8. Still to decide

1. Breeding rule: (a) or (b) from §4 — this blocks the contract.
2. Genesis size and sex ratio, against the §5 bound.
3. `MINT_PRICE` split between bond and treasury, and what the treasury may spend on.
4. Whether the token owner's share of task fees is a protocol rule or a social one.
5. Who exports the male base, and when.
