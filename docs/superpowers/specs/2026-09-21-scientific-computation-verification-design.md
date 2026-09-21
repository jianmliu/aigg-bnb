# Verification for distributed brain experiments

Status: proposed design following the approved direction; not implemented or activated. No change to deployed contracts, fees, bond obligations or existing results is implied.

## Objective

Pool intermittent hosts to produce useful, reproducible scientific experiments. Maximize accepted scientific output per unit of total resources, including computation, validation, storage and communication. NFT rarity is a downstream analysis, not the purpose of the compute network or a substitute for result validation.

Separate three concerns:

1. Scheduling and availability: incomplete tasks are retried or reassigned.
2. Computational integrity: did this execution follow its exact model, input and program?
3. Scientific validity: are the model, implementation and experimental interpretation appropriate?

A computational proof addresses the second concern. Agreement or a proof of a buggy program does not establish the third.

## Decision and alternatives

Use explicitly labelled replication and sampling for the initial research validation service. In parallel, benchmark a specialized validity-proof prototype for the deterministic integer LIF kernel. Keep interactive execution disputes as a separately evaluated adjudication mechanism; do not make intermittent browsers responsible for indefinite monitoring.

| Approach | Benefit | Limitation |
| --- | --- | --- |
| Independent replication and sampling | Uses the current executor and produces reproducible comparisons | Duplicate compute; sampling has residual risk; independence is an assumption |
| Interactive fraud proofs | Localizes an established disagreement for bounded on-chain adjudication | Someone must detect errors, retain evidence and respond; not inherently cheap detection |
| Succinct validity proofs | Verification can be much cheaper than execution | Proving, memory, arithmetization and data costs may exceed replication |

Residency claims, host capacity, bonds and execution verification remain distinct. A base residency claim does not prove a descendant experiment was executed correctly. Extra wallets do not establish independent ownership or software diversity.

## Work units and identities

The logical scientific unit is an individual model under one stimulus configuration and seed, with explicit step count, initial conditions and readout. A battery groups these units; transport or settlement may batch them. Logical decomposition does not require a transaction per run or replacement of existing batch commitments.

Bind each unit to a canonical, versioned manifest containing:

- Exact execution MEP, base/model commitments and content-addressed delta ancestry.
- Runtime/program version and integer semantics, including rounding, overflow and threshold behavior.
- Battery version, stimulus/input commitment, seed, initial-state commitment, step count and readout definition.
- Requested output format and verification-policy version.

Define a scientific identity for exact input/program equivalence, separate from a paid assignment identity. The assignment also binds chain, market, task/nonce, assigned host and payout terms. Reusing scientific data must not permit signatures or rewards to be replayed across assignments, models or payment assets.

Identical accepted scientific work may be reused when a request allows cached results. Independent replication requests must explicitly require a new assigned execution; reused results do not count as a new independent replica. Do not pay for already completed work merely because it was assigned a new NFT label.

## Host lifecycle and evidence handoff

Proposed lifecycle:

`assigned -> executing -> committed -> evidence delivered -> validation pending -> accepted / disputed / rejected`

Before evidence handoff, a timeout means incomplete delivery: reassign the work and apply only the explicitly agreed incomplete-work payment policy. Absence of a result is not a cryptographic demonstration of false computation.

The handoff must cover the exact signed result, output artifacts, reproducible inputs and required evidence, with hashes, retrievable locations, a retention deadline and an authenticated receipt from the designated availability service. A receipt means that service accepted a retention obligation; it is not proof of result correctness or permanent availability. Independent retrieval checks and durable storage are required. Hashes or browser IndexedDB alone are insufficient.

After confirmed handoff, the browser may disconnect. Pending rewards or task-bound collateral may remain locked until the disclosed validation deadline; the host is not required to monitor later rounds. No new obligations may be added retrospectively. Unresolved cases need an explicit maximum lock duration and an inconclusive/refund path; they must not silently become accepted results when a validator disappears.

