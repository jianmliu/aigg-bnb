# Make frontend version skew impossible (root fix)

## The defect, measured 2026-09-20 on the live domain

| path | `*.pages.dev` | **fly.ai.gg** |
|---|---|---|
| `/node_worker.js` | 300 s | **14400 s** |
| `/porw/*` | 300 s | **14400 s** |
| `/assets/*` | 31536000, immutable | 31536000 |
| `/` | 0 | 0 |

The zone's Browser Cache TTL raises any origin `max-age` shorter than 4 h, so exactly the two fixed
paths whose freshness matters lose the `_headers` rule that `public/_headers` was written to give
them. `/assets/*` survives because it is longer, and because it is content-hashed it would not care.

Observed consequence, in a real tab on fly.ai.gg right after a deploy: the new bundle called
`deltaInfo` on a four-hour-old cached worker that has no such op, and the page hung for 58 s with an
empty `errors` list and a frozen log. The `_headers` comment predicted this in the `/porw/` form -- a
model_id that no longer matches the registry, "a silently rejected claim, not an error anyone would
see."

Five minutes of skew is not the fix. Content-addressed URLs are: a build cannot reference a stale
file if the file's URL contains its content.

## Plan

- [x] establish that `/porw/*` modules import each other RELATIVELY (they do: `./verify.js` etc.),
      so renaming the directory needs no edit inside them
- [x] `runtime.mjs`: `runtimeId(repoRoot)` = sha256 over every servable runtime file's path+bytes
- [x] `runtime.mjs`: `rewriteBareImports(src, vendorPrefix)`, `copyRuntime(root, out, id)`
- [x] `vite.config.mjs`: compute the id at `buildStart`; rewrite `/porw/`, `/vendor/` and
      `/node_worker.js` in every emitted chunk; emit `porw.<id>/`, `vendor.<id>/`,
      `node_worker.<wid>.js`; drop the unhashed worker Vite copies from `public/`
- [x] dev server unchanged (`/porw/`, `/node_worker.js`): there is no CDN in front of it
- [x] `_headers`: the hashed paths are immutable, which the zone TTL cannot shorten
- [x] `test/deployed_build.mjs`: no unhashed reference survives, and every import the emitted worker
      makes resolves to a file that exists in `dist`
- [x] a test for the property itself: change one runtime byte -> the id changes -> the URL changes
- [ ] verify by deploying and re-running the fly #1 load on the real domain

## Review

`/porw.<id>/`, `/vendor.<id>/` and `node_worker.<id>.js`, where `<id>` is sha256 over every servable
runtime file's path AND bytes. The modules under /porw/ import each other relatively, so renaming the
directory needed no edit inside any of them; only the eleven absolute specifiers in the page and the
worker had to learn the id, which a `renderChunk` pass does. Dev still serves the unhashed paths --
there is no CDN in front of it.

One thing bit during the work and is worth keeping: rolldown hands every plugin hook its own context
object, so the id could not live on `this` between `buildStart` and `closeBundle`. The guard in
`copyRuntime` ("an unnamed copy is the stale-cache bug this exists to remove") caught it on the first
build rather than silently emitting an unhashed directory, which is exactly what it was written for.

Verified: 19 checks on the id itself, including that a changed `sketch.wasm` renames the runtime (the
one file whose staleness would be silent) and that a non-servable file does not; 14 new checks on the
build output, each shown to fail against a deliberate corruption; all six frontend e2e suites, which
drive a real browser against the built page and so exercise the hashed worker and modules end to end.
