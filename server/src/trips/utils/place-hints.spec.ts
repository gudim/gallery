import { describe, expect, it } from 'vitest';
import { PLACE_HINT_SIMILARITY, placeHints } from 'src/trips/utils/place-hints.js';

const LIKE = PLACE_HINT_SIMILARITY;

describe(placeHints.name, () => {
  it('groups assets by the place of their most similar anchor, largest place first and most similar first', () => {
    expect(
      placeHints(
        [
          { assetId: 'a', stopId: 'small', similarity: LIKE + 0.01 },
          { assetId: 'b', stopId: 'big', similarity: LIKE + 0.01 },
          { assetId: 'c', stopId: 'big', similarity: LIKE + 0.05 },
        ],
        true,
      ),
    ).toEqual({
      places: [
        { stopId: 'big', assetIds: ['c', 'b'] },
        { stopId: 'small', assetIds: ['a'] },
      ],
      center: [],
    });
  });

  it('offers the centre to an asset like no anchor, or with no anchor at all, in their order', () => {
    expect(
      placeHints(
        [
          { assetId: 'a', stopId: 'p', similarity: LIKE - 0.01 },
          { assetId: 'b', stopId: 'p', similarity: LIKE },
          { assetId: 'c', stopId: null, similarity: null },
        ],
        true,
      ),
    ).toEqual({ places: [{ stopId: 'p', assetIds: ['b'] }], center: ['a', 'c'] });
  });

  it('offers no centre to a trip without one', () => {
    expect(placeHints([{ assetId: 'a', stopId: null, similarity: null }], false)).toEqual({ places: [], center: [] });
  });

  it('orders places of the same size by their id, and assets equally similar by their order', () => {
    expect(
      placeHints(
        [
          { assetId: 'a', stopId: 'q', similarity: LIKE },
          { assetId: 'b', stopId: 'p', similarity: LIKE },
          { assetId: 'c', stopId: 'p', similarity: LIKE },
          { assetId: 'd', stopId: 'q', similarity: LIKE },
        ],
        false,
      ).places,
    ).toEqual([
      { stopId: 'p', assetIds: ['b', 'c'] },
      { stopId: 'q', assetIds: ['a', 'd'] },
    ]);
  });
});
