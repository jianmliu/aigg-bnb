# Mainnet deployment plan: `ai.gg` on Cloudflare, BSC mainnet, a long-running relayer

Status: **plan, not executed.** Decisions taken: settlement on **BSC mainnet (chain 56)**; the node page on
**Cloudflare Pages** at `ai.gg`; the relayer as a **long-running service on Render** behind Cloudflare for TLS
and `wss://`; the brain payload **mirrored to R2** with Greenfield remaining the authoritative,
on-chain-referenced copy.

Numbers marked *assumed* are inputs, not measurements. Measured gas below comes from the live BSC testnet run
recorded in the README (2026-09-17), not from the estimates in `docs/DESIGN.md` §5 — where the two disagree,
the measurement wins.

---

## 1. Name layout

| name | serves | how |
|---|---|---|
| `fly.ai.gg` | the node page (static) — **the name in use today** | Pages project `aigg-fly`, custom domain on the subdomain |
| `ai.gg` | the node page, once it is not a testnet page | same Pages project, custom domain on the apex (CNAME flattening) |
| `api.ai.gg` | relayer HTTP API (`/deployment`, `/meps`, `/epoch`, `/proof`, `/status`, `/tx/*`) and the WebSocket relay hub at `/relay` | CNAME → the Render service, proxied |
| `brains.ai.gg` | the model payload mirror | R2 bucket, custom domain binding |

The page went up on a subdomain first on purpose. A Pages project can carry both names, so promoting it to the
apex later is adding a custom domain, not a migration — and until the §6 blockers are closed, the apex is better
left not resolving at all than resolving to something that says testnet.

One hostname covers both relayer roles because **Render exposes exactly one port per service** and the relayer
currently opens two (§4). Keeping the relay hub on a path of the same origin is the smaller change and has a
side benefit: one TLS name, one Cloudflare rule set, one thing to monitor.

This plan assumes the `ai.gg` registration is in hand and its DNS is on Cloudflare. Nothing below depends on the
specific name — substitute freely.

---

## 2. The page on Pages

The page is a Vite + React build (`frontend/`), and what Pages serves is `frontend/dist` — a directory of static
files, no build image, nothing rewritten on the way out. `npm run build:frontend` produces it; `npm run
preview:frontend` (`frontend/serve.mjs`) serves that same directory over plain HTTP, and so does the end-to-end
test, which means `test/e2e_frontend.mjs` exercises the bytes that ship rather than a dev-only assembly of them.

**What the build has to do beyond bundling.** Two directories are served as URLs rather than bundled:
`/porw/` (the aigg-porw browser modules) and `/vendor/` (the two noble packages). `frontend/vite.config.mjs`
marks both external and `frontend/build/runtime.mjs` copies real files to those paths — serving them from the
repo in dev, writing them into `dist/` on build, rewriting `@noble/…` to `/vendor/@noble/…` as it goes, since a
bare specifier means nothing to a browser.

They stay external because of the worker. `public/node_worker.js` is a module worker and imports the same
`/porw/` modules the document does, and **a module worker does not inherit the document's import map**. Earlier
drafts of this section described an import map in `index.html`; there is none, and there cannot usefully be one,
for that reason. Bundling `/porw/` fails the same test from the other side — it would give the document a
private copy the worker could not reach. Real files at real URLs are the only arrangement both of them resolve
identically, and it happens to be exactly the arrangement Pages wants.

```
dist/
  index.html
  assets/index-<hash>.js      <- the page: React, the controller, the ABI helpers
  assets/index-<hash>.css
  node_worker.js              <- verbatim from frontend/public; imports /porw/ by URL
  porw/                       <- contracts/lib/aigg-porw/web/porw-browser (incl. sketch.wasm)
  vendor/@noble/...
```

