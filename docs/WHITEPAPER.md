# aigg: An Open Network for Model Computation and Verifiable Research

## System White Paper and Roadmap

**Version:** v0.1 · Discussion draft

**Date:** 2026-09-20

**Implementation baseline:** `aigg-bnb` main at [`09c9de9`](https://github.com/jianmliu/aigg-bnb/tree/09c9de9)

**Scope:** System architecture, delivery guarantees, public research funding, governance, and milestones. This document does not replace the protocol specification or equate testnet operation with production security validation.

This document distinguishes four states: **implemented** means the baseline code contains the capability; **testnet operation recorded** means the repository documents an actual run, not that this review independently reverified the live deployment; **branch implementation** means the capability has not entered the baseline main branch; and **planned** means implementation or validation remains outstanding. Financial flows, performance, and deployment parameters must be tied to a specific code version and deployment. Roadmap milestones define acceptance criteria, not calendar delivery commitments.

## Abstract

aigg aims to make model computation discoverable, executable, checkable, and payable across an open provider network. Requesters submit tasks, providers hold models and supply computation, and the system records task conditions, results, and the guarantees attached to them while handling payment, timeouts, and disputes.

The project began by extending unified model APIs, such as sub2api, toward P2P inference supply. Establishing confidence in unfamiliar providers led to an execution-assurance path based on trusted execution environments (TEEs). The entry barriers to GPU TEEs, together with the difficulty of verifying general LLM inference bit for bit across heterogeneous environments, prompted a search for another class of workload: models with precisely defined execution rules that ordinary devices can run and independent parties can recompute.

Integer simulation of the fruit-fly connectome became the first application to exercise the full computation path. Browser tabs lower the barrier to participation; PoRW evidence of model possession supports provider eligibility; task-level redundant execution and dispute mechanisms support result verification. FlyBnB applies these capabilities to research on simulation robustness under connectome variation and produces an open dataset.

The system's near-term value does not depend on commercial inference demand. Members of the public can fund particular individuals and experiments, maintain an ongoing relationship with the research, and receive acknowledgment tied to their contributions. Results are public, and identity, funding, and computation records can be checked. Paid experiments and other model workloads are subsequent expansion paths.

## 1. The Problem and the Path to the Current Design

A unified API reduces the effort of calling different models, but a common interface does not answer three questions: whether the provider holds the model it claims to serve, whether it completed the task as agreed, and who bears the consequences of failure or a disputed result.

Each stage of the project separated these constraints more clearly:

| Stage | Purpose | Boundary identified |
|---|---|---|
| sub2api → P2P API | Connect a unified entry point to open inference supply | Interface consistency does not prove authentic delivery |
| LLM + TEE path | Provide assurance about the execution environment and program | Depends on hardware, the attestation chain, and the runtime stack; GPU supply has a relatively high entry barrier |
| Addition of PoRW | Provide evidence of model possession and participation eligibility | Possession evidence cannot replace verification of task results |
| Fly brain + browser | Exercise the complete task flow on ordinary devices | First establish one explicit, reproducible execution semantics |
| CPU/GPU execution direction | Separate task and evidence interfaces from device type | GPU performance, proof overhead, and the value of larger models require separate validation |

TEE execution and exact recomputation can coexist. Different tasks can use different delivery guarantees. The system seeks to unify task descriptions, model identities, capability discovery, receipts, and settlement interfaces without treating every guarantee as the same kind of trust.

Extending this architecture to mammals means that larger deterministic models may reuse the same task and dispute principles. It does not mean a complete mammalian connectome is already available, that the current fly implementation has completed its GPU extension, or that a simulation already has the corresponding biological explanatory power.

## 2. Three Layers and Their Relationship

**aigg is the network.** It connects computation demand, providers, delivery records, and payments.

**PoRW and the task protocols provide the assurance mechanisms.** Model possession, task execution, and dispute adjudication supply different forms of evidence; none substitutes for the others.

**FlyBnB is an application and a dataset.** It studies the outputs of synthetic connectome individuals under standard stimuli, perturbations, and recombination, and organizes public participation in that research. The dataset paper covers scientific methods and results; this white paper covers infrastructure and participation mechanisms.

`aigg-porw` supplies the protocols, execution kernel, and associated runtime. `aigg-bnb` contains BNB Chain integration, the Gateway, relayer, collection contracts, and frontend. An upstream capability is not necessarily enabled in every downstream deployment.

```mermaid
flowchart TB
    A[Researchers / Applications / Publicly funded research] --> B[Task entry: Gateway or batch tools]
    B --> C[Model identity, task parameters, quote and budget]
    C --> D[Availability and provider eligibility]
    D --> E[Executors: browsers / headless CPU nodes]
    D -.Planned.-> F[GPU executors / TEE execution path]
    E --> G[Results, signatures and reproducible evidence]
    F -.Path-specific guarantees.-> G
    G --> H[On-chain settlement / timeouts / disputes]
    H --> I[Execution payments and optional model-terms distributions]
    G --> J[Public data, research analysis and contribution records]
    J --> A
```

Public funding reaches tasks through a research budget. Funders need not write tasks or operate nodes themselves. Research orchestration is a separate responsibility that requires an accountable operator and visible delivery status.

## 3. System Roles

| Role | Responsibility | Rights or guarantees not automatically conferred |
|---|---|---|
| Researcher / requester | Define the question, inputs, budget, and acceptance criteria | Correct execution does not establish a research hypothesis |
| Funder | Support individuals, experiments, or a research budget | No guaranteed return or automatic authorship |
| Individual holder | Hold a transferable individual identity and use the collection's permitted operations | No exclusive right to use the underlying public data |
| Host / executor | Hold models, submit eligibility evidence, and execute tasks | A bond or online presence alone does not guarantee selection or payment |
| Relayer / aggregator | Forward messages, aggregate and submit records, and sponsor gas according to policy | Should not be the final authority on result correctness; can affect availability |
| Auditor / challenger | Recompute independently, detect errors, and challenge within the window | Permission to challenge does not ensure that auditors will participate |
| Research operator | Manage research budgets, schedule experiments, and publish data and progress | Must not describe planned experiments as completed |
| Collection curator / governance participant | Manage recognition lists and mutable settings within a defined scope | Authority must be disclosed rather than hidden behind a claim of having no administrators |

One person may occupy several roles. The system must record overlapping roles and avoid treating multiple addresses as multiple independent organizations.

## 4. System Architecture

### 4.1 Model Identity, Execution Semantics, and Terms

Model data is identified by content. `model_id` identifies model content; `mep_id` additionally binds the execution semantics, structural commitments, applicable terms, and other information required by the protocol. Matching file names does not establish that two providers are executing the same model.

For a model carrying beneficiary and royalty terms, a host must use the identity registered on-chain. The same model bytes can correspond to different MEPs under different terms. Main already supports passing these terms through frontend model loading.

Step count, stimulus, perturbation, redundancy, and commitment interval are task parameters. The execution-kind specification must explicitly bind parameters that affect results or proof costs, so tasks with different semantics cannot be confused with one another.

### 4.2 Model Publication and Individual Recipes

A FlyBnB individual can be expressed as a deterministic delta over a public base model. The main-branch frontend can recognize supported deltas, locate the base, apply the recipe, and check the resulting model identity. This does not imply compatibility with every delta layout or historical publication convention.

Multiple individuals from one collection can reuse downloaded base data. The current implementation caches one base during preparation and releases that cache when the node starts. **Reusing a download does not share resident model memory:** each applied individual still requires distinct model content and associated state. Cache lifetimes during subsequent hot-loading also need coverage in sustained memory tests.

Greenfield provides model storage in the current deployment. Content addressing makes it possible to check downloaded data, but does not guarantee continuing availability. Mirrors, quotas, recovery, and archival storage remain availability responsibilities.

### 4.3 Provider Eligibility and PoRW

Hosts participate under an instance identity and a bond, submitting model-possession evidence within epochs. Aggregation and materialization make valid records available for subsequent eligibility checks and task selection.

This evidence is not a hardware identity certificate and does not directly prove that all computations came from physically independent devices. Per-address weight limits do not prevent one operator from creating multiple addresses. Bonds provide an economic constraint whose strength must be evaluated alongside extractable value, maximum slashing exposure, and the probability of detection.

### 4.4 Gateway and Task Entry

The Gateway exposes an OpenAI-compatible request interface. For fly tasks, however, the input is an experiment description and the output is an experimental result and receipt, rather than natural-language LLM inference. Interface compatibility should not obscure the workload or its guarantee type.

Existing capabilities include model discovery, capacity checks, task submission, result retrieval, usage accounting, timeout and dispute handling, and some restart-recovery paths. Tools for ai.gg registration and protocol adaptation exist; live integration status and the full behavior of the upstream deployment require separate verification.

A separate batch tool can submit a standard battery and compare results with offline runs. This and the Gateway's individual calls are not one complete pipeline. Their budgets and pricing must be reconciled; successful operation of each tool alone does not establish complete research automation.

### 4.5 Relayers, Epochs, and Sessions

Relayers support message forwarding, claim aggregation, and gas sponsorship. Alternative relayers and direct on-chain responses are intended as failure paths, but operational readiness requires fault exercises.

Task announcements depend on a current, valid session key. Main includes bounded log queries and checks for new delegations to address public RPC limits and host key rotation. Multiple query windows, repeated key rotation, chain reorganizations, and recovery after downtime should remain regression scenarios.

Cold-epoch wake-up and a Host earnings dashboard have an implementation on the separate M3 branch; they are not merged into the baseline used here. Cold-start time must be included in task availability and latency reporting. Model execution time alone does not describe response time.

### 4.6 Execution, Results, and Disputes

The current fly workload uses explicit integer execution rules. Given a fixed model and task input, results can be independently recomputed. Executors sign their results; the system compares commitments and settles according to the protocol. Disagreement or a qualifying subsequent challenge enters the dispute mechanism.

A result receipt should separately identify inputs, output digests, executor signatures, settlement state, challenge deadlines, and verification method. For supported tasks, raw outputs should also be checkable against their digests.

Executor agreement, transaction settlement, expiry of the challenge window, and review by an independent organization are distinct facts. Both the product and the dataset should report them separately. Challenges depend on timely data access and participant responses. The existence of a challenge mechanism does not establish that an unchallenged error has been ruled out.

## 5. Delivery Guarantees Across Workloads

| Path | Principal evidence | Trust boundary | Current position |
|---|---|---|---|
| Deterministic integer computation | Reproducible inputs and outputs, redundant results, dispute adjudication | Correct specifications and verifiers, data availability, challenger participation, chain security | Main fly implementation |
| TEE execution | Attestation of a specified program and execution environment | Hardware vendor, attestation chain, runtime stack, input/output binding, and operations | Original LLM direction; unified integration remains planned |
| Model possession / PoRW | Model-possession claims and verification | Economic constraints, sampling, network behavior, and response deadlines | Part of main; does not establish task correctness by itself |
| Independent scientific review | Replication across implementations, organizations, and research methods | Model assumptions, statistical methods, and experimental evidence | Must be reported separately from on-chain evidence |

General LLM inference cannot be assumed to support the bitwise comparison used by the current integer simulation. Deterministic or quantized LLMs are possible separate research directions, requiring fresh validation of execution semantics and verification costs. A shared CPU/GPU task interface does not mean that any model on any GPU can be verified in the same way.

## 6. FlyBnB: The First Research Application

FlyBnB asks how robust stimulus and perturbation conclusions from a single brain model are under an explicit model of synthetic connectome variation. Data is organized by individual, stimulus, perturbation, and seed, supporting a perturbation atlas, association analyses, and studies of synthetic recombination and selection.

Existing results include variance and breeding pilots, an association analysis, a first silencing-atlas slice, six generations of selection, and preliminary analysis of the male connectome. Infrastructure readiness does not mean that the complete silencing and activation atlases or comparisons with biological experiments are finished.

Synthetic individuals are not samples of real animals, and connection-level recombination is not a biological inheritance mechanism. Hemispheric differences calibrate a distribution; they do not establish that it fully represents variation between animals. Exact execution supports reproducibility. Scientific validity still requires sensitivity analyses, independent connectomes, and experimental validation.

The public value of the data lies in reusable questions, recipes, outputs, and interpretations. On-chain records provide additional provenance and settlement evidence. They are not prerequisites for reading, citing, or recomputing public results.

## 7. Public Funding, NFTs, and Contribution Acknowledgments

### 7.1 A Participation Cycle Without Commercial Inference Revenue

```mermaid
flowchart LR
    A[Public funds an individual or experiment] --> B[Research budget and explicit delivery scope]
    B --> C[Orchestration, execution and verification]
    C --> D[Public results and progress]
    D --> E[Historical contribution records and acknowledgments]
    E --> F[Continued participation, sharing or renewed support]
    F --> A
```

This cycle does not require commercial computation buyers. Participants may contribute because of the scientific objective, continuing involvement, an individual's lineage, and recognition of their contribution. Its sustainability must be tested through delivery rates, participation, and repeat funding, rather than NFT sales alone.

Unless the relevant legal and tax status has been established, the frontend should use terms such as research funding, pledges, or an accurate description of the transaction. It should not automatically promise charitable-donation status or tax deductibility.

### 7.2 The Role and Limits of NFTs

An NFT represents a synthetic research individual's identity, ownership, and operations defined by its collection. Recipes and research records connect a funding contribution to subsequent experiments. The NFT does not grant exclusive use of a public connectome or deterministic result, and the public need not buy an NFT to access research data.

Three linked but separate records are proposed:

1. **Ownership record:** who currently holds an individual and when transfers occurred.
2. **Contribution record:** who funded, computed, created an individual, or contributed to research, and when.
3. **Research record:** which experiments were proposed, funded, executed, verified, and published.

A funder's historical contribution should survive transfer of the NFT. The recipient becomes the current holder without retroactively receiving credit for the original funding. Executors and holders must likewise remain distinct roles.

### 7.3 Acknowledgment and Research Independence

Acknowledgment follows verifiable contributions and does not automatically confer paper authorship. Authorship depends on actual research contributions and applicable publication requirements. Public association of a name or ORCID with an address requires the participant's affirmative authorization; an address record is not verification of a person's identity.

NFT funding may influence which individuals or projects enter a study, but must not purchase a favorable result, exclude adverse findings, or manipulate analysis thresholds. Relationships among funders, researchers, executors, and holders should be disclosed. Refunds, unfinished experiments, and duplicate funding also need clear records.

The existing CREDIT policy already distinguishes roles. Automated historical records for every role, identity binding, and complete acknowledgment generation still require capability-by-capability acceptance checks.

## 8. Funding and Sustainability

### 8.1 Account Separately for Three Sources of Funds

- **Research funding:** pays for agreed experimental deliverables and maintenance of public research resources.
- **External computation revenue:** customers pay for new questions or service delivery; a possible expansion, not a prerequisite for scientific value.
- **Subsidies and project funds:** support early supply, maintenance, and experimentation. Their source and duration should be disclosed; they do not count as external demand.

Existing mint and breed flows include prices, possible bonds or bounties, and treasury income. A bond is a participant's capital at risk and should not be counted as research income available for discretionary spending. Realized financial flows should be reported from on-chain records and actual expenditures.

### 8.2 Every Measurement Commitment Needs a Budget

Each delivery commitment should satisfy:

`Available delivery budget ≥ execution fees + transaction and sponsorship costs + audit costs + retry reserve + storage and publication costs`

A baseline battery and a complete perturbation atlas are different deliverables. Funding the former cannot automatically commit to the latter. Research operators must also reserve funds for outstanding obligations so that a decline in new funding does not prevent delivery of already promised experiments.

Code and documentation currently contain pricing units that need reconciliation. The Gateway default is `100000000000 wei`, or `100 gwei` per base billing unit, while some documentation states `0.1 gwei`. At the default rate, 39 runs of 5,000 steps with two replicas have a base fee of `0.039 BNB`; applying the min2 model factor of 1.54 throughout gives an estimate of `0.06006 BNB`. These are not the actual bills for every deployment or batch: batch tools can specify fees independently, and configuration can change.

This document therefore does not promise that a fixed mint amount covers a fixed experiment. Task quotes, batch budgets, and actual settlement should first be aligned, then published as a versioned cost schedule. A host's true costs also include idle memory, online time, bandwidth, proof generation, and maintenance; execution CPU seconds alone are insufficient.

### 8.3 Model Terms and Royalties

Where collection terms apply, a task fee may first allocate a model royalty, with the remainder paid to executors. The royalty may then be divided between the individual holder and the base-model beneficiary. For example, a 10% task royalty with a base share equal to 10% of that royalty allocates 90% of the task fee to executors, 9% to the individual holder, and 1% to the base beneficiary. This illustrates a set of terms; actual distributions depend on the deployment.

Royalties allocate fees incurred within this marketplace. They do not prevent external parties from copying public models and running them elsewhere. Royalties generated by publicly funded experiments still originate in the research budget, and this circulation should be disclosed. NFT income and resale prices are not guaranteed and are not necessary conditions for the value of research participation.

## 9. The Experiment-to-Delivery Lifecycle

The target pipeline is:

`Propose experiment → define scope and budget → confirm funding → register or resolve model → prepare supply → submit task → verify or dispute → archive results → notify delivery → update contribution records`

Every step requires durable state and retry rules. A service restart must not pay twice for an experiment whose on-chain task has already been submitted. Funding received before task submission must remain recoverable rather than disappear from the workflow. The system needs mappings between experiment and task identifiers, idempotent submission, timeout handling, and records of manual intervention.

Several constituent modules exist today. A durable, end-to-end research orchestration system from funding to published results remains a roadmap deliverable. A successful one-off command-line run does not replace it.

## 10. Threat Model and Governance Boundaries

| Risk | Current boundary | Required controls and evidence |
|---|---|---|
| Multiple addresses belong to one operator | Multiple signatures do not establish independent supply | Concentration disclosure, independent operators, and sampled replication |
| All executors submit the same error | Depends on external recomputation and timely challenges | Watcher budgets, injected-error exercises, and completed challenge records |
| Missing data or unavailable storage | A content identifier cannot supply the data | Mirrors, archives, recovery, and challenge-data availability tests |
| Relay/RPC failure or censorship | Can impair liveness | Alternative paths, direct responses, and recovery exercises |
| Browser suspension or resource exhaustion | Ordinary-device participation does not guarantee continuous availability | Capacity declarations, timeouts and retries, peak-resource measurements, and recovery tests |
| False model or lineage registration | Execution verification cannot replace derivation verification | Select and validate an appropriate lineage-registration path for production collections |
| Task value exceeds slashable capital | Fixed bonds cannot cover arbitrary value | Task/epoch exposure limits and parameter stress tests |
| Economically biased randomness | Commit-reveal has a withholding boundary | Compare extractable value with attack cost; use a stronger beacon path where needed |
| Biased research conclusions | Reproducibility does not remove methodological bias | Prespecified analyses, complete publication, interest disclosures, and external validation |
| Unclear data-use rights | Public downloads do not imply unrestricted commercial use | Source, version, and license records for the actual input files |

Immutable contract parameters can limit arbitrary administrative changes, but can also freeze mistaken assumptions. The roadmap needs migration, exit, and version-identification mechanisms. Powers over collection recognition lists, treasury destinations, renderers, and service configuration should be described contract by contract. A claim of complete decentralization cannot replace an inventory of authority.

This white paper introduces no new protocol token and does not prescribe token issuance to sustain supply. BNB/tBNB currently serve payment, bonding, and transaction functions on the applicable networks; their economic significance across deployments must not be conflated.

## 11. Current Capability Matrix

| Capability | Status at this baseline | Next acceptance focus |
|---|---|---|
| Integer fly execution and cross-implementation recomputation | Implemented and tested | Pinned versions, coverage, and published evidence |
| Claims, eligibility, tasks, disputes, and settlement | Implemented; testnet operation recorded | Fault, collusion, and economic-boundary exercises |
| Browser hosting, wallet connection, and session delegation | Implemented | Multiple wallets, suspension, key rotation, and sustained operation |
| Individual deltas, terms, and base-download reuse | Merged into main | Memory over the full lifecycle and historical-data compatibility |
| Gateway and ai.gg integration tools | Implemented | Live upstream integration, billing, and restart recovery |
| Cold-epoch wake-up and Host earnings dashboard | M3 branch implementation | Merge, end-to-end tests, and deployment verification |
| Batched batteries and offline-result comparison | Tools and tests exist | Integration with budgets and durable research orchestration |
| NFTs/collections, breeding, distributions, and acknowledgment policy | Implemented to varying degrees | Check enabled features per deployment; complete historical contribution records |
| Automated funding-to-publication cycle | Planned integration work | Delivery, retries, archival, and notifications |
| Exact GPU execution and unified TEE integration | Planned | Respective guarantee boundaries, compatibility, and cost experiments |
| Mammalian workloads | Long-term direction | Data availability, model validity, and executable benchmarks |

## 12. Roadmap: Progress Through Evidence

The R stages below describe this white paper's system roadmap; they do not replace M0–M6 in the Gateway document. Scientific analysis, reliability engineering, and user research may proceed in parallel. Releases with dependencies must first satisfy those dependencies.

| Stage | Deliverables | Acceptance criteria |
|---|---|---|
| **R0: Establish a trustworthy baseline** | Version inventory, deployed-capability matrix, aligned pricing and budgets, data-verification levels | Any task can be traced to its configuration and receipt; fee calculations are reproducible; documentation separates plans from actual capabilities |
| **R1: Complete the research-funding workflow** | Explicit experiment scope, durable task queue, failure handling, public result pages, and historical contribution records | At least one cohort of externally funded experiments completes the full flow without manual backfilling; restarts neither lose orders nor duplicate payment; participants can inspect progress |
| **R2: Establish open-network reliability** | M3 integration, cold-start policy, independent hosts/watchers, fault exercises, and operational dashboards | Publish success rates and latency distributions; key rotation, disconnection, relay failures, and incorrect results follow predefined handling paths; report actual operator independence |
| **R3: Validate research and participation value** | Versioned datasets, reproducible analysis packages, external scientific review, and a study of funding participation | Distinguish model-internal findings from external validation; measure renewed funding and engagement without promises of financial return; explicitly list unfinished research |
| **R4: External services and a second application** | Research-service entry points, batch delivery, explainable quotes, and a second real workload class | If pursuing a commercial path, demonstrate repeated use by customers not subsidized by the project; the second application reuses model/task/receipt/settlement interfaces instead of rebuilding the system |
| **R5: CPU/GPU and TEE execution paths** | An exact GPU execution prototype, explicit guarantee configurations, TEE adaptation, and end-to-end evidence | Supported CPU/GPU configurations pass differential verification and dispute tests; proof overhead is acceptable; TEE evidence explicitly binds the program, model, inputs, and outputs |
| **R6: Larger brain models and scaled operations** | Larger-connectome benchmarks, resource and audit-cost reports, and migration/governance plans | Data and permissions are available; experiments are reproducible; expand deployment only when resource requirements, costs, and scientific objectives are jointly supported |

### Conditions for Changing Direction

- If the public supports research but external commercial demand remains limited, the system may continue as research infrastructure without claiming a validated computation marketplace.
- If users need analysis services but not network guarantees, separate the research service from its execution backend, retaining evidence interfaces while adapting the implementation.
- If collecting attracts more demand than research participation, disclose and validate that product separately. Trading volume does not establish scientific impact.
- If GPU/TEE paths fail to meet cost and assurance objectives, continue supporting validated integer workloads. Broader model ambitions must not conceal unfinished capabilities.

## 13. Evaluation Metrics

Report research, participation, operations, and commercial outcomes separately so that a single transaction-volume figure cannot conceal weaknesses.

| Dimension | Suggested measures |
|---|---|
| Research output | Public, reproducible experiments; reproduction coverage; external use; methodological sensitivity; comparisons with biological experiments |
| Funding delivery | Income, reserved budgets, promised/completed/failed experiments, average delivery time, refunds or substitute deliverables |
| Public participation | Result views, subsequent engagement, renewed funding, and reasons for leaving; distinguish groups with and without expectations of financial returns |
| Network reliability | Warm/cold success rates and p50/p95 latency, key-rotation recovery, available-model coverage, and peak resource use |
| Verification quality | Independent-operator participation, sampling coverage, challenge detection and completion rates, and injected-error exercise results |
| Economic health | Total cost per deliverable, host net returns including idle and execution costs, subsidy share, and outstanding delivery obligations |
| Commercial expansion | External revenue, repeated use, and delivery gross margin; exclude project self-payments and circular subsidies |

Metric targets should be fixed before a pilot and published with its report. Where data is absent, say “not measured.” Do not substitute addresses for users, mints for experiment demand, or successful settlement for scientific validity.

## 14. Open Decisions

1. Whether a funding contribution supports an individual's baseline measurement, a specified experiment, or a common research budget, and how each commitment is presented.
2. How ownership, historical contributions, and rights to participate in research decisions are separated.
3. Which budgets sustain watchers and resident supply, and which costs research funds bear.
4. When to enable stricter lineage validation, task-value limits, and beacon upgrades.
5. How immutable parameters in current collections coexist with new versions, migration, and exit.
6. The first concrete workloads and acceptance datasets for GPU/TEE prototypes.

These decisions should become recorded decisions and versioned parameters, rather than remain implicit in frontend copy or operating habits.

## 15. Comparison with Other Approaches

External documentation reviewed on **2026-09-20**. This section compares architectural choices, not measured performance or market share. aigg's implementation status remains the baseline in Section 11. The strategic conclusions below are design judgments; they do not establish product–market fit.

### 15.1 Different Units of Coordination

| Approach | Primary unit of coordination | Assurance boundary | Implication for aigg |
|---|---|---|---|
| **aigg / FlyBnB** | Identified models, specified tasks, execution evidence, and funded research deliverables | Exact execution for supported workloads; disputes depend on data availability and active challengers; scientific validity remains separate | Must demonstrate that open participation and settlement improve research delivery enough to justify their costs |
| **Bittensor** | Subnets defining work and scoring, with miners, validators, and token incentives | Subnet-specific evaluation aggregated through Yuma; the scoring mechanism determines what quality means | A relevant alternative for incentivizing a research workload, rather than a direct equivalent of a model registry |
| **Akash** | Compute-resource leases and application deployments | Infrastructure delivery; a lease alone is not evidence of a particular scientific result | Potential execution infrastructure and a cost baseline. Providers earn from deployments running on their clusters. [Provider documentation](https://akash.network/providers/) |
| **Golem** | Requestor demands, provider agreements, task execution, and billing | Application execution and resource exchange; research-result checks need an explicit design | A closer task-market comparison. Its SDK/Yagna workflow already connects budgets, resource matching, and execution. [Requestor–provider interaction](https://docs.golem.network/docs/creators/common/requestor-provider-interaction) |
| **Phala / dstack** | Confidential applications with attested runtime identity | Hardware-backed isolation and attestation; this does not establish scientific validity | A reference for aigg's planned TEE path. Compare attestation policies and evidence binding, rather than treating TEEs as interchangeable with exact recomputation. [dstack](https://phala.com/dstack) |
| **BOINC** | Research projects distributing work to volunteer computers | Application-specific validation, including replicated results and quorum rules | The essential scientific-computing baseline. Distributed participation and replicated validation already exist without requiring aigg's financial settlement model. [BOINC architecture paper](https://boinc.berkeley.edu/boinc_a_platform_for_volunteer_computing.pdf) |

These systems can compose. A scientific application can use rented resources, volunteer machines, an incentive network, or a combination. Access to a provider through another network does not automatically make that provider eligible under aigg's protocol, establish operator independence, or supply the required execution evidence.

### 15.2 Bittensor: Subnet Evaluation and Capital Allocation

A Bittensor subnet defines a particular kind of work and an incentive mechanism. Miners perform that work; validators evaluate it and submit weights. The subnet therefore embodies both a workload and a policy for recognizing useful contributions. Different subnets can use different evaluation procedures. [Validator roles](https://learnbittensor.org/concepts/network-participants/validator)

Yuma combines validator weights with stake-dependent influence to determine rewards. This makes it an aggregation mechanism for evaluations; it does not supply a universal proof that an arbitrary model was executed correctly. A subnet can nevertheless use objective checks, recomputation, or other evidence in its scoring. Describing all Bittensor validation as merely subjective would be inaccurate. [Yuma Consensus](https://www.bittensor.com/docs/internals/consensus)

Two allocation decisions must remain separate: **how rewards are divided within a subnet**, and **how TAO issuance is allocated across subnets**. Dynamic TAO introduced subnet-specific alpha tokens and TAO/alpha pools. Alpha is a fungible subnet economic asset, rather than the identity of a particular model or experiment. [Dynamic TAO concepts](https://docs.learnbittensor.org/dynamic-tao/dtao-guide)

The current official emissions documentation describes subnet TAO shares based on smoothed alpha prices, adjusted for withheld miner incentives and an emission gate; participant alpha rewards are distributed separately. Earlier materials describe net-TAO-flow allocation, so those descriptions should not be treated as the current rule without checking the deployed runtime. This white paper relies on the architectural distinction, not a fixed emission formula or reward percentage. [Current emissions documentation](https://www.bittensor.com/docs/concepts/emissions)

Our economic interpretation is that token-market allocation, validator scores, customer payments, and scientific impact measure different things. Strong token demand need not establish useful experimental output; a scientifically valuable subnet need not yet have paying customers. Equally, aigg research funding is not evidence of commercial inference demand. Both systems should disclose the source of support and show what useful work it produces.

### 15.3 Why an aigg Model Is Not a Bittensor Subnet

| Question | Bittensor model | aigg / FlyBnB model |
|---|---|---|
| What is being defined? | A domain of work and a scoring/incentive mechanism | Model content, execution semantics and terms; an application separately defines experiments |
| What makes a result acceptable? | The subnet's evaluation policy, reflected in validator weights | The task's execution rules and evidence; research interpretation requires additional review |
| What does the economic asset represent? | Alpha participates in a subnet's token economy | An NFT identifies a research individual and collection-defined rights; historical contributions remain separate |
| Where does payment originate? | Protocol emissions provide incentives; any customer revenue must be accounted for separately | Research budgets, task customers, and disclosed project subsidies; no new emission token is proposed |
| What does a royalty mean? | Subnet rewards follow the network and subnet incentive rules | A share of a paid task under model terms; it does not create new funds |
| Who selects research priorities? | Determined by the subnet's objective and evaluation design | Researchers, funding scope, and disclosed participation rules; execution verification cannot select good science |

The intended FlyBnB participation cycle is funding, delivered experiments, public results, acknowledgment, and renewed participation. A Bittensor subnet could support part of that cycle, but subnet ownership, alpha holdings, NFT ownership, and scientific contributions must not be conflated.

### 15.4 Could FlyBnB Become a Subnet?

This is an option to evaluate, not an implemented integration or a commitment to issue a token. Three architectures deserve comparison:

1. **Standalone research application:** retain aigg task settlement and fund explicit deliverables. This keeps budget obligations direct, while leaving supply recruitment and watcher funding to the project.
2. **External execution integration:** retain the research and evidence interfaces while sourcing some computation elsewhere. An adapter must preserve model identity, task parameters, evidence requirements, and failure handling.
3. **Research subnet:** use a subnet to incentivize approved experiments, coverage, or independent verification. This introduces a scoring system and validator operations alongside the existing research pipeline.

For the third option, rewarding raw execution counts would be insufficient: identical deterministic outputs can be replayed, cheap tasks can crowd out useful ones, and valid execution can still answer an unimportant question. A candidate design should bind rewards to an approved experiment identifier and versioned inputs, distinguish new results from explicitly requested replication, publish all assigned outcomes, and test copying, collusion, and selective reporting. Computational correctness and the scientific choice of experiments need separate evaluation policies.

Before adopting a subnet, compare incremental research output with validator, registration, integration, and operating costs. Publish a funding plan for already promised experiments if token incentives decline. Proceed only if the pilot adds useful supply, independent evaluation, or research funding beyond the standalone baseline. Reward growth alone is not an acceptance criterion.

### 15.5 Competitive Test and Product–Market Fit

The strongest immediate alternative is also the simplest: a research team runs the same models on a workstation or cloud cluster, publishes the data, and accepts research support with conventional acknowledgments. BOINC adds an established volunteer-computing alternative. aigg must show why participants or researchers benefit from its additional model identity, open hosting, evidence, settlement, and contribution records.

Run the same pinned experiment battery against feasible alternatives. Report total cost per accepted experiment, cold and warm delivery latency, failure recovery, operator effort, independent replication, and public-data completeness. Include downloads, idle capacity, retries, proof and audit work, settlement, and subsidies. Compare equivalent assurance levels; inexpensive unchecked execution and independently verified delivery are different services.

For research participation, compare completed funding obligations, result engagement, and renewed support with and without NFT ownership or expected income. For commercial computation, require repeat external purchases. For network value, require useful participation from independently operated hosts and evaluators. These are separate hypotheses, and success in one does not establish the others.

The proposed differentiation is a traceable relationship between a research individual, its funded experiments, verifiable execution, public results, and lasting contribution records. That combination is a hypothesis to validate through delivery and continued participation, not a claim that other networks cannot implement it.

## 16. Relationship to Other Documents

- [FlyBnB dataset paper](https://github.com/jianmliu/aigg-bnb/blob/09c9de9/docs/flybnb/paper.md): scientific methods, results, limitations, and data availability.
- [Research proposal](https://github.com/jianmliu/aigg-bnb/blob/09c9de9/docs/flybnb/proposal.md): experimental scope and hypotheses to test.
- [Contribution and acknowledgment policy](https://github.com/jianmliu/aigg-bnb/blob/09c9de9/docs/flybnb/CREDIT.md): role-based contribution records and attribution rules.
- [Deployment and protocol design](https://github.com/jianmliu/aigg-bnb/blob/09c9de9/docs/DESIGN.md): BNB integration, parameters, and technical boundaries.
- [Gateway design](https://github.com/jianmliu/aigg-bnb/blob/09c9de9/docs/GATEWAY.md): APIs, task lifecycle, and integration roadmap.
- [Economic-model discussion](https://github.com/jianmliu/aigg-bnb/blob/09c9de9/docs/TOKENOMICS.md): parameters, cost measurements, and pricing units awaiting reconciliation.
- [Upstream aigg-porw](https://github.com/jianmliu/aigg-porw): execution semantics, runtime, and protocol implementation.

The development path described here is testable: first deliver one scientific workload on ordinary devices with evidence others can check; then connect funding, research, and contribution into a continuing relationship; finally use independent applications and actual benchmarks to establish whether the network can expand.
