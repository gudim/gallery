# Trips: progress

## Stage 2.3: guest trip viewer (branch `trips-3`, from `trips-all`): open

The viewer is in `web/src/lib/trips/`; the shared-link page opens it for an album with a trip, signed-in users at `/trips/{albumId}`. Likes: `PUT`/`DELETE /trips/{id}/likes/{assetId}`. Checked against the dev Gallery of stage 2.2 running the server built from `trips-3` (its `dist` mounted into the `v5.9.1` image) and `vite dev`, in Chromium with locale `ru-RU`, the way travel-album's reference test measures.

- [x] On migrated `birzhay-2026`, the reference numbers match (`tests/e2e/reference/birzhay-2026.json`), in both themes:
  - 1440 px: 10 stop markers, 9 lines, 3 mode avatars, stats 79 · 3 · 8 · 1 · 487, range "8 августа — 8 августа 2026 · 1 день в дороге", the same ten stops in the list, 1 day.
  - 390 px: 8 stations, 1 day badge, "1 день·8 остановок·79 кадров·487 км", road 2845 px high.
- [ ] The owner has seen 390 and 1440 px screenshots, in both themes, next to travel-album's.

Also checked: the lightbox pages the whole trip and keeps the opened stop when it closes; a like counts once per browser and goes back on unlike; Grid shows 79 assets, Photos 8 sections; `?album` opens Gallery's album view; Places and Plain trips (made on the dev Gallery from birzhay's assets) render on both widths. Web unit suite green (415 files, 6690 tests).

## Stage 2.2: migration from travel-album (branch `trips-2`, from `trips-all`): closed 2026-10-31

The script is `python -m atlas.to_gallery` in travel-album, branch `to-gallery` (`b895076` code, `26bc77f` docs), not pushed. Checked on a dev Gallery: the fork's `ghcr.io/gudim/gallery-server:v5.9.1` with stock `gallery-ml:v5.9.0`, travel-album's server dump of 2026-10-03 and the store of albums 1 and 2. Counts were read back from Gallery's API, not from the script's report.

- [x] `birzhay-2026` and Poland 2026 migrate in full, and the counts match travel-album:
  - `birzhay-2026`: assets 79 → 79, stops 10 → 10, legs 9 → 9, captions 79 → 79, named people 4 → 4 (13 of 13 faces), album thumbnail and shared link `birzhay-2026`.
  - Poland 2026: assets 1116 of 1120 (4 sit in hidden stops), stops 48 of 55 (7 hidden), legs 54 → 47 (the 14 legs through hidden stops glued into 7; Wieliczka → hidden Turówka → Żupny castle became one 2677 m foot leg, 1275 + 1402), captions 1116, 15 dates corrected, 83 overlays, named people 11 of 11 (64 of 65 faces: Gallery did not detect one).
- [x] A second run against the same Gallery refuses the album that already has a trip ("в Gallery уже есть его поездка") and adds nothing.

Also checked: the trip documents of all 25 albums of the dump pass the server's `TripImportDto` (offline, against the `trips-all` build); that check caught travel-album's overlay arrays, now converted to GeoJSON. travel-album's suite without e2e is green (823), plus 10 tests of the script against a fake Gallery. The dev stack's docker network had to move off 172.20/16, which this machine's corporate VPN routes into its tunnel.

## Stage 2.1: trip model (branch `trips-1`, from `trips-0`): closed 2026-10-31

- [x] The owner, an editor, a viewer and the album's shared link can read a trip; anyone else gets 404, as for a missing album. `test/medium/specs/trips/trip.service.spec.ts` "read access": all four read; a stranger, a shared link of another album, and an album without a trip get `NotFoundException`. `GET trips/:id` is on the shared-link route allowlist in `src/controllers/index.spec.ts`.
- [x] Removing an asset from the album, or deleting it, removes it from its stop. Same spec, "cascades": removal from the album and a permanent delete drop the filing and likes (FK onto `album_asset`); a trashed asset is hidden and comes back to its stop when restored.
- [x] Deleting the album deletes the trip. Same spec: no row left in any of the seven trip tables.
- [x] A document import of a fixture trip round-trips through the read API. Same spec, "import": a Route fixture with start, finish, place, filed and unplaced assets, legs, overlay and likes reads back equal; refusals for a second import, an editor, an asset outside the album and a second Favorites trip.