**No COOP/COEP, and therefore no `_headers` for it.** The node runs the single-memory kernel in a plain worker
and never touches `SharedArrayBuffer`, so the page does not need `cross-origin-opener-policy: same-origin` and
`cross-origin-embedder-policy: require-corp`, and `frontend/serve.mjs` sends neither. That is worth keeping:
`require-corp` would force **every cross-origin resource the page fetches to be CORS-clean or carry
`Cross-Origin-Resource-Policy: cross-origin`** — including a 28 MB brain fetched from the mirror (§3) or from a
Greenfield SP, neither of which is under our control. Restoring the multi-threaded kernel means taking those
headers back on deliberately, and at that point the mirror and every SP fallback have to be CORP-clean before
the page works at all.

**Caching — `frontend/public/_headers`.** Vite hashes `assets/*`, so those are immutable, but `index.html`,
`node_worker.js`, `porw/` and `vendor/` ship at fixed paths and change contents whenever the submodule moves.
The failure mode is specific: a browser holding a cached `/porw/` module against a freshly deployed bundle,
producing a `mep_id` that no longer matches what the registry has — a silent claim rejection rather than an
error anyone would notice. So the unhashed paths get `max-age=300, must-revalidate` and `/assets/*` gets a year.
Five minutes of freshness costs a conditional request per deploy and removes that failure entirely. The file
lives in `public/`, so Vite copies it to the output root where Pages looks for it.

**Deploy: GitHub Actions + `wrangler`, not a Pages git build.** `aigg-porw` is public now, so Pages' own git
integration *can* clone the submodule and build there. It builds here instead — `.github/workflows/pages.yml`,
on pushes to `main` that touch `frontend/`, the submodule or the lockfile:

- the artifact is inspectable and reproducible, rather than produced inside Pages' build image
- it pins exactly which `aigg-porw` commit is live, which matters more here than it looks: `mep_id` is derived
  from the scheme and exec kind that code implements, so a silent submodule drift makes every claim the page
  produces get rejected against the registered MEP
- it gates the deploy on `test/frontend_memory.mjs`, which needs neither a browser nor a chain. The full
  end-to-end test needs anvil and Foundry and is not run there

The workflow needs three repository settings: secrets `CLOUDFLARE_API_TOKEN` (a token with **Cloudflare Pages:
Edit** on this account) and `CLOUDFLARE_ACCOUNT_ID`, and the variable `RELAYER_URL`, which is baked into the
build as the relayer box's default (`VITE_RELAYER_URL`). Leave `RELAYER_URL` unset and the build falls back to
`http://127.0.0.1:8788`, which an https origin blocks as mixed content — so setting it is not optional for a
deployed page.

By hand, from a checkout with the submodule initialised:

```
wrangler login                  # once; the browser flow, on your own account
npm run deploy:frontend         # build:frontend, then wrangler pages deploy frontend/dist
```

`--branch=main` is explicit in both paths. Pages serves the *production* branch at the custom domain; a deploy
from any other branch becomes a preview URL and `fly.ai.gg` does not move. The first `wrangler pages deploy`
creates the `aigg-fly` project; the custom domain is attached once, in the dashboard (Pages → aigg-fly → Custom
domains → `fly.ai.gg`), and Cloudflare writes the DNS record itself because the zone is already there.

**The page and the relayer are two different origins, and always will be.** The page is static files on Pages
(`fly.ai.gg`); the relayer is a long-running process on Render (§4) — stateful, holding aggregation state in
memory and signing with a hot key, which is exactly the shape Pages cannot host. Nothing about that is
temporary, so three things have to line up across the two deployments:

| what | set where | to what |
|---|---|---|
| `VITE_RELAYER_URL` | the Pages build (repo variable `RELAYER_URL`, or the local environment) | the relayer's **https** origin — `https://api.ai.gg` once that CNAME exists, the Render hostname directly before it does |
| `PORW_PUBLIC_RELAY_URL` | the relayer's env on Render (§4(3)) | `wss://…/relay` — what `/deployment` hands to browsers. An `https://fly.ai.gg` page refuses a `ws://` hub on scheme alone |
| `PORW_RELAY_PATH=/relay`, `PORW_HOST=0.0.0.0` | same | one port serves both the API and the hub, because Render routes exactly one (§4(2)) |

