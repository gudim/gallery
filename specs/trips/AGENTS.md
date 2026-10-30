# Trips layer: agent instructions

How to work on the trip layer of this fork. Gallery's root `AGENTS.md` applies in full; this
file adds what is specific to trips.

## Order of work

- Before working, read [GLOSSARY.md](GLOSSARY.md), [adr/](adr/), [PLAN.md](PLAN.md),
  `DECISIONS-LOG.md` and `PROGRESS.md` (the last two are created with the first entry).
- Stages of `PLAN.md` go strictly in order. A stage is closed when every "Done when" item is
  checked; record the check in `PROGRESS.md`.
- A choice that neither `PLAN.md` nor the ADRs settle: ask the owner. A choice you make yourself
  that the plan does not dictate: one line in `DECISIONS-LOG.md`. A decision that is hard to
  reverse, surprising, and the result of a real trade-off gets an ADR in `adr/`.
- Use the glossary's terms in code, UI and docs. A new domain term goes into `GLOSSARY.md`
  when it is settled; the glossary holds no implementation details.
- Stage N is branch `trips-N`. One step, one commit; tests, lint and format must be green before
  the commit. Push and PRs only with the owner's consent.
- Docs, commits and comments are in English. The owner talks in Russian.

## Environment

- The working copy is `/home/egudim/GIT_PERS/gallery` (ext4). Do not work in the clone on
  `/mnt/1tb_sdcard`: exFAT has no symlinks, and pnpm and `CLAUDE.md → AGENTS.md` need them.
- Development machine: ThinkPad. Server: ThinkCentre mini PC at home, which also runs
  travel-album and the shared Authelia. Do not carry the ThinkPad's hardware assumptions over to
  the server.
- travel-album (`/mnt/1tb_sdcard/Development/GIT_REPOS/travel-album`) is the source of the
  features being ported. From this repo it is read-only. The migration script (PLAN §2.2) is
  written there, under that repo's own `agent.md`.
- The trip data in `/mnt/1tb_sdcard/Personal/Photos/` and travel-album's `.ref/` copies are
  read-only.

## Code

- Trip code lives in the trip namespaces (`server/src/trips/`, `web/src/lib/trips/`, and those
  that stage 0 fixes in `DECISIONS-LOG.md`). Gallery and Immich files get one-line hooks only. Every
  trip table appears in `scripts/revert-to-immich.sql`; every trip foreign key onto an upstream
  key appears in `server/src/schema/gallery-upstream-fks.json`.
- Every route that returns trip data or files checks album access first (owner, editor, viewer,
  or the shared link of that album). A trip the caller cannot see is 404, the same as a missing
  album.
- User strings never go through `{@html}` or into MapLibre's `setHTML`; use text nodes or Svelte
  text.
- UI strings: `trips_` keys in `i18n/gallery/`, en plus Gallery's nine locales, following Gallery's i18n rules (D3).
- Port behaviour, not code: travel-album's tests and `docs/PLAN.md` say what each feature must
  do, and its `intent.md` says why. Read the matching section before porting a feature.

## UI changes

Any change to how a trip screen looks (layout, texts) is checked with screenshots before and
after, at 390 and 1440 px in both themes, shown to the owner side by side. Screenshots stay
outside git.

## Rebasing onto Gallery

Rebase onto a Gallery release tag (`gallery` remote), never onto Gallery `main`. After the rebase:
`tools/upstream-preflight`, the revert spec, the FK registry spec, `node i18n/gallery/merge.mjs
--check`, and the full test suites. Record the rebase in `PROGRESS.md`.