An evidence service that loses acknowledged data creates an availability incident attributed to that service. The initial policy must define reward delay/refund and service liability without treating the original host's subsequent absence as a false result. It must not promise indefinite recovery or automatic compensation without funded backing.

This is a target behavior. Current ExecutionDisputes can penalize an unresponsive party, and existing session delegation is not a dedicated safe proof-only delegation. Existing hosts remain subject to current contracts until a separately reviewed implementation and migration changes those rules. Do not enable an “offline safe” UI promise first.

## Initial research validation policy

Validation has a separately budgeted queue, independent of execution assignment. Pilot reviewers must have documented operator provenance or a declared curated trust model; multiple addresses alone cannot support claims of independent verification. Reputation is scoped to application/runtime version and does not eliminate collusion or Sybil risk.

Commit original results before audit selection or replica disclosure. Select audits using a stated randomness policy after commitment, with rules against submission grinding, selective abandonment and operator-biased selection. The current residency beacon must not be assumed unbiased or reused without analysis of withholding and timing attacks. Blind assignments and commit-before-reveal reduce copying, but do not prove that two operators are independent.

Record validation as separate dimensions:

| Dimension | Values / evidence |
| --- | --- |
| Delivery | Pending, retrievable, availability incident |
| Compute checks | Unchecked, replica agreement, replica disagreement, validity proof verified |
| Policy decision | Pending, accepted under policy version, inconclusive, rejected |
| Dataset inclusion | Dataset/snapshot version, or excluded |

Every validation record names the exact result commitment, checker/runtime version, validation method, assigned operators and receipts. Record the audit sample and its population; an unaudited row must never be labelled individually verified because its batch passed sampling.

For uniform sampling without replacement of k runs out of n containing f false runs, detection probability is `1 - C(n-f,k)/C(n,k)`, assuming the audit reliably detects a sampled false run. With one false run among 39 and three audits, it is only 3/39. This is not a network-wide adversarial security bound. Correlation, selective fraud and reference-data poisoning need separate treatment.

A disagreement pauses acceptance and triggers additional investigation; it does not establish which host is wrong. Initial pilot adjudication may use a disclosed research operator and independently maintained reference implementation. Do not describe this as trustless, or let an operator's opinion trigger cryptographic slashing. Automated financial penalties require a separately specified, objectively verifiable rule and bounded appeal/adjudication process.

Replica validation may make two independent runs cheaper than a proof. Compare at a stated assurance level; a low audit rate with substantial undetected-error risk is not equivalent to a sound validity proof.

## Outputs, battery and global rarity

The scheduler distributes work across hosts rather than asking every host to run every battery. Completion and scientific validation are separate states. Define completeness explicitly: all required inputs and readouts must be present, not only the favorable runs.

A dataset snapshot fixes membership, result commitments, validation policy, battery/runtime versions and analysis code. Global ranking can be cheaply recomputed from these inputs. It cannot establish their truth. Rank comparable cohorts under explicit rules; different substrates, stimuli or simulation versions must not silently share a reference distribution.

Random audits cover ordinary data as well as exceptional phenotypes. Strong rarity claims require validation of the experiments supporting the claim and an adequate reference cohort, since poisoned ordinary data can also distort ranks. These priorities supplement general scientific validation; they do not replace it. Historical ranking stays tied to its published snapshot.

## Validity-proof research track

First prove a bounded integer-LIF computation with public model/input/output commitments. Privacy is not a requirement. Define exact equivalence with the current execution semantics before choosing a proof system.

The proven statement must bind:

1. The authorized model and input commitments.
2. All required state transitions, including synaptic accumulation, reset/refractory behavior and integer edge cases.
3. The specified readout/output commitment derived from that execution.

A proof of one step, model loading or selected checkpoints is not a proof of the complete run. If the proof assumes an already validated model commitment, explicitly identify who validates base/delta derivation and where that separate guarantee is recorded. Do not silently claim end-to-end derivation verification.

