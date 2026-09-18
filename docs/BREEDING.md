# Breeding: the economics, and the page

Reference: **Immortal Fruit Flies** (`immortalfruitflies.app/docs`) — on-chain flies on BNB Chain, 263 brain
weights per animal, per-weight 50/50 inheritance with ~2 % mutation, traits read off weight ranges, 0.01 BNB to
mint and 0.005 BNB to breed, every fee routed through PancakeSwap into a buyback. It is a well-built version of
a mechanic that has been proven to work, and most of it does not transfer. This document is about which parts do,
which parts cannot, and what replaces the rest.

---

## 1. The one structural difference everything follows from

The reference's genome is **263 floats**. A child's weights are known the instant the transaction lands, its
traits are a table lookup, and the picture renders immediately.

Here the genome is a **FLYDELTAv1 delta over a 2,700,513-record connectome**. `FlyCollection.breed` records the
*recipe* and nothing else:

```solidity
bytes32 seed = keccak256(abi.encode(A.deltaHash, B.deltaHash, a, b, blockhash(block.number - 1), totalSupply));
individuals[id] = Individual({ baseModelId: dam.baseModelId, deltaHash: 0, modelId: 0, mepId: 0, … seed: seed });
```

`deltaHash`, `modelId` and `mepId` are all zero. They stay zero until somebody **applies the derivation to
28 MB of base payload off-chain** and calls `register`. So a newborn here is not a picture that appears; it is a
computation that somebody has to perform before the animal exists in any usable sense.

Two consequences, and they are the whole design:

- **Breeding creates work.** There is a gap between the transaction and the animal, and the gap is exactly the
  kind of work the contribute-compute path already attracts: a tab with the base resident can close it.
- **Nobody knows what the child is.** Which brings us to §3.

---

## 2. Liveness is residency, and it is already on-chain

The reference gives flies death and revival: a body dies, the brain persists, a fee reinstantiates it. That
mechanic is doing real work — it creates an ongoing reason to care — and here it needs no invention, because the
protocol already has the state.

An individual is **alive in the only sense that matters when at least one instance holds it resident and claims
residency for it**. `InstanceRegistry.isEligible` requires `hasValidClaim(instance, mepId, epoch - 1)`, and
`TaskMarket.executors` draws only from eligible instances. A MEP nobody hosts has no eligible executors, so no
experiment can be run against it. The fly is not dead; it is **dormant** — the brain is still pinned by
`model_id`, the lineage is still on-chain, and one tab choosing to host it brings it back in one epoch.

This is better than a death fee, because it is not a fee at all: keeping a fly alive costs *attention and
memory*, which is the resource the network actually needs, and reviving one costs nothing but somebody deciding
to host it. It also gives the owner a reason to care about the compute path: your fly is alive exactly as long
as somebody runs it, and the cheapest somebody is you.

**Surface it as a first-class status**, computed per epoch: `alive` (claims this epoch) / `dormant` (none) /
`unborn` (bred but not yet registered — §1).

---

## 3. Rarity cannot be declared at birth; it has to be measured

In the reference, a trait *is* a weight range: `Ebony body ~2 %`, `White eyes ~1 %`. Rarity is legible the
moment the child exists, which is what makes the loop work — you breed, you see immediately whether you won.

There is no equivalent here and no honest way to fake one. The child of two whole connectomes is 2.7 M records;
"what it is" means things like *DNge145 fires 3.6 spikes per 100 ms under gate drive instead of 0.0* — which is
precisely the claim `tasks/flywire-gate/` establishes, and it takes **six 5000-step whole-brain runs** to
establish it. A child's phenotype is not a lookup. **It is a task posted against the child's MEP.**

That is not a weakness to be worked around; it is the product. The economic loop the reference gets from rarity
tables, this one gets from the experiment:

> breed → gestate (someone computes the child) → host (someone keeps it alive) → **post an experiment to find
> out what it is** → the result is a settled, replicable fact about an animal you own

Every arrow there is a fee to someone who did work, and the last one is the only mechanism in either design that
produces something outside the game. What a fly is worth is what has been *measured* about it, and the measuring
is public, replicable and dated. Bloodlines still concentrate — a child inherits its dam's base and a delta
derived from both parents — but a lineage becomes desirable because of results posted against it, not because a
table said 1 %.

