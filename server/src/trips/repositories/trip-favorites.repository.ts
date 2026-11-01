import { Injectable } from '@nestjs/common';
import { Kysely, Transaction, sql } from 'kysely';
import { InjectKysely } from 'nestjs-kysely';
import { DummyValue, GenerateSql } from 'src/decorators.js';
import { AlbumUserRole, AssetVisibility } from 'src/enum.js';
import { DB } from 'src/schema/index.js';
import { TripKind } from 'src/trips/enum.js';
import { refreshStops } from 'src/trips/repositories/trip-editor.repository.js';
import { fileTripAssets } from 'src/trips/repositories/trip-filing.repository.js';
import {
  bumpContentVersion,
  getFavoritesAlbumId,
  lockOwner,
  lockTrip,
} from 'src/trips/repositories/trip.repository.js';
import { asUuid } from 'src/utils/database.js';

/** The album of the user's Favorites trip, or null when there is none, and how many places mirroring opened. */
export type TripFavoritesMirrored = { albumId: string | null; stops: number };

/** The album and trip a star makes when the user has no Favorites trip. */
export type TripFavoritesNew = { albumName: string; language: string };

// The Favorites trip mirrors its owner's stars (trips PLAN D15).
@Injectable()
export class TripFavoritesRepository {
  constructor(@InjectKysely() private db: Kysely<DB>) {}

  /**
   * Makes the album of the user's Favorites trip hold their stars. Stars are the truth: a starred asset the user could
   * add to an album by hand (their own, or a partner's, as Immich's `AssetShare` allows) outside the trash joins the
   * album and is filed, and an album asset that is no longer such a star leaves it, so an ended partnership takes the
   * partner's assets out too. Then, as travel-album's
   * `favorites.refresh`, a place without assets goes unless it is the centre, and every other place follows its assets,
   * so an asset Gallery took out of the album is caught up too. With `newTrip`, a user without a Favorites trip who has
   * such a star gets a new album and Places trip.
   */
  @GenerateSql({ params: [DummyValue.UUID, { albumName: DummyValue.STRING, language: DummyValue.STRING }] })
  mirror(userId: string, newTrip: TripFavoritesNew | null): Promise<TripFavoritesMirrored> {
    return this.db.transaction().execute(async (trx) => {
      await lockOwner(trx, userId);
      let albumId = await getFavoritesAlbumId(trx, userId);
      if (!albumId) {
        if (!newTrip || !(await starsToAdd(trx, userId).select('asset.id').executeTakeFirst())) {
          return { albumId: null, stops: 0 };
        }
        albumId = await createFavoritesTrip(trx, userId, newTrip);
      }
      const trip = await lockTrip(trx, albumId);
      if (!trip) {
        return { albumId: null, stops: 0 };
      }

      const before = await placesOf(trx, albumId);
      const removed = await removeUnqualified(trx, albumId, userId);
      const added = await trx
        .insertInto('album_asset')
        .columns(['albumId', 'assetId'])
        .expression(
          starsToAdd(trx, userId)
            .select([sql<string>`${albumId}::uuid`.as('albumId'), 'asset.id'])
            .where(({ not, exists, selectFrom }) =>
              not(
                exists(
                  selectFrom('album_asset')
                    .select('album_asset.assetId')
                    .where('album_asset.albumId', '=', asUuid(albumId))
                    .whereRef('album_asset.assetId', '=', 'asset.id'),
                ),
              ),
            ),
        )
        .onConflict((oc) => oc.doNothing())
        .returning('assetId')
        .execute();
      const filed = await fileTripAssets(trx, albumId, trip.kind, { isUnplacedRefiled: false });
      await refreshPlaces(trx, albumId);

      const isAlbumChanged = removed > 0 || added.length > 0;
      if (isAlbumChanged) {
        await touchAlbum(trx, albumId);
      }
      if (isAlbumChanged || (await placesOf(trx, albumId)) !== before) {
        await bumpContentVersion(trx, albumId);
      }
      return { albumId, stops: filed.stops };
    });
  }

  /** The owner of the album when it is a Favorites trip's, else null. */
  @GenerateSql({ params: [DummyValue.UUID] })
  async getFavoritesOwnerId(albumId: string): Promise<string | null> {
    const owner = await this.db
      .selectFrom('trip')
      .innerJoin('album_user', 'album_user.albumId', 'trip.albumId')
      .select('album_user.userId')
      .where('trip.albumId', '=', asUuid(albumId))
      .where('trip.isFavorites', '=', true)
      .where('album_user.role', '=', AlbumUserRole.Owner)
      .executeTakeFirst();
    return owner?.userId ?? null;
  }
}

// The user's stars that belong in their Favorites album, outside the trash.
const starsToAdd = (trx: Transaction<DB>, userId: string) =>
  qualifyingStars(trx, userId).where('asset.deletedAt', 'is', null);

