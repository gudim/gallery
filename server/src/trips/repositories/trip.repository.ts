import { Injectable } from '@nestjs/common';
import { Insertable, Kysely, sql } from 'kysely';
import { InjectKysely } from 'nestjs-kysely';
import { DummyValue, GenerateSql } from 'src/decorators.js';
import { AlbumUserRole } from 'src/enum.js';
import { DB } from 'src/schema/index.js';
import { TripsDB } from 'src/trips/schema/index.js';
import { asUuid } from 'src/utils/database.js';

export type TripRows = {
  trip: Insertable<TripsDB['trip']>;
  places: Insertable<TripsDB['trip_place']>[];
  stops: Insertable<TripsDB['trip_stop']>[];
  assets: Insertable<TripsDB['trip_asset']>[];
  legs: Insertable<TripsDB['trip_leg']>[];
  overlays: Insertable<TripsDB['trip_overlay']>[];
  likes: Insertable<TripsDB['trip_like']>[];
};

@Injectable()
export class TripRepository {
  constructor(@InjectKysely() private db: Kysely<DB>) {}

  @GenerateSql({ params: [DummyValue.UUID] })
  async exists(albumId: string): Promise<boolean> {
    const row = await this.db
      .selectFrom('trip')
      .select('trip.albumId')
      .where('trip.albumId', '=', asUuid(albumId))
      .executeTakeFirst();
    return !!row;
  }

  /** Whether the user already owns a Favorites trip (trips PLAN D15: one per album owner). */
  @GenerateSql({ params: [DummyValue.UUID] })
  async hasFavoritesTrip(ownerId: string): Promise<boolean> {
    const row = await this.db
      .selectFrom('trip')
      .innerJoin('album', 'album.id', 'trip.albumId')
      .innerJoin('album_user', (join) =>
        join
          .onRef('album_user.albumId', '=', 'album.id')
          .on('album_user.role', '=', sql.lit(AlbumUserRole.Owner))
          .on('album_user.userId', '=', asUuid(ownerId)),
      )
      .select('trip.albumId')
      .where('album.deletedAt', 'is', null)
      .where('trip.isFavorites', '=', true)
      .executeTakeFirst();
    return !!row;
  }

  /** Of `assetIds`, those in the album, trashed ones included. */
  @GenerateSql({ params: [DummyValue.UUID, [DummyValue.UUID]] })
  async getAlbumAssetIds(albumId: string, assetIds: string[]): Promise<Set<string>> {
    if (assetIds.length === 0) {
      return new Set();
    }
    const rows = await this.db
      .selectFrom('album_asset')
      .select('album_asset.assetId')
      .where('album_asset.albumId', '=', asUuid(albumId))
      .where('album_asset.assetId', 'in', assetIds)
      .execute();
    return new Set(rows.map(({ assetId }) => assetId));
  }

  @GenerateSql({ params: [DummyValue.UUID] })
  get(albumId: string) {
    return this.db.transaction().execute(async (trx) => {
      const trip = await trx.selectFrom('trip').selectAll().where('albumId', '=', asUuid(albumId)).executeTakeFirst();
      if (!trip) {
        return;
      }
      const [places, stops, assets, legs, overlays, likes] = await Promise.all([
        trx.selectFrom('trip_place').selectAll().where('albumId', '=', albumId).orderBy('key').execute(),
        trx
          .selectFrom('trip_stop')
          .selectAll()
          .where('albumId', '=', albumId)
          // The start is always first and the finish last (travel-album П20).
          .orderBy(sql`CASE "role" WHEN 'origin' THEN 0 WHEN 'finish' THEN 2 ELSE 1 END`)
          .orderBy('localStart', (ob) => ob.asc().nullsLast())
          .orderBy('sequence')
          .orderBy('id')
          .execute(),
        // The trip's assets are the album's (trips ADR 0001); an asset in the trash keeps its filing but is not shown.
        trx
          .selectFrom('album_asset')
          .innerJoin('asset', 'asset.id', 'album_asset.assetId')
          .leftJoin('trip_asset', (join) =>
            join.onRef('trip_asset.albumId', '=', 'album_asset.albumId').onRef('trip_asset.assetId', '=', 'asset.id'),
          )
          .select([
            'asset.id as assetId',
            'trip_asset.stopId',
            'trip_asset.latitude',
            'trip_asset.longitude',
            'trip_asset.pointSource',
          ])
          .where('album_asset.albumId', '=', albumId)
          .where('asset.deletedAt', 'is', null)
          .orderBy('asset.localDateTime')
          .orderBy('asset.id')
          .execute(),
        trx.selectFrom('trip_leg').selectAll().where('albumId', '=', albumId).execute(),
        trx.selectFrom('trip_overlay').selectAll().where('albumId', '=', albumId).orderBy('id').execute(),
        trx
          .selectFrom('trip_like')
          .innerJoin('asset', 'asset.id', 'trip_like.assetId')
          .select(['trip_like.assetId', sql<number>`count(*)::int`.as('count')])
          .where('trip_like.albumId', '=', albumId)
          .where('asset.deletedAt', 'is', null)
          .groupBy('trip_like.assetId')
          .orderBy('trip_like.assetId')
          .execute(),
      ]);
      return { trip, places, stops, assets, legs, overlays, likes };
    });
  }

  async create({ trip, places, stops, assets, legs, overlays, likes }: TripRows) {
    await this.db.transaction().execute(async (trx) => {
      await trx.insertInto('trip').values(trip).execute();
      if (places.length > 0) {
        await trx.insertInto('trip_place').values(places).execute();
      }
      if (stops.length > 0) {
        await trx.insertInto('trip_stop').values(stops).execute();
      }
      if (assets.length > 0) {
        await trx.insertInto('trip_asset').values(assets).execute();
      }
      if (legs.length > 0) {
        await trx.insertInto('trip_leg').values(legs).execute();
      }
      if (overlays.length > 0) {
        await trx.insertInto('trip_overlay').values(overlays).execute();
      }
      if (likes.length > 0) {
        await trx.insertInto('trip_like').values(likes).execute();
      }
    });
  }
}
