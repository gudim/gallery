# A trip is an overlay on an Immich album

A trip (route, stops, legs, stories) is stored in fork tables keyed by an Immich album id, and the
trip's assets are exactly that album's assets. We did not make a trip a Shared Space or an entity
of its own. An album already has an owner, editor and viewer sharing, shared links with password and
expiry, and it is visible to every Immich client, including the mobile apps. Building on a Space
would leave stock clients blind to trips, and a separate entity would mean rewriting sharing and
permissions ourselves.

## Consequences

- Who may edit a trip follows the album role: the owner and editors edit, viewers read.
- Hiding an asset from guests means removing it from the album. There is no per-trip hidden flag,
  because every stock shared-link path (grid, zip download, mobile) would have to learn it.
- Guest access is the album's shared link. There is no separate trip visibility.
- Assets added to the album by anyone, from any client, have to be filed into stops automatically.
