# A terminal path for adopt / breed / hatch / withdraw

## The gap

`skills/flybnb/SKILL.md` has to tell an agent that the four things a fly's OWNER most wants to do cannot be
done from a shell at all:

- **adopt** — buy a founder from the treasury inventory
- **breed** — pair two flies, which funds a battery for the child
- **hatch** — turn an egg into an individual (and `rearm` when its seed block ages out)
- **withdraw** — collect the royalties the owner has earned

All four exist only in `frontend/src/core/flies.js`. So a user who wants to operate through an agent hits a
wall on exactly the operations that are theirs, and an agent that tries anyway is writing raw calldata
against a contract nobody reviewed with it.

## What they actually are, on today's main

Read out of `frontend/src/core/flies.js`, which is the reference implementation:

| operation | call | value |
|---|---|---|
| adopt | `TreasuryInventorySale.buy(id, price, revision, deadline)` | `price` |
| breed | approve the factory for both parents, then `batteryBudget.breed(dam, sire)` | `BREED_FEE + budget` |
| hatch | `FlyCollection.hatch(id)` | 0 |
| rearm | `FlyCollection.rearm(id)` | `BREED_FEE` |
| settle | `FlyCollection.settle(id)` | 0 |
| withdraw | `FlyCollection.withdraw()` | 0 |

Adoption is a **transfer of an existing NFT**, never a mint: the listing is `listings(id)` →
`(price, expiresAt, revision)` and `available(id)`, and the seller is the treasury.

## Plan

- [x] `js/fly.mjs`, one CLI with subcommands, in the shape of `js/greenfield_admin.mjs`
- [x] bootstrap from `--relayer <url>` (what an outside user has) OR the sourced `.env.<network>` (what an
      operator has). A user with neither gets told which to supply.
- [x] read-only subcommands first and free: `terms`, `list`, `inventory`
- [x] **every writing subcommand is a dry run unless `--broadcast`** — the pattern
      `js/launch_founder_inventory.mjs` already establishes. It prints the exact call, the exact value, and
      who receives it, and sends nothing.
- [x] the key comes from `FLY_KEY` (falling back to `PORW_DEPLOYER_KEY`) and is never printed, logged or
      written anywhere
- [x] refuse on the wrong chain, on a listing that has moved (price/revision), on a pair that cannot breed,
      and on the token battery route — which needs a liquidity quote and stays on the page for now
- [x] `test/fly_cli.mjs`: deploy a collection on anvil and drive every subcommand end to end, including that
      a dry run sends NOTHING and that `--broadcast` sends exactly one transaction
- [x] update `skills/flybnb/SKILL.md`: the four operations move out of "no terminal path" into commands, and
      `test/skill_flybnb.mjs` must be the thing that forces that update

## Review

`js/fly.mjs`, one CLI, dry-run by default. 23 checks in `test/fly_cli.mjs` drive it as a subprocess against a
real collection on anvil, including the two that matter most: a dry run moves no nonce, no balance and no block,
and the key never appears in anything the tool prints.

Two bugs the work caught, both of the same kind -- a guess about someone else's code:

1. `FlyCollection.sol` has `FEMALE = 0, MALE = 1, UNHATCHED = 2`. The first draft assumed 0 meant "egg", so it
   labelled all 100 female founders as eggs and would have refused every legitimate breeding pair. Nothing about
   it errored; it was caught by running `inventory` against the live testnet and reading the output.
2. `viem` nests the contract's revert reason; `metaMessages[0]` is the call trace, not the reason. Two wrong
   guesses in a row here, fixed by printing the actual error object instead of guessing a third time.

The skill test did NOT force the skill to be updated when this landed -- it decided "is there a CLI" from the
filename, and `js/fly.mjs` is named for none of the four operations. That was the exact drift it existed to
prevent, so the check now works from capability in both directions: anything the skill calls browser-only must
have no command, and anything with a command must not be listed as browser-only. Both directions were shown to
fail before being trusted.