// The user's stars they could add to an album by hand (Immich's `AssetShare`): their own outside the locked folder, or a
// partner's on the timeline. A trashed asset still counts, so the album keeps it for a restore.
const qualifyingStars = (trx: Transaction<DB>, userId: string) =>
  trx
    .selectFrom('asset_favorite')
    .innerJoin('asset', 'asset.id', 'asset_favorite.assetId')
    .where('asset_favorite.userId', '=', asUuid(userId))
    .where(({ and, or, eb, exists, selectFrom }) =>
      or([
        and([eb('asset.ownerId', '=', asUuid(userId)), eb('asset.visibility', '!=', AssetVisibility.Locked)]),
        and([
          eb('asset.visibility', 'in', [AssetVisibility.Timeline, AssetVisibility.Hidden]),
          exists(
            selectFrom('partner')
              .innerJoin('user as sharedBy', 'sharedBy.id', 'partner.sharedById')
              .select('partner.sharedById')
              .whereRef('partner.sharedById', '=', 'asset.ownerId')
              .where('partner.sharedWithId', '=', asUuid(userId))
              .where('sharedBy.deletedAt', 'is', null),
          ),
        ]),
      ]),
    );

const createFavoritesTrip = async (trx: Transaction<DB>, userId: string, { albumName, language }: TripFavoritesNew) => {
  const { id: albumId } = await trx.insertInto('album').values({ albumName }).returning('id').executeTakeFirstOrThrow();
  await trx.insertInto('album_user').values({ albumId, userId, role: AlbumUserRole.Owner }).execute();
  await trx
    .insertInto('trip')
    .values({ albumId, kind: TripKind.Places, isFavorites: true, language, contentVersion: 1 })
    .execute();
  return albumId;
};

// Takes out of the album every asset that is not a star the user could add by hand: unstarred, a partner's after the
// partnership ended, another user's an editor added (trips DECISIONS-LOG). Returns how many left.
const removeUnqualified = async (trx: Transaction<DB>, albumId: string, userId: string) => {
  const rows = await trx
    .selectFrom('album_asset')
    .select('album_asset.assetId')
    .where('album_asset.albumId', '=', asUuid(albumId))
    .where('album_asset.assetId', 'not in', qualifyingStars(trx, userId).select('asset.id'))
    .execute();
  if (rows.length > 0) {
    await trx
      .deleteFrom('album_asset')
      .where('albumId', '=', asUuid(albumId))
      .where(
        'assetId',
        'in',
        rows.map(({ assetId }) => assetId),
      )
      .execute();
  }
  return rows.length;
};

// Drops the places left without assets, the centre aside, and moves the others' times and centres to their assets.
const refreshPlaces = async (trx: Transaction<DB>, albumId: string) => {
  await trx
    .deleteFrom('trip_stop')
    .where('albumId', '=', asUuid(albumId))
    .where('role', 'is', null)
    .where('isAtCenter', '=', false)
    .where(({ not, exists, selectFrom }) =>
      not(
        exists(
          selectFrom('trip_asset').select('trip_asset.assetId').whereRef('trip_asset.stopId', '=', 'trip_stop.id'),
        ),
      ),
    )
    .execute();
  const kept = await trx.selectFrom('trip_stop').select('id').where('albumId', '=', asUuid(albumId)).execute();
  await refreshStops(
    trx,
    albumId,
    TripKind.Places,
    kept.map(({ id }) => id),
  );
};

// The trip's places as they stand, to tell whether mirroring changed them.
const placesOf = async (trx: Transaction<DB>, albumId: string) => {
  const rows = await trx
    .selectFrom('trip_stop')
    .select(['id', 'latitude', 'longitude', 'localStart', 'localEnd'])
    .where('albumId', '=', asUuid(albumId))
    .orderBy('id')
    .execute();
  return JSON.stringify(rows);
};

// The album changed: its cover stays while it is still in the album, else the newest asset takes it.
const touchAlbum = (trx: Transaction<DB>, albumId: string) =>
  sql`
    UPDATE "album" SET "updatedAt" = now(), "albumThumbnailAssetId" = CASE
      WHEN EXISTS (
        SELECT 1 FROM "album_asset"
        WHERE "album_asset"."albumId" = "album"."id" AND "album_asset"."assetId" = "album"."albumThumbnailAssetId"
      ) THEN "album"."albumThumbnailAssetId"
      ELSE (
        SELECT "asset"."id" FROM "album_asset" INNER JOIN "asset" ON "asset"."id" = "album_asset"."assetId"
        WHERE "album_asset"."albumId" = "album"."id" AND "asset"."deletedAt" IS NULL
        ORDER BY "asset"."fileCreatedAt" DESC LIMIT 1
      )
    END
    WHERE "album"."id" = ${asUuid(albumId)}
  `.execute(trx);
