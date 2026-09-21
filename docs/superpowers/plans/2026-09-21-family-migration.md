# Family mesh migration

Authorized by user: migrate supporting contracts and collection on BSC testnet to activate approved base-resident/delta-on-demand hosting.

- [x] Snapshot old mesh parameters, owner balances, inventory and outstanding task/host obligations. Keep legacy contract addresses and claims recoverable. Never transfer user bonds or silently discard gateway requests.
- [x] Extend the resumable inventory launcher for base-bound MEP IDs and paused preparation. Test the exact 200-Founder flow on Anvil with base enrollment and shared capacity enabled.
- [x] Deploy a new mesh with the existing testnet parameters, base enrollment and shared capacity. Reuse existing treasury and published genesis/deltas. Register all four base profiles and both LIF weight units. Preserve transaction journals.
- [x] Pause old inventory sales; verify all 200 owners remain the old vault. Deploy and verify new collection/vault/sale at unchanged prices. Preserve old NFTs and treasury balances. Abort cutover if external ownership or outstanding gateway activity needs reconciliation.
- [x] Configure Render relayer and gateway consistently, preserve credentials and set the approved public RPC, publish main configuration and records. Enable new inventory only after verification. Verify familyHosting, capacity wiring, Adopt and Host UI.
- [x] Document old bond withdrawal/new bond and capacity opt-in; no automatic movement of user funds. Record any unresolved legacy obligations explicitly.
