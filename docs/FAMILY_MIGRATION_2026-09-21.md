# BSC testnet family deployment — 2026-09-21

The subsequent [synchronous verification migration](SYNCHRONOUS_MIGRATION_2026-09-21.md) supersedes this active deployment. This record retains its historical addresses and obligations.

This deployment replaces the active non-upgradeable mesh and Founder inventory so hosts enroll by root base, keep that base resident, and load assigned descendant deltas on demand. It enables shared capacity admission in the task market. It does not add sampled claims or an automatic on-chain dispute responder.

The published genesis v2 and delta assets are unchanged: 100 female and 100 male Founders. Each new child MEP binds its root plus the new collection's royalty terms. Token numbers are local to a collection; the new NFTs are not transfers or burns of the old NFTs.

## Addresses at this migration (chain 97)

| Contract | Address |
| --- | --- |
| Collection | `0xef927d0e5e5b919dfba91eb816fbf5a284e33498` |
| Inventory vault | `0x82aa778934a6b9577411dae24e37e039074f23b4` |
| Inventory sale | `0xd974C8c0c18D31AfdEfa0630D06E3960Ee681291` |
| Treasury (unchanged) | `0x1Bef7990Ea5d9C761aACe71c48432078AAC43708` |
| MEP registry | `0x19de92004c19ea6860641738a8b1e5656e7efb16` |
| Instance registry | `0x91a99283d7cb667b42c0121b877006456deb83a4` |
| Task market | `0x3e89d16f05cfd9919fb473eb4657289ca9c8b5db` |
| Host capacity | `0x02ff13eaa571e407fe535b355634eb4cc1a2372c` |

All mesh addresses, parameters and confirmed transaction hashes are in [the public deployment record](../tasks/live-runs/family-migration-2026-09-21.json). `render.yaml` specifies matching relayer and gateway addresses. Both services use `https://bsc-testnet-dataseed.bnbchain.org/`; their credentials are preserved.

Adopt remains 0.01 tBNB, all proceeds to the existing treasury. Breed remains 0.005 tBNB with a 0.0001 tBNB hatch bounty. Execution royalty is 1,000 bps, base share 1,000 bps, and resale royalty 500 bps. Battery budget/worker and token conversion adapters are separate deployments; this migration does not enable them.

## Legacy assets and obligations

At the migration audit, all 200 NFTs of collection `0xb42dfb7b281535ddc836b3de8df62e5f59b5b7c5` belonged to inventory vault `0x235ed095a6cffd45c067d12863d8df7c71d9e7f5`. No external holder or offspring required a replacement claim. The old sale `0x9668397498C564DB5e604b1156EEE97Ed6A62f62` is paused. Old NFTs remain intact; do not reopen the old sale alongside the replacement inventory.

Thirteen expired, unsubmitted tasks in old market `0x71120BcF8EFDcc6E4c0299e035676dB6d0d68F19` were settled, refunding 0.026 tBNB to their original client, the deployment wallet. The remaining 0.000204 tBNB is owed as royalties: 0.000004 to the historical base beneficiary and 0.0002 to the old collection. Those claims remain against the old contracts; no royalty was swept into the replacement market.

Old InstanceRegistry `0x50b015f2a2a04E2D177343bE4bDB652AFf8100B1` retains 0.0712 tBNB in three host bonds:

| Instance | Bond (tBNB) |
| --- | ---: |
| `0x3b3156A32dB1944F14bC152C42960D3b51DCDD19` | 0.0051 |
| `0x966d94F5504a6BD4B34Ed6D667aB41C2919006D2` | 0.0051 |
| `0xFE560Af8f5cFC209794b3Df7DC7E281D4Ef81EDa` | 0.061 |

A host controls its own withdrawal: call `requestExit()` on the **old registry**, wait until its `exitAt` block (200-block delay), then call `finalizeExit()` from the same instance wallet. An open dispute hold prevents finalization. Keep the old session wallet and replay evidence until its obligations finish. Neither the relayer nor this migration moves these bonds automatically.

For new service, enroll and bond to the desired base in the **new registry**, then opt into shared capacity. Capacity defaults to zero. Start with one slot for the current serial browser executor. A previous bond/claim does not qualify a host in this fresh registry; generate new base claims. More declared slots do not prove physical memory or increase the weight of an individual draw.

The gateway's six persisted historical calls were all settled and undisputed (three completed, three no-result refunds). Their old state and count files are retained at `/var/data/gateway-state.json` and `/var/data/gateway-state.json.counts`. New calls use `/var/data/gateway-family-v1-state.json`; old calls are not replayed against a different market. Historical response IDs are not served by the new active state and require the retained archive to inspect.

The audit reconciled the full balances of the old market and instance registry. RPC historical log coverage was incomplete, so the record does not claim a complete reconstruction of every historical event.

## Reproduction and recovery

`js/migrate_family_mesh.mjs` deploys the fresh mesh from a public configuration, checks all wiring and registers the four unchanged root profiles. `js/launch_founder_inventory.mjs --base-enrollment --journal <separate-path> --no-activate --no-smoke` stages the new collection. Never reuse the legacy inventory journal. After verifying all 200 owners, listings, identities, enrollment routes and delta hints, rerun with activation enabled.

Both scripts save exact signed transaction bytes before broadcast and resume by re-sending those bytes, not by allocating a replacement nonce. Private journals are mode 0600; the public record strips signed bytes. Preserve original private journals for recovery and do not run competing deployments from the same account.

Validation: Anvil mesh deployment/recovery and full legacy/base-bound 200-Founder inventory flows; interruption before broadcast; staged resume; Adopt payment and return/relist; Render blueprint/environment mapping; production frontend build. Live transaction and cutover evidence is recorded with the public deployment record.

## Service cutover verification

PR #93 merged as `20316cda027f4af0e53929eb010171118a742bbc`; both Render services and the Pages frontend were deployed from that commit. The live relayer reports `familyHosting: true`, 204 MEPs, and an authorized shared-capacity registry. The Host page offers four root families. Adopt loads 200 Founders in 17 pages of up to 12. The gateway is out of maintenance, connected to the new market, with zero new calls at cutover.

Known operational limitation: the selected public BSC RPC still rejects the existing keeper event-log scan with `Request exceeds defined limit`. This predates the migration and is not resolved by redeploying contracts; automatic event discovery needs a separate RPC/scan fix. Browser task execution, a production Breed round and new host qualification have not been live-tested as part of this cutover. Host owners must re-enroll before the fresh market can serve tasks.
