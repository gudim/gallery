import { sql } from 'kysely';

/**
 * Leaves out the album of a Favorites trip, where a Space contributes nothing: that album holds only its owner's own
 * and partners' starred assets, so a guest link to it never shows another user's (trips DECISIONS-LOG 2026-10-31).
 */
export const isNotFavoritesTripAlbum = (albumIdColumn: string) =>
  sql<boolean>`NOT EXISTS (SELECT 1 FROM "trip" WHERE "trip"."albumId" = ${sql.ref(albumIdColumn)} AND "trip"."isFavorites")`;
