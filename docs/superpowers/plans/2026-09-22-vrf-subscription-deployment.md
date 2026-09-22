# VRF subscription deployment

User-approved approach: create a Chainlink v2.5 subscription programmatically, fund native BNB, and enroll the actual VrfAdmission consumer. No Render or NFT cutover in this step.

1. Add an Anvil subscription-coordinator fixture and end-to-end test. Exercise create, native funding, real market/controller deployment, enrollment and restart without duplicate funding. Reject changed journal config and wrong owner/network.
2. Extend the existing resumable mesh deployment to synchronous-vrf-v1. Authorize controller leases and bond holds; preserve legacy behavior and journals.
3. Add a resumable subscription CLI. Persist signed bytes before broadcast, parse the subscription ID from the coordinator's confirmed receipt, enforce chain 97 and owner, cap gas and preserve 0.02 tBNB. Fund exactly once; verify subscription owner, native balance and consumer binding.
4. Run the Anvil tests and existing preflight tests. Deploy on BSC testnet with 0.01 tBNB initial funding and a new private journal. Read back configuration and subscription. Record public addresses/receipts separately from signed transaction journals. Actual VRF delivery remains unverified until a real task is posted.