**Page consequence:** a fly's profile is a lab notebook, not a trait card. Parents, generation, delta size,
model_id, and then *the experiments run against it* with their digests and links.

---

## 4. What `BREED_FEE` has to price

**Charging for breeding is right, and it is more clearly right here than in the reference.** An NFT mint's
marginal cost is a row in a mapping; the fee is there to create scarcity where physics creates none. Breeding
here has a genuine marginal cost and somebody else pays it. A new individual is **a new MEP**, and a new MEP
needs at least two bonded instances holding ~408 MB each (at 5000-step capacity) for the cross-check to mean
anything, a residency claim per instance per epoch, and sponsored gas out of the relayer's budget. Volunteer
memory is finite and unbounded MEP creation runs against it, so the fee is doing three jobs at once: correcting
an externality, rate-limiting an unbounded action against a bounded resource, and acting as one of the two sinks
against the faucet of task fees (`docs/TOKENOMICS.md` §1).

There is an owner-side argument too, and it is the one worth making to anyone who finds the fee unwelcome: free
breeding is worse *for the flies that already exist*. Every new MEP competes for the same scarce host attention,
so an unpriced population inflates into one that is mostly dormant — and a dormant individual is one nobody can
run an experiment against, which is the entire thing being owned. The fee protects the value of what is already
in the colony.

So the question is not whether to charge. It is where the money goes, and today the answer is: all of it to the
treasury.

```solidity
(bool ok,) = TREASURY.call{value: msg.value}(""); require(ok, "treasury");
```

**That makes it a tax rather than a price.** The costs the fee corrects for are borne by the gestator who
computes the child and by the hosts who hold it resident; the treasury is neither of them. Paying the treasury
for a burden imposed on hosts limits the rate but never clears the market — the child is still dead on arrival,
the breeder has still paid, and nobody who absorbed the cost has been compensated. Routing the same money to
the parties actually bearing the cost turns the same number into a price. If anything it argues the fee should
be **higher** than a pure sink would need to be, because now it is buying the child something specific.

**Proposed split**, in the order the child needs the money:

| slice | to | why |
|---|---|---|
| **gestation bounty** | whoever applies the derivation and hands the owner the delta + `model_id` | §1's gap, priced. It is a one-off ~10 s of wasm plus the base in memory, so it should be small — but it should not be zero, because it is the step between a token and an animal |
| **residency endowment** | a host bounty for the child's first `K` epochs | the child has no task fees yet, so nothing pays anyone to hold it. This is what stops every newborn being dormant on arrival, and it is the slice that decides whether generation 2 exists at all |
| **treasury** | the relayer's sponsorship budget | as today. `docs/TOKENOMICS.md` §1: the relayer subsidises everyone and takes nothing |

Note the ordering is not a preference, it is a dependency: a child that is never gestated cannot be hosted, and
one that is never hosted cannot be experimented on, and an individual nobody experiments on is the thing this
whole design is trying not to produce.

Two of those three slices go to **people who ran something** — the gestator once, the hosts per epoch — and one
goes to the treasury, which is where the relayer is paid from. That is the whole shape: the fee buys compute,
and the treasury keeps the thing that sponsors everyone's gas alive.

### The endowment is a runway, not life support

`K` epochs of host bounty buys exactly `K` epochs. When it is spent, whether the individual stays alive depends
on whether anyone still thinks it is worth holding — and if nobody does, **it goes dormant, and that is the
correct outcome, not a failure to engineer around.** Nothing in the protocol promises to keep a fly running. The
endowment exists for one specific reason: a newborn has no results yet, so there is nothing for a host to earn
from it, and without a bridge every child would be dormant on arrival and generation 2 would never happen. It is
cold-start funding, and it should be sized as a bridge rather than a pension.

What makes that acceptable rather than harsh is that dormancy here is **soft and free to reverse**. The brain
is still pinned by `model_id`, the lineage is still on-chain, and one tab deciding to host it brings it back
within an epoch. So the runway's job is to last until the individual has enough measured results that task fees
make hosting it worth doing on its own — after which the bounty is redundant. A fly with interesting results
finds hosts; a fly with none goes to sleep. That is the population dynamic the design should want, and it is
also the honest one to tell an owner before they pay.

### One attack this opens, and it connects to an earlier finding