Only the first of those is a frontend concern; the page hard-codes nothing else about the relayer, because
everything else — chain id, contract addresses, the relay URL — arrives from `/deployment` at runtime. Which is
also why pointing the box at a different relayer is a complete reconfiguration of the page.

CORS is already handled and should stay that way: `relayer.mjs` answers every response with
`access-control-allow-origin: *` and replies to `OPTIONS` preflights, which the `/tx/*` POSTs need because they
send `content-type: application/json`. It is not an oversight that the origin is `*` — the relayer is
deliberately replaceable and anyone may run one, so locking it to `fly.ai.gg` would be locking the wrong door.
What protects those endpoints is the sponsorship guard (§4), not the origin header.

**Edits to the page itself:**

- ~~the relayer box defaults to `http://127.0.0.1:8788`~~ — done: the default is `VITE_RELAYER_URL` at build
  time (`frontend/src/ui/App.jsx`), falling back to `http://127.0.0.1:8788` for local development. The field
  stays editable, which is the whole reason the relayer is replaceable.
- `autofillUrl()` (`frontend/src/core/controller.js`) fills the payload URL from the `sp` field only. Add the
  mirror as the default source (§3) so a first-time visitor does not have to know what a storage provider is.

**The payload does not live here.** Pages caps an individual file at 25 MiB and the payload is **28,123,136
bytes** — over the cap. It could not live in `dist/` even if we wanted it to, which settles §3 on its own.

---

## 3. The brain on R2

Put the object in R2, bound to `brains.ai.gg`, under a content-addressed path so it can be cached forever:

```
brains.ai.gg/flywire-fafb-v783-min5/<model_id>.bin
Cache-Control: public, max-age=31536000, immutable
Cross-Origin-Resource-Policy: cross-origin
CORS: allow https://ai.gg (GET, HEAD)
```

`model_id` for the registered MEP is
`0x9747cc81830375103eae957a93d3800875223c17bdc6399f5783be62a19da93a`.

**The mirror is untrusted, and nothing about the trust model changes.** `js/greenfield.js` and `loadModel()` in
`frontend/src/core/controller.js` both recompute the keccak weights root over 4 KiB tiles and compare it with the MEP's
`model_id`; a wrong or stale mirror is rejected exactly as a wrong or stale SP is. The mirror is a CDN, not an
authority.

What it buys, concretely:

- **Removes the read-quota failure mode** that `docs/DESIGN.md` §6 names as a risk: 1,000 bootstraps is ~28 GB of
  Greenfield egress that the publisher pre-pays per release. On R2 with Cloudflare caching, egress is free.
- **Faster first load.** 28 MB from an edge cache beats 28 MB from one SP.
- **Gets under the Pages file cap**, which the payload exceeds outright (§2).

One argument for the mirror turned out not to hold: CORS. The worry was that under `require-corp` the page could
not fetch the payload from a host that does not do CORS. Checked against the live SP,
`gnfd-testnet-sp2.bnbchain.org` returns `access-control-allow-origin: *` and `access-control-expose-headers: *`
on the object, and a CORS-successful fetch satisfies `require-corp`. **The direct `gnfd://` path works from a
browser**, so the mirror is a CDN decision — quota, latency, and not depending on one SP — not a correctness one,
and the fallback path is genuinely usable rather than theoretical.

Greenfield stays: `MEP.weightsDA` is immutable on-chain and points at `gnfd://`, it is the record of where the
brain officially lives, and it is the fallback when the mirror is down. Keep the bucket funded.

---

## 4. The relayer as a long-running service

### What it actually is

One Node process holding four roles (relay hub, epoch aggregator, beacon participant, gas sponsor), **all of its
aggregation state in memory**, polling every 2 s, signing with a hot key. That shape rules out Workers/Pages
Functions without a rewrite, and it makes the operational questions below the real content of this section.

