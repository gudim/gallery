# A caption is the Immich asset description

An asset's caption, whether the owner wrote it or an LLM generated it, is stored in the Immich
asset description, not in a per-trip fork table. That way it shows up in every client, is found
by the stock search and is written to the XMP sidecar, with no code of ours. The price is one
caption per asset: an asset in two trips has the same caption in both. We accepted this because a
caption describes the shot, not the trip.

## Considered Options

- A per-trip caption table: different captions per trip, but stock clients and search would not
  see them.
- The description by default with a per-trip override: two ways to edit one caption.
