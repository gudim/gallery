# Trips on Gallery: plan

This fork (`github.com/gudim/gallery`, a fork of Noodle Gallery, which is itself a fork of Immich)
adds the features of the owner's earlier app, travel-album, that Gallery lacks: trips with a route
of stops and legs, stories, LLM-generated texts, a guest trip viewer, showcases, a globe and an
offline export. Gallery replaces travel-album. travel-album stays live until its owner switches it
off.

Read first: [GLOSSARY.md](GLOSSARY.md), [adr/](adr/), [AGENTS.md](AGENTS.md) (how to work), then
this plan. Code cites this plan as `trips PLAN D7` or `trips PLAN §2.3`.

## 1. Decisions

All of these were settled with the owner on 2026-10-30. Do not reopen them without the owner.

| # | Decision |
|---|----------|
| D1 | Own fork on GitHub, rebased onto every Gallery **release tag**, not Gallery `main`. No PRs to Gallery are planned. |
| D2 | The trip layer follows Gallery's layering rules (AGENTS.md, "Gallery sits on top of Immich"), applied one level up: trip tables are keyed to Immich ids, Gallery and Immich files get only one-line hooks, and every trip object is also dropped by `scripts/revert-to-immich.sql`. |
| D3 | Docs, specs, commits and code comments are in English. UI strings are `trips_` keys in Gallery's overlay `i18n/gallery/`, in en and Gallery's nine maintained locales (revised 2026-10-30, see `DECISIONS-LOG.md`). |
| D4 | CI builds the server image (server + web) and pushes it to this fork's GHCR. ThinkCentre (the home server) only pulls it. The ML image is stock Gallery's. |
| D5 | Sign-in is stock Immich OIDC against the Authelia already running on ThinkCentre. Several family users, each with their own library. |
| D6 | A trip is an overlay on an Immich album ([ADR 0001](adr/0001-trip-is-an-album-overlay.md)). The trip kinds are route, places and plain. |
| D7 | The album owner and the album's editors edit the trip. Viewers and guest links read it. |
| D8 | A caption is the Immich asset description ([ADR 0002](adr/0002-caption-is-the-immich-description.md)). |
| D9 | A clock offset is applied to the asset date through the stock bulk update (`PUT /assets` with `dateTimeRelative`, or `dateTimeOriginal`). Only the assets' owner can apply it. |
| D10 | Inferred and manual points live in the trip only. Asset coordinates are never written. |
| D11 | Hiding an asset removes it from the album. |
| D12 | Assets added to the album, by anyone and from any client, are filed into stops automatically; the rest go to Unplaced. The owner's stops and texts are never rewritten. |
| D13 | Stop and place names come from Nominatim (rate limit, cache, second language), as in travel-album. The library's GeoNames city is untouched. |
| D14 | Guest access is the album's shared link. A showcase lists the trips marked for it that have a live shared link without a password; the home page is an admin's pick from showcased trips. |
| D15 | The Favorites trip is a Places trip that mirrors the user's stars (Gallery's per-user favorites). |
| D16 | Each user keeps their own LLM settings: URL, model and key of an OpenAI-compatible server (revised 2026-11-01: no Anthropic API type, see `DECISIONS-LOG.md`). |
| D17 | Search: the trip viewer searches stories, captions and CLIP inside the trip, for guests too; a Cmd+K provider finds stops by story text. |
| D18 | The UI is rewritten in Svelte inside Gallery's web app (MapLibre, Gallery's asset viewer). Gallery's mobile app gets the trip screen and the editor last, in §2.9 (revised 2026-11-01, see `DECISIONS-LOG.md`); until then it sees a trip as an album with captions. |
| D19 | Migration from travel-album is a one-off script **in the travel-album repo**, run once in production and then forgotten. Old travel-album links are not kept. Details in §2.2. |

## 2. Stages

Strictly in order. A stage is closed when every "Done when" item is checked and recorded in
`specs/trips/PROGRESS.md`. Stage N is branch `trips-N`, grown from `trips-all`; when stage N closes it is merged into
`trips-all` (fast-forward), and stage N+1 grows from there.