### Host: Render

A Render **Web Service**, Node runtime, pinned to Node 22+ (`NODE_VERSION=22` — `relayer/env.mjs` uses
`process.loadEnvFile`). It fits well: always-on process, restart-on-crash, zero-downtime deploys, a health check,
outbound static IPs on paid plans (useful if the RPC provider allowlists), and secret files that map cleanly onto
the `.env.<network>` the repo already produces. Three constraints shape the setup.

**(1) Paid instance, not free.** Free web services spin down when idle. A sleeping relayer misses its beacon
commit and reveal, and with one committer that means `beaconFor(e) == 0` and **the epoch never rolls** — the
whole mesh stalls, not just sponsorship. Starter ($7/mo at time of writing) or above. This is not a
cost-optimization question; it is a correctness one.

**(2) One port, two servers — solved with `PORW_RELAY_PATH`.** Render routes a single `$PORT` per service, while
`relayer.mjs` opened one listener for the relay hub and another for the API. `startRelay` now takes an optional
`{ server, path }` and attaches to an existing http server instead of binding a port of its own, so setting
`PORW_RELAY_PATH=/relay` serves the hub and the API on the same port. Unset, the hub takes its own port exactly
as before. Bind to `0.0.0.0` on Render (`PORW_HOST=0.0.0.0`).

**(3) `/deployment` advertised the bind address — solved with `PORW_PUBLIC_RELAY_URL`.** `startRelay` returns
``url: `ws://${host}:${port}` ``, the address it bound, and the API handed that straight to browsers as
`relay: relay.url`. Every tab then tried to open `ws://127.0.0.1:8787`, which an `https://ai.gg` page would
refuse for its scheme even if the host were right. It broke on any hosted deployment and was invisible locally,
because locally it happened to be correct. `/deployment` now returns `PORW_PUBLIC_RELAY_URL` when set, while the
relayer's own aggregator client keeps dialling the local address. `test/e2e_hosting.mjs` covers both.

Config on Render: a **Secret File** holding the env file, and `PORW_ENV_FILE` pointing at its mount path, so the
existing `--env` / `loadEnv` path is reused unchanged and the key never appears in the dashboard's plain
environment variables. Health check path `/status` — it already exists and is cheap.

Cloudflare in front: `api.ai.gg` CNAME'd to the Render hostname, proxied. Render terminates TLS on its own, so
this is for the WAF/rate-limit rules (§6c, §6f) and a stable name independent of the host.

*(If Render's single-port constraint proves annoying, the alternative is a 1 vCPU VM with systemd
`Restart=always` plus `cloudflared` mapping `api.ai.gg` → `:8788` and `relay.ai.gg` → `:8787`, which keeps both
ports and needs no code change other than (3). Render is the better default given the account already exists.)*

### Restart semantics — know what a restart costs

The aggregator's claims for the in-flight epoch live only in `M.aggregators`. A restart drops them:

- restart **before** that epoch's root is posted → no root for that epoch → **no instance can materialize it**;
  they fall back to `submitClaim` (≈240k gas each, paid by the instance) or lose the epoch
- restart **after** the root is posted → costs nothing but the current epoch's collection

So: deploy right after a `postEpochRoot`, and treat "epochs with no root" as the health metric that matters.
Persisting the aggregator to a Render disk would remove this, and is the obvious first hardening if uptime
disappoints. Note that Render redeploys on every push to the tracked branch — turn off auto-deploy, or accept
that a README typo can cost an epoch.

### WebSocket keepalive — was the blocker; fixed in `aigg-porw`

