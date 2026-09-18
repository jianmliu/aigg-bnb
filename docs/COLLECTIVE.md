# The first task, and what it takes to run a thousand of them

The first experiment is published: `tasks/flywire-gate/` on `main`, sourced from `jianmliu/flyaudio`
(`tasks/mesh-first-task`). This document is about what it already proves, and what breaks between six runs and
the thousands of whole-brain runs the scientific claim actually wants.

> **Correction.** An earlier draft of this file was written before `tasks/flywire-gate/` was in view and assumed
> the first experiment was a *coupled* swarm — many brains whose outputs feed each other. It is not, and one of
> that draft's central claims was wrong. It said the entire exogenous input to a brain is a single `uint32`.
> §2 is what is actually true, and it matters, because the mechanism that draft went looking for is already
> there.

---

## 1. What the first task is

Six tasks: **three models × two stimulus sets**. Each task is one whole-brain run of the FlyWire v783 female
connectome — 139,255 neurons, 2,700,513 ≥5-synapse records — under `aigg:exec:int-lif:v1` for 5000 steps
(0.5 s of brain time), stride 500, `stimulusSeed` 7, redundancy 2.

| | model | stimulus | DNge145 (spikes / 100 ms) |
|---|---|---|---|
| 1, 2 | full | joLR → joLR+gate | 2.8 → **0.0** |
| 3, 4 | ablate4 (the 4 direct gate→DNge145 records removed) | joLR → joLR+gate | 2.8 → **3.6** |
| 5, 6 | keep4 (only those 4 records kept) | joLR → joLR+gate | 2.8 → **0.0** |

The claim is the pattern, not any one number: driving the two AN_multi_8 gate cells silences DNge145; removing
four synaptic records abolishes the silencing; keeping only those four preserves it. Rows 1, 3 and 5 are the
built-in control — without the gate drive all three models produce the *same* digest, because the edited records
never carry a spike.

Two of the three models ship as **FLYDELTAv1 deltas of the base**: 169 bytes and 4.7 KB against a 28 MB payload.
A node that holds the base applies the delta and arrives at the registered model id. That is the "two bases and
N deltas" design from `docs/TOKENOMICS.md` §5 doing exactly what it was for.

**It already ran.** `tasks/flywire-gate/e2e_anvil_log.json`: local anvil, deploy → register three MEPs → relayer
→ bond/delegate → epoch-1 claims → epoch-2 materialize → six tasks at redundancy 2 → sponsored `submitResult`
and `settle`. 35 relayer transactions, 35 ok, 0 fails, 133 s of task time, all six digests as expected.

---

## 2. How an experiment is encoded — the part the earlier draft got wrong

The exogenous drive has two halves, and only one of them is the seed.

**Which cells are driven lives in the initial state.** `LifRowCheck.transition` branches on `S.flags & 1`: a
neuron carrying that bit is an *external* neuron and spikes according to `ext(i, step, seed)` instead of
integrating its inputs. So "drive the JO cells of both ears" is a property of the state the run starts from —
359 payload indices for `joLR`, 361 for `joLR+gate` — and that state is hashed into `initStateRoot`, which is
the task's **`inputCommit`**. The two stimulus sets in `task.json` are two `inputCommit` values:

```
joLR       0x5a7cd549…   359 cells
joLR+gate  0x23acda6b…   361 cells   (+ the 2 AN_multi_8 gate cells)
```

**The seed only says what the drive does over time.** `stimulusSeed` is 7 in all six tasks. It is not the
experimental variable; it is the noise realisation, identical across every arm so the arms are comparable.

So the whole experiment is a **difference of two `inputCommit`s across three model ids** — and every part of
that is already committed on-chain in the `Task`, already re-derivable by any third party, and already covered
by the dispute machinery: `ExecutionDisputes` takes `inputCommit` as the agreed state root before step 1 and
bisects forward from it.

The earlier draft went looking for "a channel for experiment-specific input" and concluded there was none.
There is one. It is the initial state, and it is how this experiment is expressed.

---

## 3. What today's protocol therefore supports, unchanged

An **ensemble of independent whole-brain runs**, each one individually verifiable: redundancy 2 for the
cross-check, digest agreement to settle, bisection when two executors disagree. Nothing in `tasks/flywire-gate/`
needs a protocol change, and that is not an argument — the anvil run is the evidence.

What it does *not* support is a run whose input depends on another run's output. That is a real limit, but it is
a limit on a different experiment (§6), not on this one.

---

## 4. Six runs to thousands: what actually binds

Four constraints, in the order they bite.

**(a) Residency, at 5000 steps.** `frontend/src/core/controller.js` prices this brain at **~408 MB resident at
5000 int-lif steps**, against a hosting budget of the wasm32 4 GB ceiling less 64 MB. So a tab holds two or three
of these, not the five that `docs/TOKENOMICS.md` §5 gets at shorter capacities — the memory a brain occupies is
a function of the task length, and 5000 steps is a long task. Three models at redundancy 2 is six residencies:
already two or three tabs for the smallest possible version of this experiment.

