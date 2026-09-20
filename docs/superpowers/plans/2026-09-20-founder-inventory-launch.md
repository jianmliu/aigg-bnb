# Founder inventory launch

Authorized: BSC testnet replacement collection, 200 verified Founder NFTs in treasury inventory, 0.01 tBNB adoption, existing TreasuryRouter recipient, and relayer/UI cutover after verification. Preserve old NFTs.

1. Add a mint authorization hook that leaves legacy FlyCollection behavior unchanged. TreasuryFounderCollection fixes zero mint price/bond and denies genesis mint until its deployer binds exactly one vault. Check collection, recipient and owner when binding. Vault-only mint thereafter.
2. Add owner-only atomic stock batches to the fixed vault: mint, register provided MEP and list. Validate failures revert the complete batch; verify unauthorized mint/stock, one-time binding and treasury proceeds.
3. Prepare a resumable deployment script using verified genesis/profiles. Persist each confirmed deployment/transaction immediately, enforce chain 97, expected deployer/treasury ownership, adequate gas and no pending deployer nonce. Dry-run the same flow on Anvil before broadcasting.
4. Deploy collection, renderer and vault/sale; bind vault; populate 200 Founders with explicit 0.01 tBNB quotes and expiry. Verify all ownership/profile/price/availability records and declared execution kinds. Preserve legacy collection records.
5. Add new collection to whitelist and update render.yaml/PORW_COLLECTION/PORW_INVENTORY_SALE without overwriting unrelated env values. Restart/deploy relayer and verify public API, frontend listings and a test adoption receipt/treasury inflow.
6. Record addresses, transactions and remaining Breed worker/budget limits. Commit, PR and merge tested deployment records and code so main-based releases retain the cutover.

## Review refinements

- Pause sales before stocking. Validate the entire inventory while purchases are disabled, then activate. This prevents early buyers breeding and shifting Founder token IDs during batched minting.
- Verify consensus profile fields; tolerate a registry hint front-run only when the confirmed stocking receipt contains the collection's matching WeightsHint.
- Reconcile a recorded activation receipt before choosing resume checks. After activation, public adoption/breeding is legitimate and must not block resumption.
- A confirmed failed smoke purchase may be skipped only when token 1 belongs to a public buyer. Pending or uncertain transactions still require investigation.
- Reserve gas for the whole launch, journal transaction hashes before broadcast, and fingerprint contract artifacts in the journal configuration.
