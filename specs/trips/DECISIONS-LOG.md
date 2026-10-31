# Trips: decisions log

One line per choice the plan does not dictate. Newest last. `(owner)` marks a choice the owner made.

- 2026-10-30 (owner) Stage branches grow from a Gallery release tag; `trips-0` starts at `v5.9.0`, not at Gallery `main` (D1).
- 2026-10-30 (owner) Trip migrations live in `server/src/schema/migrations-trips/`, recorded in their own ledger `trips_migrations`. One hook in `gallery-migration-ledger.ts` runs them in the shared name order after Gallery's; `revert` undoes the newest trip migration first. Reason: the shared `migrations-gallery/ORDER` and its ledger would conflict on every rebase, and stock Gallery refuses to boot on a database whose `gallery_migrations` holds rows it has no file for.
- 2026-10-30 (owner) Trip UI strings are `trips_`-prefixed keys in `i18n/gallery/{locale}.json`, in en and Gallery's nine maintained locales, so Gallery's fork-string parity spec keeps holding. This revises D3, which had en and ru only.
- 2026-10-30 (owner) Gallery's `docs/fork/ownership.yml` is not edited. The trip layer has its own manifest `docs/fork/trips-ownership.yml` for `tools/upstream-preflight`, with Gallery as its upstream.
- 2026-10-30 Trip namespaces: `server/src/trips/`, `server/src/schema/migrations-trips/`, `web/src/lib/trips/`, `deployment/trips/`, `.github/workflows/trips-*.yml`, `docs/fork/trips-ownership.yml`, `specs/trips/`.
- 2026-10-30 The trips registry `server/src/trips/index.ts` is spread once into each of upstream's three arrays (controllers, repositories, services), after Gallery's, as `src/gallery/index.ts` is. A separate Nest module would be a single line, but trip services extend `BaseService`, whose repositories live in the root module's providers.
- 2026-10-30 Trip migrations are named from `1900000000000` up, above every Gallery and upstream name, so the shared name order runs them last; `src/trips/revert-to-immich.trips.spec.ts` enforces it.
- 2026-10-30 `scripts/revert-to-immich.sql` gets one trips block, step `8t`, right after Gallery drops its ledger: a block before Gallery's section 2 would move the "first DROP TABLE" that Gallery's revert spec measures from. Its own guard checks the trip tables; Gallery's step-9 list is not touched.
- 2026-10-30 Dev OIDC: Authelia + Caddy in `deployment/trips/dev-oidc/` as their own compose project, issuer `https://auth.gallery.localhost:9444` (travel-album keeps 9443), joined to Gallery's dev stack by an override file.
- 2026-10-30 CI: `.github/workflows/trips-release-server.yml` builds only the server image to `ghcr.io/<owner>/gallery-server`; Gallery's release workflows stay as they are and are not run in this fork.
- 2026-10-31 (owner) The fork's default branch on GitHub is `trips-0`, so `workflow_dispatch` sees `trips-release-server.yml`; Gallery's `main` is left as it is. Every workflow inherited from Gallery is disabled in the Actions tab; only `Release Trips Server` is active.
- 2026-10-31 `ghcr.io/gudim/gallery-server` is public (anonymous pull works), so the home server pulls without a registry login.
- 2026-10-31 (owner) "Test suites are green" means no failure that clean Gallery at the base tag does not also have, run back to back on the same machine; a test that differs must pass when run alone on both.
- 2026-10-31 (owner) Accepted: the trips registry is one spread in each of upstream's three registries, not a single hook line.
- 2026-10-31 `trips-1` grows from `trips-0` as it is (PLAN §2: `trips-N` grows from `trips-(N−1)` until that is merged); `v5.9.0` is still the newest Gallery tag, so there is nothing to rebase onto.
- 2026-10-31 (owner) A stop's time window is local wall-clock time, stored the way Immich stores `asset.localDateTime` (wall clock as if UTC), so filing and plain day sections compare like with like.
- 2026-10-31 (owner) An asset in the Immich trash keeps its stop but is left out of every trip read; restored, it is back in its stop. Removing it from the album or deleting it for good drops its filing through a cascade on `album_asset`.
- 2026-10-31 (owner) Likes are one row per like (trip, asset, and a user or a browser key), unique per liker, as in travel-album. An imported count N becomes N rows with synthetic browser keys.
- 2026-10-31 (owner) The trip model carries the start and finish stops (П20), the stop `transit` flag, and overlays (trail lines, country mask; П2, П3). Hidden stops (П5) are not carried.
- 2026-10-31 (owner) The Favorites trip is a Places trip with an `isFavorites` flag, one per album owner, checked by the service. Mirroring stars into its album comes in §2.5, next to auto-filing.
- 2026-10-31 Trip tables are declared with `@immich/sql-tools` decorators like Gallery's, so the server's startup schema-drift check covers them. Hooks: `...tripTables` and `TripsDB` in `src/schema/index.ts` beside Gallery's, and the trip tables join Gallery's in the FK registry spec.
- 2026-10-31 Trip services do not extend `BaseService`: they take `AccessRepository` and their own repositories in the constructor, so no upstream or Gallery constructor grows. Album access goes through `checkAccess` (`src/utils/access.ts`), which includes Gallery's grants; a trip the caller cannot read answers 404.
- 2026-10-31 A trip's id is its album's id. The import document names stops by document-local keys; the read API returns server ids.