**(b) One MEP per variant, and bonding follows.** Each edited model registers its own `mepId`, and
`TaskMarket.executors()` draws only from instances bonded **for that mepId**. The delta makes the *bytes* cheap
(169 B); it does nothing about the registration, the bond, or finding two strangers willing to hold that variant
for the epoch. A thousand-variant ablation sweep is a thousand MEPs and at least two thousand bonded host-slots.

**(c) Sponsorship gas per instance per epoch.** The anvil run records the real numbers: a materialization costs
~92k gas as a sponsored transaction (down from ~285k), and the default budget of 1,500,000 gas per instance per
epoch covered three materializations plus all six `submitResult`s — 12 of 12 sponsored. That is the measurement
to extrapolate from, and it says the budget is a few dozen results per instance per epoch, not thousands.

**(d) The epoch rate.** `deployments/97.json` sets 200 blocks per epoch on BSC testnet; executors are sortitioned
per epoch, and claims and materializations are per epoch. A sweep is not gated by how fast a browser computes
5000 steps (~11 s through the wasm kernel) but by how many epochs it has to span.

None of these is a protocol defect. They are the cost function, and a thousand-run study has to be designed
against them — most obviously by **not** making every arm its own MEP when the arm could be a stimulus set
instead. Note which of the two experimental variables here is cheap: changing `inputCommit` costs nothing —
no new MEP, no new bond, no new registration. Changing the model costs all three. A sweep over stimuli is
orders of magnitude cheaper than a sweep over ablations, and that asymmetry should shape the study design
before anyone tries to raise a gas budget.

---

## 5. The gap that scale actually opens: a study is not an object

Today the chain knows about *tasks*. The claim in §1 is a statement over **six** of them, and that statement
lives in a JSON file in a git repository. Nothing on-chain binds those six taskIds together, so nothing stops a
publisher from running twelve and reporting the six that agreed.

For this task that is not a live problem — the digests were published before the runs and the whole thing is
reproducible from the repo. But it is the mechanism that has to exist before "thousands of whole brains" means
anything, and half of it is already here:

- **The pre-registration exists.** `taskId = keccak(abi.encode(Task, nonce))` under the v2 scheme, and
  `task.json` publishes every nonce and every `expectedExecDigest` *before* posting. Committing to the run set
  in advance is exactly what makes a null result unfakeable.
- **The anchor does not.** There is no on-chain object saying "these N taskIds are one study, and the study is
  complete when all N have settled". Without it, completeness rests on trusting a file.

The smallest version is a **study root**: one Merkle root over the intended taskIds, posted once before the
first task; settlement of every leaf is then publicly checkable and a missing arm is visible rather than
deniable. It needs no change to `TaskMarket` — it can be a separate registry contract, or an event — and it is
what converts a repository of digests into a result somebody else can audit.

---

## 6. If a later experiment is genuinely coupled

The question this document was originally asked to answer — many brains whose outputs feed each other — is still
open, and §2 changes the answer for the better.

- **Uncoupled ensemble** (what flywire-gate is): runs today.
- **Mean-field coupling** — every brain sees only a low-dimensional shared signal, which for an acoustic
  phenomenon is what the physics does anyway: the animals share a sound field. Chunk time into rounds; within a
  round each brain runs an ordinary task; at the boundary each brain's final state root becomes the next round's
  `inputCommit` — a mechanism that already exists and is already used. What is missing is only the *time-varying*
  part: one `bytes32 fieldCommit` on the `Task`, a drive that combines `ext(i, step, seed)` with a field sample
  proven against it, and one extra opening in the dispute's final term. `MAX_ROOTS = 512` is untouched, because
  the field is one low-dimensional sample per step, not one per brain.
- **Full pairwise coupling**: `O(N²)` per step and a dispute that would need the whole swarm's trajectory as
  calldata. Not an extension of this protocol.

The hard part remains **who computes the field**. A designated aggregator is simple and makes that party trusted
for correctness, which this system refuses everywhere else. Every executor computing it from the previous
round's on-chain results is verifiable by construction but turns each round into a barrier at the speed of the
slowest tab. A posted field with a challenge window fits the rest of the design and needs its own fraud proof.
That is the decision, and §4(a) says a coupled round of any size is a lot of tabs standing still together.

---

## 7. To decide

1. **Which kind of "collective" the target is.** `tasks/flywire-gate/` is an ensemble of independent runs; a
   coupled swarm is §6 and a different piece of work. Worth settling explicitly, because the first task as built
   does not require any of §6.
2. **Whether the sweep varies stimuli or models.** §4 makes them differ by orders of magnitude in cost.
3. **Whether a study anchor is wanted now** (§5) — it is small, and it is the difference between a published
   result and an auditable one.
4. **What a partial study means.** If 400 tabs must answer for a round or a sweep to close, some notion of
   quorum is needed that the protocol does not have.
