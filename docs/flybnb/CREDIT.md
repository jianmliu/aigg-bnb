# FlyBnB acknowledgment policy: NFT holder snapshots

Status: simplified policy, 2026-09-20. This replaces the earlier role-by-role historical contribution policy for the default paper and dataset acknowledgment list.

## 1. The rule

For each published paper or dataset version, acknowledge the addresses that hold the NFTs included in that research at one specified snapshot block. Holding at least one included NFT at that block is sufficient. Founder and bred NFTs follow the same rule.

The list recognizes **holders at the snapshot**, not original funders, breeders, executors or paper authors. It does not require reconstruction of adoption, breeding, payment or transfer histories. How or when a holder acquired the NFT does not change eligibility at the snapshot.

## 2. What each release records

Publish the following alongside the acknowledgment list:

- Paper or dataset version and its identifier.
- Chain ID, collection address, snapshot block number and block hash.
- The exact NFT IDs included in that version's research.
- Each included NFT's owner at that block, grouped by holder address.

Read ownership at the same block for every included token. Include only NFTs actually used in the release; holding an unrelated individual does not qualify for that release. A release with no included NFT has no NFT-holder acknowledgment list.

List normalized holder addresses in ascending order, with each address's token IDs in ascending order. This is a reproducible list, not a ranking of funding or scientific merit. Contracts and treasury addresses follow the same ownership rule and must not be represented as verified human identities.

## 3. Publication and transfers

Freeze the list when its paper or dataset version is published. Later NFT transfers do not rewrite that version's acknowledgments. A subsequent version takes its own snapshot, so a new holder may appear in a later release.

A transfer before the snapshot changes the eligible holder. The earlier adopter or breeder has no separate entitlement to appear in the default list merely because they previously held, created or funded the NFT. Previously published acknowledgments remain unchanged.

The live website may show current holders, but that live list is not the frozen list of a published release. Preserve the release's snapshot metadata and list so others can reproduce it.

## 4. Names, authorship and royalties

Addresses are the default attribution. A holder may opt in to displaying a name or ORCID through an authorized binding; do not infer a person's identity from an address. Freeze the approved display information with the release. A self-declared name or ORCID is not independent identity verification.

Holder acknowledgment does not confer paper authorship. Authorship follows actual intellectual contribution and applicable publication requirements. Holding an NFT does not buy a favorable result, influence analysis thresholds or grant exclusive access to public research data.

Acknowledgment and royalties are separate. The snapshot does not create or freeze a payment right. Future service royalties, accrued credits and NFT transfers follow the applicable contracts; no revenue is guaranteed. Relevant financial interests should be disclosed in the publication.

## 5. Optional additional recognition

A research team may separately acknowledge original funders, breeders, compute providers or other contributors if useful. Those additional lists need their own evidence and criteria. They are not prerequisites for the default holder snapshot and do not require a complete historical contribution ledger to publish it.

## 6. Current tooling

The paper builder and live holder endpoint already provide holder-list plumbing. They are not yet the complete release-snapshot implementation: the current builder enumerates the collection's holders rather than taking a version-specific included-NFT manifest, and it does not record all metadata required above. Before publishing a release list, verify the included NFT set, common block, block hash, ordering and frozen output. This policy update does not claim that the generator or optional identity binding has been implemented.