Proof generation may run on a different class of machine from the browser, but outsourced proving can require large traces or re-execution. Attribute rewards through the original signed assignment and include all proving-service resources in the cost model. A prover's failure should not require the original browser to remain online after its agreed evidence handoff.

Avoid requiring full neural trajectories by default. Benchmark reproducible inputs, segmented checkpoints and full traces for size, upload time, recovery cost and availability. Checkpoints are an optimization and committed evidence, not correctness certificates by themselves.

## Benchmark and decision gates

Use the same deterministic workloads for baseline execution, independent replication and proof experiments. Start with a small synthetic network, then scale neuron count, synapses, steps and realistic activity regimes toward published fly profiles. Include quiet and highly active inputs; extrapolation from a tiny network is not evidence of full-brain feasibility.

Record at least:

- Execution, proving and verification wall time; CPU/GPU time and peak memory, with hardware/runtime versions.
- Witness/trace, checkpoint and proof bytes; upload/download, storage and recovery overhead.
- Failure rate, retry cost and accepted experiments per resource budget.
- Off-chain verification and, separately, BSC proof-verifier gas if measured.
- Cold/warm base loading and any amortized preprocessing, including its required reuse volume.
- Validation assumptions, sampled-error coverage or cryptographic security parameters.

Compare `execution + replication + transport + storage/retention + recovery` with `execution + proving + verification + transport + storage/retention + recovery`; avoid double-counting execution if a prover measurement already includes it. Also measure the sampled policy under its explicitly weaker assurance. Publish raw results and reproducible commands; report unavailable measurements as unavailable.

Go/no-go for specialized proofs depends on measured useful throughput and required assurance, not low verifier gas alone. Numeric budgets, audit rates, retention periods and security targets are not yet chosen. Production activation requires those values, an acceptable collusion/randomness model and measured full-workload resource bounds.

## Implementation boundaries and acceptance checks

Existing integration points are `battery/queue.mjs`, `battery/worker.mjs`, `flybnb/battery/battery_batch.mjs`, the browser family result journal, MEP commitments and task result settlement. Preserve current payment-asset and royalty binding. This proposal does not replace these modules or change task IDs by documentation alone.

Split implementation into separately reviewable projects:

1. An offline benchmark harness and dataset of measurements; no production behavior changes.
2. A versioned validation record/queue and evidence-handoff pilot with a disclosed operator trust model.
3. Settlement and dispute changes that make the offline-host promise enforceable, with task-bound liabilities and migration planning.
4. Optional proof integration only after benchmark and soundness review.

Acceptance tests for later implementation must cover altered inputs/model/runtime/output; wrong manifests and cross-task replay; interrupted or lost uploads; duplicate rewards; host disconnect immediately after handoff; verifier outage and bounded closure; inconsistent replicas without automatic blame; audit selection timing; poisoned reference cohorts; and deterministic integer edge cases. A proof verifier also needs negative proofs, public-input mutation tests and independent review of the encoded statement.

No production launch is authorized by this document alone. Existing contracts retain their semantics until the implementation and migration are explicitly performed. The first concrete next deliverable is the offline benchmark plan, not another live collection migration.

## References

- [BOINC: A Platform for Volunteer Computing](https://boinc.berkeley.edu/boinc_a_platform_for_volunteer_computing.pdf): replication and adaptive validation in volunteer computing.
- [A scalable verification solution for blockchains](https://arxiv.org/abs/1908.04756): interactive verification and its incentive assumptions.
- [Scalable, transparent, and post-quantum secure computational integrity](https://eprint.iacr.org/2018/046): succinct verification with additional prover work.
- Repository context: [family hosting](../../FAMILY_HOSTING.md), [base enrollment](../../BASE_ENROLMENT.md), [current migration and retained obligations](../../FAMILY_MIGRATION_2026-09-21.md).
