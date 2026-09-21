# Relayer RPC reduction

Approved scope: reduce redundant RPC now without changing consensus or contracts.

- Build each MEP aggregator once per epoch; do not re-read its challenge on every tick.
- Share successful rolled-epoch challenge reads between tick and the epoch API. Never retain a cold-epoch challenge as immutable.
- Coalesce epoch API snapshots for one second. Coalesce host eligibility by address, epoch and catalog membership for five seconds; limit each scan to four reads in flight. These are display caches, not transaction authorization.
- Back off unregistered NFT scans from one to eight whitelist intervals (default 20 to 160 blocks). New token IDs are checked immediately at the next whitelist walk; registered bindings remain cached. Discovery after a delayed registration may take the capped interval.
- Failed reads are not cached as successful data. Caches are bounded and process-local. No persistent cache or deployment change.

Verification: read-count unit tests, concurrent requests, expiry, failed-read retries, bounded concurrency, unbound backoff, lazy beacon lifecycle and whitelist registration/removal integration tests. Existing provider catalog already uses cached Multicall on BSC and is retained.