Paying per residency claim makes the claim itself worth money for the first time, and that turns a weakness
noted in `docs/TOKENOMICS.md` §3b from theoretical into a direct drain. The sweep's seed is
`deriveSlotSeedKeccak(globalChallenge, deviceId)`, `globalChallenge` is `keccak(beacon || mepId)` — the same for
everyone hosting that child — and `deviceId` is **self-declared and never checked on-chain**. The honest client
derives it per key, but nothing requires that: one `deviceId` across `N` addresses is one sweep, `N` identical
`partialsRoot`s, `N` valid claims, and the endowment drains `N` times as fast.

The bond is a cost per address, so this is not free — but the endowment is the first mechanism that pays a
return on it, which is exactly when a Sybil bound stops being theoretical. Three mitigations, in increasing
order of how much they fix:

1. **Cap the payees per epoch** at the redundancy the child actually needs (two). More resident copies than that
   buy the network nothing, so paying for them is pure waste even without an attacker.
2. **Choose the payees by sortition** over eligible instances, using the same beacon the rest of the protocol
   uses, so which two get paid is not the attacker's choice.
3. **Seed the sweep from the claiming instance** — replace `deviceId` with the instance address in
   `deriveSlotSeed`, and delete the field (`docs/TOKENOMICS.md` §3b). This is the actual fix: `N` identities
   cost `N` sweeps. Nothing is deployed, so there is no migration to pay for — which makes it cheaper to do now
   than to do it as a `require` later, and much cheaper than discovering it after an endowment exists.

(1) and (2) are local to the collection contract and sufficient to ship; (3) is what makes residency mean
something on its own, and it should be decided before, not after, residency starts paying.

**Implementation note.** `register` is owner-only, deliberately — "so nobody can bind someone else's individual
to a dead MEP". So the gestation bounty should be *escrowed by `breed` and released by `register` to an address
the owner names*, not paid to whoever calls `register`. The owner still decides who gestated their child; the
money is merely earmarked, and no new trust is introduced.

**A number that is derived rather than borrowed.** With the split above, `BREED_FEE` stops being a
market-feel guess and becomes an identity:

```
BREED_FEE  =  gestation bounty  +  K x host bounty  +  treasury margin
```

— the price of the one-off compute, plus the cost of keeping the child alive for its first `K` epochs, plus
whatever the treasury needs. Each term is measurable: the gestation is ~10 s of wasm against a resident base,
and the host bounty is answerable from what an instance already spends per epoch on a claim. Copying the
reference's 0.005 BNB would be borrowing a number from a design whose child costs nothing to bring into
existence.

**And it probably inverts the reference's ordering.** There, breeding (0.005) is deliberately cheaper than
minting (0.01), to encourage reproduction inside established colonies. Here the two differ in a way that points
the other direction: adoption is *designed to fund a bond* — `MINT_BOND` is bonded for the adopter, so an
adopter arrives as a host and brings residency with them — while **breeding brings no host at all**. Per new
MEP, breeding is the action that leaves the mesh worse off, so on the residency dimension it should cost more,
not less. (With the caveat from §7: `MINT_BOND` must be 0 until upstream `bondFor` exists, so today neither
action brings a host, and this is an argument about the design as intended rather than as deployed.)

**Not proposed: a buyback.** The reference routes every fee through PancakeSwap into `$FLY` and forwards the
tokens to a public wallet. That is a recruitment engine and it plainly works, but it is the opposite posture to
`docs/TOKENOMICS.md` §6 — no admin key, no owner-settable swap route, immutable-with-known-flaws over
mutable-at-will — and it would make the treasury's income depend on a market rather than on the mesh. It is
worth being explicit that this is a *choice*, and that the cost of the choice is real: **this design has no
recruitment loop at all**, and should borrow the reference's other one instead (§6, birth cards).

---

## 5. Rate limiting: the fee is the only brake

`docs/TOKENOMICS.md` §6 lists `BREED_FEE` as "the second sink, and the rate limit on new MEPs". Worth stating
what it is limiting against: every live MEP consumes residency across the mesh, and §5 of that document prices a
tab at `257 MB of JS heap + 145·h MB of wasm`. Breeding is unbounded MEP creation against a bounded amount of
volunteer memory.

Two options:

