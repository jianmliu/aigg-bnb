---
name: flybnb
description: Use when running an experiment on a real fly connectome through the FlyBnB mesh, reading what a brain did, checking a fly's measured standing, inspecting mesh/epoch/host state, or verifying a brain's content address. Covers the gateway's experiment API, the relayer's public read-only routes, and states plainly which operations have no terminal path at all.
---

# FlyBnB, from a terminal

FlyBnB is a mesh of hosts that each hold a whole fly connectome resident in memory and get paid to run
experiments on it. Everything is content-addressed: a brain is named by the Merkle root of its own bytes, and
two hosts that disagree about what a run produced cannot both be paid.

For an agent this means one useful thing: **you can ask a real fly brain what it does, and get an answer that
two independent machines agreed on.** That is what the gateway is for, and most of this skill is about it.

What an owner does with a fly — adopt, breed, hatch, collect earnings — is `js/fly.mjs`, below. Everything it
writes is a dry run until `--broadcast`, so you can show the user exactly what a command would do, and what it
would cost, before anything is spent.

## Money and safety — these are not negotiable

- **Never print, log, echo, or write a private key anywhere**, including into a file the user asked for. Keys
  live in `chmod 600` gitignored `.env.*` files; load them with `source` or `--env`, never by reading them out.
- **Every paid call spends the fee wallet's real money.** Confirm with the user before the first one in a
  session and before any change in scale (more steps, more redundancy, a batch). One approval is not standing
  permission for the next twenty.
- **Quote the price before spending it.** The formula is below and it is exact; compute it and say the number.
- Read-only work needs no permission. Do as much of it as you can before asking for anything.

## Start here: what is up, and what it costs — no credentials at all

Every tool bootstraps from one call. This is the only URL you need to know:

```bash
curl -s https://aigg-bnb-relayer-testnet.onrender.com/deployment | python3 -m json.tool
```

It returns the chain id and RPC, every contract address, the relay's websocket URL, the EIP-712 domains,
`epochBlocks`, `claimValidityEpochs`, `challenge`, `brainMirrors`, and the brains this deployment serves. Take
addresses from here rather than hardcoding them; a redeploy moves them.

The other public read-only routes on the same host (`relayer/relayer.mjs:335-405`), none of which need a key:

| route | what it answers |
|---|---|
| `GET /meps` | which brains are served, and how many providers and votes each has |
| `GET /status` | block, epoch, relay traffic, aggregator claim counts |
| `GET /epoch?mep=0x…` | the epoch, whether the beacon has rolled, and this brain's challenge |
| `GET /hosts?instance=0x…` | one instance's host stats and which models it is eligible for |
| `GET /proof?mep=&epoch=&instance=` | the Merkle proof for a residency claim, or 404 |
| `GET /flybnb/holders` | who holds flies in the collection |

A model with fewer providers than `min_redundancy` (2) is **cold** and a paid call against it will be refused
before it costs anything. Check first:

```bash
curl -s https://aigg-bnb-relayer-testnet.onrender.com/meps | python3 -c 'import json,sys
for m in json.load(sys.stdin): print(f"{m.get(\"name\",\"?\"):46} providers={m.get(\"providers\",0)}")'
```

## Running an experiment

The gateway speaks the OpenAI Responses API, so any OpenAI client works — but **the prompt is not text, it is
an experiment**. This is the one thing no agent guesses right, so it is spelled out here.

```bash
curl -s "$GATEWAY_URL/v1/responses" \
  -H "Authorization: Bearer $GATEWAY_BEARER" -H 'content-type: application/json' \
  -d '{
    "model": "flywire-783-min5",
    "input": {
      "stimulate": { "set": "sound" },
      "readout":   { "top": 10 },
      "seed": 0,
      "steps": 100,
      "redundancy": 2
    }
  }'
```

`input` is a JSON object (a JSON *string* is parsed as one; free text is a 400). Its fields
(`gateway/gateway.mjs:158-183`):

| field | meaning |
|---|---|
| `stimulate` | `{ "set": "<name>" }` or `{ "ids": [neuron indices] }` — what to drive |
| `silence` | same shape — what to hold off, which is how you ablate |
| `readout` | `{ "top": 1…1000 }` (the most active) or `{ "ids": [...] }` (named neurons) |
| `seed` | uint32, default 0 — the run is deterministic in it |
| `steps` | 1 … 20000 for `int-lif`; default 100 |
| `redundancy` | 2 … 16 — how many independent hosts must agree |

