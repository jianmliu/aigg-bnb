# Credit: who is named in the FlyBnB dataset, for what, and how it is checked

*Of the dataset. The mesh that computed it is `aigg` on BNB Chain, and a later dataset on the same mesh would
have its own list under its own name.*

Status: policy, 2026-09-20. It is written **before** the paper on purpose. A credit policy decided afterwards is a
negotiation; decided beforehand it is a rule, and this one has to survive a reviewer asking the obvious question —
whether people bought their way onto the list.

## 0. What the list is for

Not a ranking of merit. An acknowledgment in a paper is an **epistemic** device: it lets a reader judge the data.
Who computed these numbers, and was anyone in a position to check them? Who paid, and do they stand to gain? Whose
individuals were measured? Those are disclosures, and the honest form of this list is a table of roles, not an order
of importance.

What is unusual here is only that the answers are **computable**. Every epoch a host proved the brain was resident,
every settled task and every fee is on-chain with an address and a block number. So the dataset's acknowledgments are
not a list somebody maintains and nobody can audit: they are a query, run at a stated block, that anybody can run again.

## 1. The roles

| role | what it is | earned by | how it is counted |
|---|---|---|---|
| **Authors** | the intellectual work: what to measure, the protocol, the code, the analysis | writing the paper's substance | not on-chain. §4 |
| **Compute contributors** | held a brain resident and executed the runs the atlas is made of | claims per epoch, and results in settled tasks | settled tasks whose result the executor was paid for; epochs with a valid claim |
| **Funders** | paid for the measurements: the fee of every task comes out of what they put in | adopting or breeding an individual (`MINT_PRICE − MINT_BOND`, `BREED_FEE − HATCH_BOUNTY`) | BNB into the treasury, from that address |
| **Subject contributors** | caused an individual that the atlas measures to exist | breeding: a bred fly is a new recipe, so new rows | individuals bred, and whether their battery is in the dataset |
| **Holders** | own an individual at the recorded block | holding | listed, with the tokens held |

An address can be in several. Most are: the mint bonds the minter as an instance for the base brain, so an adopter is
a host who has not started yet, and a breeder is usually both a funder and a subject contributor.

**The reason funders are named first among the non-authors** is docs/TOKENOMICS.md §9: a mint buys, almost exactly,
one measurement of the individual it creates. The atlas is paid for by the people who adopt and breed, not by the
project — saying otherwise would be false. And what they pay for is **given away**: every row is published free
(proposal §5.1a). That is what a funder's line in an acknowledgment has always meant, and it is worth being plain that
their return is the credit and whatever new experiments their individual later attracts, not a share of the rows.

## 2. What is counted, at what threshold, in what order

- **The block.** Every published list names the block it was read at. Acknowledgments move — a transfer moves a
  holder's line with the token — so a paper freezes them; the live page shows the current list and says so.
- **Thresholds.** A compute contributor is named from **one settled task** whose result they were paid for, or **ten
  epochs** with a valid claim. A funder from **one** adoption or breeding. Below that the contribution is real and the
  line would be noise; the totals are published either way, so nothing is hidden by the threshold.
- **Order.** Within a role, by the measured quantity, descending; ties by address, ascending. Both are stated with the
  list, and the query is published with the dataset, so the order is reproducible rather than decided.
- **Sybil.** Ten hosts run by one person are ten addresses and ten times the work; the weight is the work, not the
  address count. Where a name or ORCID is bound (§3) the lines are merged under it.

## 3. Names are opt-in

An address is not credit. Binding a name is the contributor's own act — a signature from the key, recorded so that the
appendix can be recomputed without trusting any server — and it is optional: unbound addresses are listed as addresses,
which is a perfectly good way to be acknowledged and the only way to be acknowledged pseudonymously. An ORCID, where
given, is what merges an individual's lines and what a reader can follow.

*(Not built yet: a small append-only registry contract, one self-asserted entry per address. Until it exists the list
is addresses.)*

## 4. What credit is not

- **Not authorship.** Hosting and holding do not make anyone an author, however much of either. Authorship follows
  intellectual contribution to the work, in the ordinary sense of the word, and is decided the ordinary way.
- **Not for sale.** No page, post or listing may offer a place in the acknowledgments as something an adoption buys.
  What an adoption buys is an individual and the measurement of it; the acknowledgment records that it happened. The
  difference is not rhetorical: the moment credit is priced it stops being evidence of anything.
- **Not payment.** Hosts are paid a fee for the work, per task, on-chain. That they are paid does not disqualify them
  from being acknowledged — a supercomputing centre is paid too, and is acknowledged — but it means the acknowledgment
  is not their compensation, and must never be described as if it were.

## 5. The conflict of interest, stated

Owners of an individual receive a royalty on every fee settled for a task against its brain. While the project is the
main task client, that royalty is a rebate of other adopters' money (docs/TOKENOMICS.md §9). Everyone named as a funder
or a holder therefore has a financial interest in the dataset being used, and the paper says so in those words. The
protection against it is not disclosure alone: it is that a row is produced by independent providers who agreed, and
that anyone can recompute it from the published recipe.

## 6. How the list is produced

At a stated block, from the chain and nothing else:

- funders and holders: the collection's `Minted`, `Bred` and `Transfer` logs, and `ownerOf` at that block;
- compute contributors: `TaskSettled` (the executors paid) and the claim manager's valid claims per epoch;
- subject contributors: `Bred`, and which individuals' batteries are in the dataset.

The live version is the page's Acknowledgments (the relayer's `/flybnb/holders`, and the hosts it serves). The
published version is a file in the dataset record, with the block, the queries, and a DOI so that a contributor can
cite it.

*(Not built yet: the generator that writes that file, and the DOI. The live holder list exists.)*