Also checked 2026-10-31: the migration applies, reverts (`gallery-migrations.js revert`) and re-applies on a scratch database, and `revert-to-immich.sql` then leaves no trip table or trip `migration_overrides` row; the schema-drift medium spec passes. Server unit suite green; web `tsc` green with the regenerated SDK. Medium: 38 failures, the baseline's environmental set except that `face-person-verdict` and `face-repair` passed and the two known flakes (rbac-oracle legacy search, favorite-cross-scope perf budget) failed under load; both pass alone. Review of `trips-0..trips-1` (2026-10-31, standards and spec axes): fixed a commit that was red on its own (the shared-link allowlist moved into the API commit), stop times with an offset (refused), the trip of a trashed album over a shared link (404), racing imports (owner lock, 409), weak import validation, and the glossary terms (`start`, `isAddedByHand`). The owner settled three questions (DECISIONS-LOG 2026-10-31): long captions join the description and the LLM-written text is kept in `trip_generated_caption`; a shared link that hides metadata hides asset points; same-trip references are checked in code, not by composite keys. Each has a medium or unit test. Before the push (2026-10-31):
- HTTP, against the built server (API worker only) on a scratch database: 15 checks pass — an offset in a stop time is 400, a stranger's import and read are 404, the owner's import is 201 and a second one 409, local time reads back as wall clock, imported likes count, an anonymous read is 401, the album's shared link reads the trip and one that hides metadata gets no asset points but keeps the stops, another album's link is 404, an import through a shared link is 403, and the trip of a deleted album is 404.
- Dart client regenerated with `open-api/bin/generate-dart-sdk.sh` (openapi-generator 7.25.0, Java 21): `TripsApi` and every trip model are generated. `dart analyze` outside Flutter only shows the errors every model shares (Flutter and `immich_mobile` imports the patches add); a full compile needs the Flutter toolchain, which is not installed here.
- `tools/upstream-preflight ready` on `trips-1`: READY.
- Full medium suite under heavy load from another project on the machine (load average 18–25): 67 failures, 34 of them timeouts. Rerun one file at a time, all pass except the baseline's environmental set and two timing tests (`face-person-verdict` "collects 5 000 orphaned rows", favorite-cross-scope perf budget); clean `v5.9.0`, run right after at the same load, fails the same two.

## Stage 2.0: fork and skeleton (branch `trips-0`, from `v5.9.0`): closed 2026-10-31

- [x] An empty trips module is registered through one hook line. One spread per upstream registry (three), see DECISIONS-LOG 2026-10-30.
- [x] A no-op trip migration applies, reverts, and is dropped by `revert-to-immich.sql`; the revert spec passes. 2026-10-31: the whole script run with psql on a database migrated by `gallery-migrations.js run`, then stock Immich v3.3.5 booted on it: migrations up to date, no schema drift.
- [x] Gallery's server, web and medium test suites are green. 2026-10-31: server unit green; web green (6682/6682; `global-search-manager` "clears stale status…" is a fake-timer flake, it failed in one of two full runs and passes alone). Medium: no regression against clean `v5.9.0`, run back to back on this machine: 38 failures on `v5.9.0`, 39 on `trips-0`, and the three tests that differ (two perf budgets, the rbac-oracle legacy-search case) pass alone on both. The 38 shared failures are environmental: 27 in `workflow-core-plugin` (plugin wasm needs `extism-js` and binaryen, pinned in `mise.toml`, not installed here), 6 in `exif/*`, 3 in `library.service`, 1 each in `face-person-verdict` and `face-repair`. The owner accepted "no regression against the base tag" as green (2026-10-31).
- [x] A rebase onto the current Gallery release tag passes `tools/upstream-preflight`. `v5.9.0` is still the newest tag, so READY on `trips-0` itself.
- [x] CI publishes the image to GHCR. Run 41134864539 pushed `ghcr.io/gudim/gallery-server:v5.9.0` (`:v5`, `:release`), amd64 + arm64.

Also in 2.0, not a "Done when" item: OIDC sign-in against `deployment/trips/dev-oidc/` checked
2026-10-31 end to end with the published `ghcr.io/gudim/gallery-server:v5.9.0` image joined to
the `gallery-dev-oidc` network (not the source-built dev stack): S256 PKCE, Authelia first
factor, one consent on the first sign-in, then `/oauth/callback` auto-registers
`owner@gallery.localhost` with its `oauthId`.