### 2.0 Fork and skeleton

- **Working copy:** `/home/egudim/GIT_PERS/gallery` (ext4). The older clone on the exFAT card
  (`/mnt/1tb_sdcard/Development/GIT_REPOS/gallery`) is not used: exFAT has no symlinks, so
  `CLAUDE.md` is a plain file there and pnpm's `node_modules` cannot work.
- Remotes: `origin` is this fork. Add `gallery` → `https://github.com/open-noodle/gallery.git`,
  and the `upstream` remote (Immich) that `docs/fork/ownership.yml` expects.
- Dev stack per Gallery's `CONTRIBUTING.md` (`docker/.env`, `pnpm install`, `mise dev`), plus an
  OIDC client against a local Authelia, as in travel-album's `compose.dev.yaml`.
- Trip namespaces: `server/src/trips/`, `web/src/lib/trips/`. Decide and record in
  `specs/trips/DECISIONS-LOG.md`:
  - where trip migrations live: `server/src/schema/migrations-gallery/` with its `ORDER` file
    (the shared file conflicts on every rebase), or a third folder and ledger (one more hook in
    `gallery-migration-ledger.ts`);
  - where trip i18n keys live: `i18n/gallery/{en,ru}.json` under a `trips_` prefix, or an
    own overlay merged by `i18n/gallery/merge.mjs` (one hook);
  - how `docs/fork/ownership.yml` and `tools/upstream-preflight` should treat the trip
    namespaces.
- CI: make the server release workflow publish to this fork's GHCR
  (`ghcr.io/gudim/gallery-server`). Check that `apply-branding` still runs.
- A rebase routine onto a Gallery release tag, written into `specs/trips/AGENTS.md`.

Done when:
- An empty trips module is registered through one hook line.
- A no-op trip migration applies, reverts, and is dropped by `revert-to-immich.sql`; the revert
  spec passes.
- Gallery's server, web and medium test suites are green.
- A rebase onto the current Gallery release tag passes `tools/upstream-preflight`.
- CI publishes the image to GHCR.

### 2.1 Trip model

- Tables: the trip (album id, kind, content version), stops (point, time window, title, story,
  order, "no exact place" flag for places), asset-to-stop filing (with an inferred or manual
  point and its source), legs (mode, line, status, transit stations), place articles, showcase
  marks, guest like counters.
- API:
  - read the whole trip state;
  - **trip document import**: create a trip from one JSON document (stops, legs, texts, filing),
    owner only, refused if the album already has a trip. It is used by the migration script (§2.2)
    and by test fixtures.
- Permissions per D7, checked through Immich's album access. Shared-link access reads the trip
  of the link's album only.
- Port from travel-album: the model in `atlas/models.py` and `PLAN §5.10–5.13` of its
  `docs/PLAN.md`.

Done when:
- The owner, an editor, a viewer and the album's shared link can read a trip; anyone else gets
  404, as for a missing album.
- Removing an asset from the album, or deleting it, removes it from its stop.
- Deleting the album deletes the trip.
- A document import of a fixture trip round-trips through the read API.

### 2.2 Migration from travel-album (in the travel-album repo)

A one-off CLI in travel-album (`atlas/to_gallery.py`, run as `python -m atlas.to_gallery`). It
reads travel-album's Postgres and store directly and writes into Gallery over its HTTP API. It
follows travel-album's own `agent.md` and gets a section in its `docs/PLAN.md`.

- **Users**: each travel-album user is matched to a Gallery user by email. Every user must have
  signed in to Gallery once and created an API key; the script takes the keys as input.
  travel-album users with no match are reported and skipped.
- **Originals** are uploaded into the album owner's library through `POST /assets`. If an asset
  with the same checksum already exists (for example from a phone backup), the existing one is
  used.
- **Time**: an uploaded original carries the camera's uncorrected EXIF time. Where
  travel-album's time differs, the script sets `dateTimeOriginal` (D9).
