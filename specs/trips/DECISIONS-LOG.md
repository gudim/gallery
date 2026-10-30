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