`cell_type` is **rejected**: this gateway carries no cell-type table, so pass indices.

**Put `seed`, `steps` and `redundancy` inside `input`, not at the top level.** They are accepted in both
places and the inner one wins, but a request routed through an OpenAI-compatible front end has its unknown
top-level fields dropped and `max_output_tokens` deleted outright — the message body is the only thing that
always survives (`gateway/gateway.mjs:164-166`).

Stimulus sets this deployment knows, from `gateway/pricing.json`:

`ocelli`, `sound_left`, `bitter`, `taste_peg`, `sound_gate`, `sound`, `moist`, `sugar`, `wind`,
`head_bristle`, `eye_bristle`, `cold`, `pheromone`

`GET /v1/models` (bearer required, spends nothing) lists every brain with its `mep_id`, `neurons`, `synapses`,
`providers`, `available`, `min_redundancy`, `wei_per_token`, and its own `set_factors`.

### What it costs, exactly

```
tokens = steps × redundancy × model_factor × set_factor
fee    = tokens × wei_per_token          (wei_per_token = 100 gwei = 1e11 wei)
```

`model_factor`: `flywire-783-min5` 1.00, `flywire-783-min2` 1.54. `set_factor`: 0.28 (`ocelli`) … 2.64
(`pheromone`), 1.00 when no set is named. These are measured host cost, not a markup.

So the call above — 100 steps × redundancy 2 × 1.00 × 0.55 — is 110 tokens, **1.1e13 wei = 0.000011 BNB**.
Compute this and tell the user the number before you spend it. A 5,000-step battery run at redundancy 2 on
min2 with `pheromone` is 5000 × 2 × 1.54 × 2.64 = 40,656 tokens = 0.0040656 BNB — three orders of magnitude
more, from the same shape of request.

### When it refuses

A refusal costs nothing. These are normal, not errors to retry blindly:

| status | code | what to do |
|---|---|---|
| 503 | `model_cold` | too few hosts hold this brain. Honour `retry_after`; tell the user the mesh is cold rather than retrying in a loop |
| 503 | `epoch_cold` | the network is asleep; the gateway already tried to wake it and gave up. Same handling |
| 503 | `gateway_unfunded` | the fee wallet is empty — a human has to top it up. Do not retry |
| 400 | `invalid_request_error` | the message says exactly which field is wrong; fix it, do not resend unchanged |
| 504 | — | posted but no result before the timeout; the market refunds at its own timeout |

**As of the last check every model on the public testnet gateway was cold** (providers 0–1 against a minimum
of 2). That is the normal resting state of a testnet: hosts come and go. Check `/meps` first and tell the user
plainly instead of burning a minute on retries.

### Reading a result

The answer arrives as JSON inside `output[0].content[0].text`: an `exec_digest` plus the readout. Two more
free routes:

```bash
curl -s "$GATEWAY_URL/v1/responses/$ID"              -H "Authorization: Bearer $GATEWAY_BEARER"
curl -s "$GATEWAY_URL/v1/tasks/$TASK_ID/counts"      -H "Authorization: Bearer $GATEWAY_BEARER" -o counts.bin
```

The second is the raw spike count per neuron, `u32` little-endian, one per neuron — headers `x-neurons` and
`x-exec-digest` say how many and which run. It is served only once the counts are verified.

`usage.total_tokens` is what was charged. `receipt` and `executors` name the on-chain task and who ran it:
that is the part an ordinary API cannot give you, and it is worth showing the user.

## A fly's measured standing

A fly's rarity is not invented — it is measured, or it is absent. `flybnb/results/phenotypes/individuals-v1.json`
is keyed by the delta hash the token carries, and a fly whose battery has not been run **has no entry**, which
is the honest answer until someone pays for the runs. Regenerate or check with:

```bash
node flybnb/analysis/phenotype_rank.mjs --check
```

## Verifying a brain

A brain is its content address. You never have to trust where the bytes came from:

```bash
# fetch from a storage provider and verify against the on-chain model_id before writing
source .env.bsc-testnet && node js/fetch_brain.mjs <mepId> brain.bin

# or from the mirror, which costs no storage-provider quota (parts + reassembly)
curl -s https://aigg-brains.pages.dev/aigg-brains/flywire-fafb-v783-min2.bin.parts.json

# what a local payload's content address actually is
node contracts/lib/aigg-porw/web/porw-browser/model_id.mjs brain.bin
```