- **Albums**: each travel-album album becomes an Immich album with its assets (hidden ones
  excluded, D11), plus a trip created by document import (§2.1).
- **Texts**: the travel-album caption becomes the asset description, **and travel-album wins**
  over an existing description. Stories and place articles go into the trip document.
- **People**: the script waits for Gallery's face detection on the uploaded assets, matches
  travel-album's named faces to Immich faces by box overlap, and names or merges the people.
- **Favorites**: stars are set through `PUT /assets/favorites`; the Favorites trip is created as
  a Places trip (D15).
- **Likes**: the counts go into the trip document.
- **Access**: travel-album keeps only password hashes, so passwords cannot move.
  - `password` → a shared link with the old slug and a **new** password; the report lists them
    for the owner to send out.
  - `link` → a shared link with the old slug.
  - `public` → a shared link plus a showcase mark.
  - `draft` → no link.
- **Report**: per user, the counts of assets (uploaded and reused), albums, stops, legs,
  captions, named people and links, plus everything skipped, with reasons.
- During development the script runs against a dev Gallery as often as needed. In production it
  runs **once**, when the owner says so; edits made in travel-album after that run are not carried
  over.

Done when:
- On a dev Gallery, `birzhay-2026` and Poland 2026 migrate in full, and the report's counts
  match travel-album: assets, stops, legs, captions, named people.
- A second run against the same Gallery refuses albums that already have a trip, and says so.

### 2.3 Guest trip viewer

Revised by the owner on 2026-10-31: the trip lives in Gallery's own map and design, not in a port of
travel-album's viewer.

- A trip is shown on Gallery's map, extended with the trip's route (legs, stop markers, overlays)
  and a panel of stops; a stop opens its assets in Gallery's timeline and asset viewer, with likes.
  The album keeps Gallery's album view; its map button opens the trip. The same works through the
  album's shared link and for signed-in users with album access. The three trip kinds, `?stop=`,
  phone layout. Gallery's colours, fonts and components (`@immich/ui`); day colours only as the
  colour of route data.
