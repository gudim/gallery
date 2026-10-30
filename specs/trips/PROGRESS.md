# Trips: progress

## Stage 2.0: fork and skeleton (branch `trips-0`, from `v5.9.0`)

- [x] An empty trips module is registered through one hook line. One spread per upstream registry (three), see DECISIONS-LOG 2026-10-30.
- [x] A no-op trip migration applies, reverts, and is dropped by `revert-to-immich.sql`; the revert spec passes. 2026-10-31: the whole script run with psql on a database migrated by `gallery-migrations.js run`, then stock Immich v3.3.5 booted on it: migrations up to date, no schema drift.
- [ ] Gallery's server, web and medium test suites are green. 2026-10-31: server unit green; web green (6682/6682; `global-search-manager` "clears stale status…" is a fake-timer flake, it failed in one of two full runs and passes alone). Medium: no regression against clean `v5.9.0`, run back to back on this machine: 38 failures on `v5.9.0`, 39 on `trips-0`, and the three tests that differ (two perf budgets, the rbac-oracle legacy-search case) pass alone on both. The 38 shared failures are environmental: 27 in `workflow-core-plugin` (plugin wasm needs `extism-js` and binaryen, pinned in `mise.toml`, not installed here), 6 in `exif/*`, 3 in `library.service`, 1 each in `face-person-verdict` and `face-repair`. Unticked until the owner says whether "no regression against the base tag" counts as green.
- [x] A rebase onto the current Gallery release tag passes `tools/upstream-preflight`. `v5.9.0` is still the newest tag, so READY on `trips-0` itself.
- [x] CI publishes the image to GHCR. Run 41134864539 pushed `ghcr.io/gudim/gallery-server:v5.9.0` (`:v5`, `:release`), amd64 + arm64.