The published bases and their addresses are in `flybnb/README.md`. Both were rebuilt from the public FlyWire
release on 2026-09-20 and matched byte for byte, so a brain nobody is serving is still recoverable by anyone
holding the papers — see `tasks/live-runs/live-gateway-2026-09-20T07-55-00Z.rebuild.json`.

## Local analysis, no chain, no money

The pilot's scripts run offline on a downloaded payload — Python 3 with numpy, and the
`contracts/lib/aigg-porw` submodule. `flybnb/README.md` is the reference; the entry points are
`flybnb/analysis/intlif.py` (the runner, `--verify` holds it to the published digests),
`phenotype_variance.py`, `run_battery.py`, and the report scripts beside them.

```bash
python flybnb/analysis/intlif.py --verify --min5 flywire-783-min5.bin
```

## Running a battery, and hosting

Both spend money and both need the user's own key. Do not start either without being asked.

```bash
# post the standard battery as one batched task; FLYBNB_REQUESTER_KEY pays the fee
FLYBNB_REQUESTER_KEY=… node flybnb/battery/post_battery.mjs \
  --relayer <url> --payload brain.bin --name NAME [--fee 0.01] [--redundancy 2]
```

The requester must be in the relayer's `PORW_TASK_CLIENTS` or it exits 1 before spending anything.

**Hosting headlessly is possible but is not packaged.** The only end-to-end headless host is
`test/live_bsc.mjs` — it bonds, delegates a session key, holds the brain resident, announces residency each
epoch, executes tasks and settles. It lives in `test/`, is not an npm script, and it also posts and
self-executes one task because it was written as an evidence run. Treat it as a reference implementation, not
a product. Tell the user that rather than presenting it as "the host command".

## Being a fly's owner: adopt, breed, hatch, withdraw

`js/fly.mjs` is the whole owner's side from a terminal. **Every writing command prints the exact call, the exact
value and who receives it, and sends nothing without `--broadcast`** — so run it without the flag first and show
the user that output. The key comes from `FLY_KEY` and is never printed; what is shown is the address it derives
to, which is what the user should check.

```bash
node js/fly.mjs terms      --relayer <url>     # what the collection charges            (free, no key)
node js/fly.mjs list       --relayer <url>     # every individual, its holder, earnings (free)
node js/fly.mjs inventory  --relayer <url>     # what the treasury has open, with prices(free)

node js/fly.mjs adopt 12   --relayer <url>                 # shows what it would do
node js/fly.mjs adopt 12   --relayer <url> --broadcast     # and this does it
```

| command | what it does |
|---|---|
| `adopt <id>` | buys a founder from the treasury inventory. An **existing NFT moves**; nothing is minted. The price and revision read from the listing are passed back to the contract, so a listing that moved reverts instead of charging a price nobody quoted |
| `breed <dam> <sire>` | approves the factory for both parents, then pairs them. Costs `BREED_FEE` plus the battery budget that funds the child's runs. The child is an **egg** |
| `hatch <id>` | turns an egg into an individual, fixing what it is from its seed block's hash. Pays the hatcher a bounty |
| `rearm <id>` | an egg whose seed block aged out of reach. Costs another breed fee — say so before running it |
| `settle <id>` | moves what a fly's experiments set aside into its owner's balance |
| `withdraw` | collects everything owed to you |

Sexes are `female`, `male`, and `egg (unhatched)`; breeding needs a female dam and a male sire, and an egg cannot
breed. The tool checks all of that, and every listing and ownership condition, **before** it would spend anything.

Two things it will not do, and should not be worked around:

- **the token battery route** for breeding needs a liquidity quote, which stays on the page for now. `breed`
  refuses and says so rather than guessing a price.
- **a deployment with no battery budget** cannot breed at all; `breed` says that too.

If a command refuses, the message is the contract's own words. Read it to the user rather than retrying.

## What has no terminal path

Still browser-only, at `https://fly.ai.gg`:

- **bond** an instance, and **request/finalise its exit** — putting up or taking back the stake that makes a host
  eligible. `test/live_bsc.mjs` bonds as part of its evidence run, but there is no command for it on its own.

If the user asks for one of these, say so and point them at the page. Do not improvise raw `cast` calls against
the ABIs unless they explicitly ask and understand they are signing an unreviewed transaction.

## Where the detail lives

- `docs/GATEWAY.md` — the authoritative gateway spec: the experiment, the life of a call, cold refusals,
  money and royalties
- `flybnb/README.md` — the brains, their content addresses, and how to reproduce the pilot
- `README.md` — the mesh itself, and how the pieces fit
- `node js/fly.mjs --help` — the owner's commands, always current with the code