- The road (travel-album's winding phone feed of stops) stays as the one view of its own, in
  Gallery's colours and fonts.
- Behaviour comes from travel-album's `static/viewer/*.js`, `atlas/albums/payload.py` and
  `PLAN §5.4, §5.12, §5.17`; its look does not.
- Reference data: travel-album's `tests/e2e/reference/birzhay-2026.json`. The album's data is in
  travel-album's `.ref/birzhay-2026/` (outside git).

Done when:
- On migrated `birzhay-2026`, the reference data match: 10 stop markers, 9 lines, stats 79 · 3 ·
  8 · 1 · 487, the same ten stops in order, one day.
- The owner has seen 390 and 1440 px screenshots, in both themes, next to Gallery's own map and
  album pages.

### 2.4 First rollout

Done by the owner after §2.6, ahead of §2.7–§2.9 (DECISIONS-LOG 2026-11-07).

- The trips build replaces the Gallery already running on ThinkCentre next to travel-album; no
  third instance. Data under `/mnt/sata_500/gallery`; reachable on the local network only at
  first. An Authelia OIDC client and backups.

Done when:
- The owner and one family member sign in, and a dev-run migration of their albums opens through
  guest links.

### 2.5 Editor and auto-filing

- Make a trip from an album and pick its kind; the first layout.
- A job files new album assets into stops (D12).
- Unplaced, the stop editor, legs (modes; Valhalla, BRouter, Overpass stations), and Nominatim
  naming.
- Places clustering, and place hints from Immich's CLIP embeddings.
- The clock-offset wizard per camera (D9).
- Every edit checks that the stop, place or leg it references belongs to the same trip, with tests
  (DECISIONS-LOG 2026-10-31: no composite foreign keys).
- The Favorites trip mirrors its owner's stars: starring adds the asset to its album, unstarring
  removes it (D15).
- Port from travel-album's `atlas/geo/*`, `atlas/ingest/{clock,reclock,unanchored,cameras}.py`,
  `atlas/albums/{editor,transit,ends}.py`, `static/admin/editor.js`, and `PLAN §5.8, §5.10–5.13`.

Done when:
- A new trip is built end to end from a phone backup: album → stops → legs → texts in the editor.
- Assets added later are filed without touching existing stops and texts.
- An editor can edit stops; a viewer cannot.

### 2.6 LLM texts

- Per-user LLM settings (D16). Generates stop stories, place articles, and captions where the
  description is empty, through an OpenAI-compatible server only (no Batch API; revised
  2026-11-01, see `DECISIONS-LOG.md`).
- Port from travel-album's `atlas/texts/{generate,prompts}.py` and `PLAN §5.14`.

Done when:
- One trip is generated through an OpenAI-compatible server, and a failed stop retries on its own.
- A caption typed while generation was running is never overwritten.

### 2.7 Search

Postponed by the owner on 2026-11-07: Gallery already covers most of it; to be discussed again.

- The trip viewer's search and the Cmd+K provider (D17). Port from travel-album's
  `atlas/search.py` and `PLAN §5.15`.

Done when:
- A guest never finds an asset or a stop outside the shared album.

### 2.8 Showcase, home, globe, wall, export

Postponed by the owner on 2026-11-07, as §2.7.

- Port from travel-album's `atlas/albums/{showcase,globe,wall,export}.py` and
  `PLAN §5.18, §5.20`.

Done when:
- A showcase lists only trips that satisfy D14.
- The offline zip opens from `file://`.

### 2.9 Mobile app

Added by the owner on 2026-11-01, revising D18: Gallery's Flutter app shows and edits trips as the
web does. It comes after §2.6; §2.7 and §2.8 are postponed (DECISIONS-LOG 2026-11-07).

- **Entry**: the album page. "Open the trip" when the album has one; "Make a trip" for the
  album's owner when it has none. One hook line in the upstream album page.
- **Trip screen**: Gallery's MapLibre map (`maplibre_gl`, as on Gallery's map page) with the route
  (legs with their mode badges, stop markers, start and finish, overlays) and a bottom sheet of
  stops with the legs between them. A stop opens its assets in a grid and Gallery's asset viewer,
  with captions and likes. The three trip kinds. No road: it stays on the web.
- **Edit mode**, for the album owner and editors (D7); a viewer sees no edit controls:
  - making a trip from an album and picking its kind;
  - stops: title, story, place, delete, merge with the next, split, start and finish, "on the way";
  - assets: move to a stop or a new stop, split here, hide (D11), manual point and its reset, pin
    drag, place search (Nominatim, D13);
  - legs: mode, stations, retry;
  - the clock-offset wizard (D9), place hints, captions (D8).
- LLM generation (§2.6) stays on the web.
- Trip data is read from the server and is online only: no Drift tables and no sync stream. The
  client is the generated Dart `TripsApi`.
- Trip code lives in `mobile/lib/trips/`; upstream and Gallery files get one-line hooks only. UI
  strings are the same `trips_` keys of `i18n/gallery/` (D3).
- Builds for testing carry their own application id suffix (`.trips`), so they install next to
  Gallery from the Play store. No store release.
- Port behaviour from `web/src/lib/trips/`, not its look: the look is Gallery's mobile app.

Done when:
- On migrated `birzhay-2026`, the trip screen matches the reference data of §2.3: 10 stop markers,
  9 lines, stats 79 · 3 · 8 · 1 · 487, the same ten stops in order.
- A trip is made from an album on the phone and edited there end to end (stops, assets, legs,
  texts), and every edit reads back the same on the web, and the other way round.
- An editor edits a trip on the phone; a viewer cannot.
- The owner has seen emulator screenshots, phone and tablet, in both themes, next to Gallery's own
  album and map screens.
- Codegen, `dart analyze` and `flutter test` are green.

## 3. Not done

- The road and LLM generation in the mobile app (§2.9).
- Writing trip points into asset coordinates (D10).
- Keeping old travel-album URLs (D19).
- Running the migration again after the production run.
- travel-album's activity tracker, quotas, upload and own face model: Gallery's own features
  replace them, or they are dropped.