Both Cloudflare and Render close idle WebSocket connections (Cloudflare's limit is on the order of 100 s). Tabs
hold the relay connection open across 10-minute epochs with almost no traffic in between, so the connection is
idle nearly all the time. What the code used to say:

- `relay.js` `startRelay()` — no `ping`, no `pong`, no heartbeat interval anywhere. The server never probed a
  connection and never kept one warm.
- `relay_client.js` — `ws.onclose = () => { entry.open = false; }`. That was the entire close handling. **No
  reconnect.** Once a socket dropped, the entry stayed closed for the life of the client and the next `publish`
  threw `no relay connected`.

The consequence appeared in production and never locally: a browser tab lost its relay connection roughly 100 s
after its last message and silently never recovered — claims stopped being announced, tasks stopped being
answered, and the page showed no error until something threw. **The relayer's own `RelayClient` is the same
class**, so the aggregator stopped receiving claims too while `tick()` kept posting empty roots.

Both halves are now implemented upstream: the hub pings on an interval and reaps peers that stop answering (also
`ws.on("error")`, whose absence meant a client resetting its connection could take the relayer's process down),
and `RelayClient` redials with jittered backoff and replays its subscriptions on the new socket.
`test_relay_keepalive.mjs` covers a cut connection recovering, a silent peer being reaped without disturbing the
live ones, and `close()` actually stopping the loop.

### Run two, not one

The aggregator design already tolerates several relayers (`epochRoots` is keyed by aggregator address; an
instance materializes against whichever root includes it). Two relayers on **separate hosts, ideally separate
operators** buys two distinct things:

1. liveness — a dead relayer no longer means a dead epoch
2. **beacon safety — see §6(e), which is the reason this is not optional on mainnet**

Cost: the per-epoch beacon gas doubles (§5), plus a second $7/mo instance. Put the second one somewhere other
than Render, so a Render-wide incident does not take both — the point of two is independence, and two services
in one region of one provider are not independent.

---

## 5. What it costs to stand still

Measured, from the live BSC testnet run, per epoch, per MEP:

| tx | gas |
|---|---|
| `beacon.commit` | 115,235 |
| `beacon.reveal` | 100,396 |
| `rollEpoch` | 52,276 |
| `postEpochRoot` (1 claim) | 97,803 |
| **total per epoch** | **365,710** |

At 800-block epochs (~10 min on BSC) that is 144 epochs/day ≈ **52.7M gas/day, with zero users**. In BNB:

| gas price | per day | per year |
|---|---|---|
| 1 gwei — the *assumption* in `DESIGN.md` §5 | 0.053 BNB | 19.2 BNB |
| **0.1 gwei — measured on BSC testnet, 2026-09-17** | 0.0053 BNB | 1.9 BNB |

The gas price is no longer an assumption: every transaction in the second live run settled at **0.1 gwei**, ten
times below the figure `DESIGN.md` §5 is built on. That table is conservative by an order of magnitude and should
be restated. Re-check on mainnet before quoting anything — testnet and mainnet floors need not agree — but the
direction of the error is now known.

**267,911 of the 365,710 gas — 73% — is the beacon** (commit + reveal + roll). The idle cost of this system is
almost entirely the cost of producing randomness nobody is using yet.

Why it is so expensive is worth understanding, because it points at the fix. `commit` alone is ~115k: 21,000
transaction base fee, then four storage slots written for the first time — `commits[e][sender].hash`, `.deposit`,
the `committers[e]` array length and its first element — at 22,100 gas each. `reveal` and `rollEpoch` are the
same story (`revealed`, `revealedCount[e]`, `acc[e]`, `beacon[e]`), plus two more 21,000 base fees. **The epoch
number is part of every storage key**, so each epoch writes a fresh set of never-before-used slots and pays the
full zero-to-nonzero price; nothing is ever an overwrite. That repeats 144 times a day whether or not one
instance is online.

The deeper mismatch: the beacon is produced on the *epoch clock*, while the things that consume it — task
sortition, audit selection, the claims of that epoch — arrive on *demand*. Three levers follow, in order of
effort:

- **Lazy beacon — implemented** (`PORW_BEACON_LAZY=1`, off by default). The relayer commits for the next epoch
  only when there is demand: a verified claim collected in this epoch or the previous one, or a bonded instance
  that announced itself via `POST /wake` (the node page sends one per epoch). A cold epoch never rolls and costs
  nothing; an idle mesh costs nothing at all. Cost of the trade: a node arriving into a cold mesh waits one epoch
  for a beacon and a second to become eligible. `/status.beacon` reports warm/cold and the reason.
  `test/e2e_lazy_beacon.mjs` covers the whole cycle on anvil, including going back to sleep. Note this cannot be
  abused: the beacon fires at most once per epoch however many wakes arrive, so the worst case is the eager cost.
  It also does not flap — while anybody is claiming or waking, both halves of the rule hold every epoch and the
  beacon runs continuously; it goes cold once, on a tail of `PORW_BEACON_WAKE_EPOCHS` epochs (default 2) after
  the last sign of life. And the bootstrap path does not depend on the beacon: bonding and `delegateBySig` are
  beacon-independent, so a new node can always bond, delegate, and then wake a sleeping mesh.
- **Epoch length — now a latency knob, not a cost knob.** Before the lazy beacon, lengthening the epoch was the
  cheapest lever available. It no longer is. With the idle mesh already at zero, a longer epoch only reduces the
  cost of epochs somebody is actually using — and it charges for that where it hurts, because the lazy beacon's
  cold start is *two epochs*. At the deployed 800 blocks (~10 min) that is a 20-minute wait before the first
  node is eligible; at 60-minute epochs it would be two hours, which is not a mesh anyone would join. So keep
  800 — or shorten it. The only cost of shortening is more beacon gas while the mesh is busy, which is exactly
  when there are task fees to cover it, and a shorter epoch also makes the residency proof finer-grained.
  **Still a decision to make before deploying — `EPOCH_BLOCKS` is a constructor argument and cannot be changed
  afterwards.**
- **A VRF adapter** (`DESIGN.md` §3) replaces commit + reveal + roll with one request. Evaluate it as the fix for
  §6(e) — single-operator control of the randomness — that happens to help the bill, not the other way round.

Separately: **`materializeClaim` measures 284,571 gas against the 232k in `DESIGN.md` §5** — 23% over, and
reproduced at 284,523 on anvil. The §5 BSC table ("500 active ones ≈ $70 per epoch") is correspondingly
optimistic and should be restated from measurements before it goes in front of anyone.

Confirm the current BSC gas price and BNB price at launch; the 1 gwei in `DESIGN.md` predates BSC's gas
reduction and is likely stale in the conservative direction.

---

## 6. Must fix before mainnet

Ordered by what an adversary would reach for first. (a)–(d) are done — the sponsorship guard and the nonce
handling; (e)–(j) remain, and (i) is what gates a first deployment.

**(a), (b), (c) — the sponsorship guard. Fixed together; `test/e2e_sponsor_guard.mjs` covers it.** These were
three faces of one hole: the relayer spent its own BNB on strangers' calls with almost nothing bounding it.

- **(a) `/tx/settle` had no authorization whatsoever.** `/tx/delegate` checked `isBonded`, `/tx/result` checked
  `resolve`, `/tx/materialize` required an inclusion proof; `/tx/settle` took any `taskId` from any caller on the
  open internet and broadcast a transaction. Nonexistent or already-settled tasks revert — **and a reverted
  transaction still costs gas** — so a loop against it drained the hot wallet.
- **(b) The documented simulation guard did not exist.** The README claimed the relayer "sponsors gas only for
  calls that … succeed in simulation" and `DESIGN.md` §5b repeated it, but `tx()` called
  `ch.<contract>.write.<fn>(...)` — viem's `writeContract`, which signs and broadcasts. `simulateContract`
  appeared nowhere in the file.
- **(c) No budget, per caller or global.** Even with (b) fixed, a *successful* call is still a sponsored call:
  bond 0.05 BNB once, then loop `/tx/delegate` (54,911 gas measured on anvil) with fresh session keys — every one
  simulates fine.

Every `/tx/*` call now passes three gates before anything is signed: it names a **bonded instance** to charge
(`/tx/result` derives it from the session key the signature resolves to; `/tx/settle` takes one in the body —
settling is permissionless on-chain, so an unbonded client can always settle their own task by paying for it), it
must **simulate successfully** from the relayer's account, and it must **fit a budget** —
`PORW_SPONSOR_EPOCH_GAS` per instance per epoch (default 1,500,000) and `PORW_SPONSOR_DAY_GAS` across everyone
per rolling day (default 50,000,000). Both are finite by default, so an operator raises them knowingly instead of
inheriting an unbounded wallet; `/status.sponsor` reports the limits, the day's spend, and the last refusals with
reasons. Gas is charged from the receipt, including a revert that still got mined.

Still worth adding on top, at the edge rather than in the process: ordinary per-IP rate limiting via a Cloudflare
rule on `api.ai.gg`. The budgets bound the loss; a rate limit keeps the noise off the RPC bill.

**(d) Nonce races between the tick loop and the API — fixed upstream in `3c5b681`.** `tick()` could fire
commit/reveal/roll/postRoot while an HTTP handler concurrently sent `/tx/materialize` from the same account with
no lock and no nonce manager; the live testnet run's `nonce lower than current` was the incidental version of a
structural problem. Sends are now serialized through one queue with a locally tracked pending nonce, resyncing
from the chain and retrying once on a nonce error, and `e2e_anvil.mjs` exercises both concurrent sponsored sends
and a deliberate external desync. Still worth doing on mainnet: a paid/private RPC endpoint rather than a public
pool.

**(e) One beacon participant means the beacon is not random.** With only the relayer committing,
`beaconFor(e) = keccak(its own secret ‖ e)` — it knows the value before revealing, and can withhold the reveal
to force a reroll for the price of the 0.1 BNB deposit. Sortition (who executes a task, who gets paid) and audit
selection both derive from that value. On testnet with one bonded instance this is harmless; on mainnet with
real fees it is the most valuable thing to attack in the system, and the operator is the one holding it. The
contract's own comment is honest about the RANDAO trade-off — but the trade-off only bites the *last* revealer,
and with n=1 the last revealer is also the only one. **Minimum bar for mainnet: ≥2 independent committers.** The
VRF adapter `DESIGN.md` §3 already contemplates is the real answer and would also delete 73% of the standing
cost in §5.

**(f) `Access-Control-Allow-Origin: *` on sponsored POSTs.** Fine for the read endpoints, careless on `/tx/*`.
Restrict POST to `https://ai.gg`. This is hygiene, not a fix — CORS is not authorization, and (b)/(c) are what
actually bound the loss.

**(g) Don't put the deployer key on the relayer host.** `deploy.sh` writes `PORW_DEPLOYER_KEY` into
`.env.<network>`, and that file is what gets copied to the relayer. The deployer owns the registries. For
mainnet: deploy from a hardware signer, and ship the relayer host an env file containing addresses plus
`PORW_RELAYER_KEY` only. (`register_mep.mjs` falls back to `PORW_RELAYER_KEY`, so publishing still works.) Fund
the relayer key from cold storage, keep a working balance of 1–2 BNB, and alert on the floor rather than
topping it up automatically without a ceiling.

**(h) MEP registration on mainnet is irreversible.** `registerMEP` writes an immutable record; a payload whose
`model_id` does not match makes that MEP id permanently dead. Verify the bytes through **both** the SP and the
R2 mirror — `register_mep.mjs` already does the SP check when given an endpoint — before the mainnet call.

**(i) Hosting blockers — fixed; see §4 for each.** Keepalive and reconnect in `aigg-porw` (the one that mattered:
every tab, and the relayer's own aggregator feed, died ~100 s after going idle behind any proxy),
`PORW_PUBLIC_RELAY_URL` for what `/deployment` announces, and `PORW_RELAY_PATH` to put the hub and the API on one
port. Covered by `test_relay_keepalive.mjs` upstream and `test/e2e_hosting.mjs` here.

**(j) The `.gitignore` gap is closed but the habit matters.** `env.*.txt` now ignored alongside `.env*`. On
mainnet the env file holds a key with real BNB behind it; keep it out of the repo, out of the Pages build, and
out of any CI log.

---

## 7. Staged rollout

**Phase 0 — done.** The gas-drain items (a)–(c), the nonce handling (d) and the hosting blockers (i) are all
fixed and covered by `npm test` (greenfield + `e2e_anvil` + `e2e_lazy_beacon` + `e2e_sponsor_guard` +
`e2e_hosting`) plus `test_relay_keepalive.mjs` upstream. Mainnet runs with `PORW_BEACON_LAZY=1` from day one, and
`EPOCH_BLOCKS` stays at 800 or goes lower — §5 for why lengthening it is now the wrong move. The remaining
pre-deployment step is `test/live_bsc.mjs` against the existing BSC testnet deployment, which is also the first
real exercise of the keepalive over a long-lived connection.

**Phase 1 — `fly.ai.gg` serves testnet.** Pages project `aigg-fly`, deployed by `.github/workflows/pages.yml`
(§2), R2 mirror of the testnet payload, relayer on Render behind `api.ai.gg`, still pointed at chain 97. Everything
that can break in production breaks here, where it costs testnet BNB — and the two §6(i) blockers surface
immediately rather than on mainnet.

**Phase 2 — second relayer.** Separate host and provider, ideally separate operator. Beacon now has two
committers (§6e); liveness no longer hinges on one service. Monitoring: epochs with no root, relayer balance,
sponsored gas per day, WebSocket connection count.

**Phase 3 — mainnet.** Deploy contracts from the cold signer, publish to Greenfield mainnet, mirror to R2,
verify through both, register the MEP, then flip `ai.gg`'s default relayer to the chain-56 one and keep the
testnet relayer reachable behind a toggle.

---

## 8. Unverified — do not treat as settled

- **The submodule does not track `aigg-porw`'s `main`.** `4bd702a` is the tip of
  `claude/subspace-consensus-dram-bandwidth-y7pgo6`; `main` has moved to a different, Rust-centred tree with no
  `web/porw-browser` at all. So the browser node, the relay transport and everything this deployment depends on
  live on a branch whose name reads as auto-generated, and nothing on `main` would build it. That is fragile for
  a mainnet dependency — worth deciding, before launch, which branch is the supported line and giving it a name
  that says so.
- ~~`aigg-porw` could not be read~~ — resolved; the repo is public and the submodule is checked out at
  `4bd702a`. The three questions it was blocking are answered in §4: no keepalive and no reconnect (confirmed
  missing), `startRelay` binds its own port and cannot take an existing server (confirmed), and the aggregator
  is pure JS — `verify.js` states it "never uses the wasm kernel" — so the relayer needs no wasm at runtime.
  The `node_modules` question is answered too: the only bare specifiers across `web/porw-browser` are
  `@noble/hashes/*` and `@noble/secp256k1`, so vendoring them is a straight copy — which is what
  `frontend/build/runtime.mjs` now does, rewriting the specifier to `/vendor/@noble/…` as it copies (§2). (`relay.js` imports `ws` and is Node-only; it will be copied into `dist/` and simply never imported by
  the page.)
- ~~Greenfield SP CORS behaviour~~ — checked against the live SP and fine; see §3. `js/fetch_brain.mjs` fetches
  and verifies the published brain against the MEP's `model_id` (28,123,136 bytes, matches, ~5 s), which is also
  the check to re-run against the mainnet copy before anyone is told to load it.
- **Current BSC gas price and BNB price** (§5).
- **Cloudflare's per-file and WebSocket idle limits, and Render's single-port, sleep and pricing behaviour**, as
  cited here are from general knowledge rather than from the vendors' current docs. Re-read both before the
  build script and the service config depend on them.
