# Glossary: trips on top of Gallery

The language of the trip layer carried over from travel-album. Immich/Gallery terms (asset,
album, library, Shared Space) are not redefined here, only tied to.

## Trip

An Immich album to which its owner has added a route. Without a route it is a plain album; the
trip's assets are exactly the album's assets.
_Avoid_: "atlas album", "trip album" as a separate thing.

## Trip kind

How a trip arranges its stops. **Route**: stops follow each other in time, joined by legs.
**Places**: a stop is a place, not a visit; visits years apart land in the same stop.
**Plain**: no map; stops are sections by day.

## Favorites trip

A user's Places trip whose assets are exactly the assets that user starred as favorites.
Starring an asset anywhere adds it; unstarring removes it, and hiding it in the trip unstars it.

## Showcase

A user's public page listing the trips they marked for it. Only a trip with a live guest link
without a password can be on a showcase. The home page is an admin's pick from showcased trips.

## Stop

A place on a trip's route that assets belong to: a point, a time of stay, its own story. Each
trip asset is in at most one stop. When an asset is added to the album, the trip files it into a
stop by itself, by time and place; the owner's stops and texts stay as they were.

## Unplaced

Trip assets that could not be filed into any stop. They wait to be moved by hand.

## Inferred point

The location of an asset without GPS, derived from its neighbours in time. It belongs to the
trip, not to the asset: in the library the asset still has no coordinates.
_Avoid_: "asset GPS" for an inferred point.

## Manual point

The location of an asset placed on the map by hand in a trip. Like an inferred point, it belongs
to the trip and is never written into the asset's coordinates.

## Clock offset

A correction to the time of a camera that shot without GPS. The corrected time becomes the
asset's date in the library: it is right everywhere, not only in the trip. Only the asset's owner
can apply it; a trip editor cannot shift the clock of someone else's assets.

## Hide

Remove an asset from the trip's album. It stays in the library and leaves its stop. There are no
assets that are in a trip but not visible to its guests.

## Guest link

A shared link of the trip's album: key or slug, password, expiry. Through it a guest sees the
trip in the trip viewer. There is no separate "trip visibility".

## Caption

The text of a single asset. It is the Immich asset description: one per asset, wherever the
asset is. An asset in two trips has one caption.
_Avoid_: "trip caption", "caption override".
