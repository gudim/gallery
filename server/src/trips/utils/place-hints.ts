// Place hints for the Unplaced assets of a Places trip (trips PLAN §2.5, travel-album `search.place_hints`): an asset
// like an anchor (an asset with its own GPS or a manual point, in a place of the trip) is offered that place; one like
// no anchor is offered the centre, if the trip has one. Hints move nothing; the owner files the assets. Pure: the
// caller finds each asset's most similar anchor.

// Cosine similarity of two assets' CLIP embeddings from which one hints the other's place, measured with Immich's
// ViT-B-16-SigLIP2__webli, the owner's model, and ViT-B-32, which give it alike: about half of these hints lie within
// 400 m of the asset's place. travel-album's 0.75 does not carry over (trips DECISIONS-LOG 2026-10-31, owner).
export const PLACE_HINT_SIMILARITY = 0.85;

// An Unplaced asset with an embedding, in time order, and the place of its most similar anchor, if it has one.
export type PlaceHintRow = { assetId: string; stopId: string | null; similarity: number | null };
export type PlaceHints = { places: Array<{ stopId: string; assetIds: string[] }>; center: string[] };

export const placeHints = (rows: PlaceHintRow[], hasCenter: boolean): PlaceHints => {
  const groups = new Map<string, Array<{ assetId: string; similarity: number }>>();
  const center: string[] = [];
  for (const { assetId, stopId, similarity } of rows) {
    if (stopId !== null && similarity !== null && similarity >= PLACE_HINT_SIMILARITY) {
      groups.set(stopId, [...(groups.get(stopId) ?? []), { assetId, similarity }]);
    } else {
      center.push(assetId);
    }
  }
  const places = [...groups]
    .toSorted(([a, left], [b, right]) => right.length - left.length || a.localeCompare(b))
    .map(([stopId, found]) => ({
      stopId,
      assetIds: found.toSorted((a, b) => b.similarity - a.similarity).map(({ assetId }) => assetId),
    }));
  return { places, center: hasCenter ? center : [] };
};