- **Fixed fee.** What the contract has. Simple, immutable, legible — and wrong at exactly one moment: when the
  mesh is small and a breeding wave outruns it, every new fly is born dormant and the population looks dead.
- **Congestion-priced fee**, a pure function of on-chain state — live MEPs against eligible instances, say —
  which keeps the no-admin-key property while making the brake adaptive. `breedFee = BASE · f(activeMEPs /
  eligibleInstances)`.

The second is more honest about what is being rationed, and it is still immutable. It is also more complex and
easier to get wrong, and the first is fine while the mesh is one order of magnitude bigger than the population.
Recommendation: **ship fixed, instrument `activeMEPs / eligibleInstances`, and only move if that ratio goes
above 1.**

---

## 6. The page

Same visual language as the node console (`frontend/src/styles/`), same rule: numbers are monospace, state that
changes gets colour, nothing decorative.

**`/flies` — the colony.** A grid of the individuals this wallet owns. Each card: name, generation, sex, a
lineage crumb (`#41 ♀ · gen 3 · ♀12 × ♂27`), the delta size, and a **status chip** from §2 —
`alive · 2 hosts` (green) / `dormant` (amber, with "host it" as the action, which is the node console's own
flow) / `unborn` (cyan, with "gestate" — see below). No trait badges, because §3.

**`/breed` — the pairing.** Two slots, female and male, from the flies you own or are approved for; the contract
requires `A.sex != B.sex` and the child takes the **dam's base**, so the page says which base the child will
vary before the transaction, not after. Below the slots, the fee breakdown from §4 as three lines, because
someone about to spend money should see that part of it is buying their child a host. The button is
**"Breed"**, and what it produces is a recipe, which the page must say plainly: *this creates the child's
lineage entry; it does not yet create its brain.*

**The gestation queue — the part with no equivalent in the reference.** Every individual with
`deltaHash == 0` is a child whose recipe is on-chain and whose brain nobody has computed. This is a public
queue, not a private one: anyone holding the base can apply the derivation. For an owner it reads "your child is
waiting to be computed"; for a node operator it reads "there is a bounty here and you already have the base in
memory". It is the single best on-ramp the compute path has, because the work is small, the reward is concrete,
and the output is a named animal rather than a digest.

**`/fly/<id>` — the lab notebook.** Lineage tree upward and downward; `model_id`, `mep_id`, delta size, base;
residency history by epoch; and then the experiments: every task posted against this MEP with its stimulus set,
its settled digest, its executors, and whether anyone replicated it
(`docs/REPLICATOR-STANDING.md`). That list, not a trait table, is what the animal is worth.

**Birth card.** The one mechanic to take from the reference wholesale, because §4 removed the buyback loop and
left nothing in its place. A shareable card for a newborn — parents, generation, seed, and once it is gestated,
its `model_id`. Unlike the reference's, it can carry something real as soon as the first experiment settles: a
measured number about a specific animal.

---

## 7. What this needs before any of it is wired

1. **`FlyCollection` is not deployed and is not in `/deployment`.** The relayer publishes
   `verifier, meps, instances, beacon, claims, market, disputes, relays` — no collection address. The page cannot
   read a single fly until that exists.
2. **The breeding derivation is still open** — `docs/TOKENOMICS.md` §8 item 1, options (a) pairing-as-entropy,
   (b) pairing-as-projection, (c) implemented and measured. Nothing in this document depends on which; §1's gap
   exists under all three, and §4's split is derived from the gap, not from the genetics.
3. **`MINT_BOND` is blocked on a function that does not exist yet**, per `FlyCollection`'s own note: `bond()`
   bonds `msg.sender`, so a contract cannot bond on a user's behalf, and until `InstanceRegistry.bondFor` exists
   `MINT_BOND` must be 0 — which means an adopter bonds separately and the "one action, one price" story in
   `docs/TOKENOMICS.md` §3 is simply not true. Since nothing is deployed, this is not a constraint to design
   around: **add `bondFor(address instance, bytes32[] mepIds) payable` upstream and have `bond()` call it.** It
   is a few lines, the payer can only ever increase someone else's bond (exit is still the instance's own call),
   and it turns adoption from two transactions into the one the design promises. The same call is what would let
   a breeding endowment bond on a child's behalf, so it is load-bearing twice.
