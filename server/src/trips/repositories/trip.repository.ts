import { Injectable } from '@nestjs/common';
import { Insertable, Kysely, Transaction, sql } from 'kysely';
import { InjectKysely } from 'nestjs-kysely';
import { DummyValue, GenerateSql } from 'src/decorators.js';
import { AlbumUserRole } from 'src/enum.js';
import { DB } from 'src/schema/index.js';
import { TripStopRole } from 'src/trips/enum.js';
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
  generatedCaptions: Insertable<TripsDB['trip_generated_caption']>[];
};

/** Who likes: a signed-in user, or a guest known by their browser key (trips GLOSSARY "Like"). */
export type TripLiker = { userId: string } | { viewerKey: string };

const isLiker = (liker: TripLiker | undefined) =>
  liker === undefined
    ? sql<boolean>`false`
    : 'userId' in liker
      ? sql<boolean>`coalesce(bool_or("trip_like"."userId" = ${asUuid(liker.userId)}), false)`
      : sql<boolean>`coalesce(bool_or("trip_like"."viewerKey" = ${liker.viewerKey}), false)`;

export type TripStopChanges = { title?: string | null; story?: string | null; placeId?: string | null };

export enum TripEditResult {
  Updated = 'updated',
  TripMissing = 'trip-missing',
  StopMissing = 'stop-missing',
  PlaceForeign = 'place-foreign',
}

export enum TripCreateResult {
  Created = 'created',
  AlbumMissing = 'album-missing',
  TripExists = 'trip-exists',
  FavoritesExists = 'favorites-exists',
}

// Trip order: the start first, the finish last (travel-album decision P20), the rest by local start time.
const stopOrder = (stop: 'trip_stop' | 'from_stop') =>
  sql.join([
    sql`CASE ${sql.ref(`${stop}.role`)} WHEN ${sql.lit(TripStopRole.Start)} THEN 0 WHEN ${sql.lit(TripStopRole.Finish)} THEN 2 ELSE 1 END`,
    sql`${sql.ref(`${stop}.localStart`)} ASC NULLS LAST`,
    sql.ref(`${stop}.sequence`),
    sql.ref(`${stop}.id`),
  ]);

@Injectable()
export class TripRepository {
  constructor(@InjectKysely() private db: Kysely<DB>) {}

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

  /** The album's assets outside the trash in time order, with their own GPS, for laying the trip out. */
  @GenerateSql({ params: [DummyValue.UUID] })
  getLayoutAssets(albumId: string) {
    return this.db
      .selectFrom('album_asset')
      .innerJoin('asset', 'asset.id', 'album_asset.assetId')
      .leftJoin('asset_exif', 'asset_exif.assetId', 'asset.id')
      .select(['asset.id', 'asset.localDateTime as time', 'asset_exif.latitude', 'asset_exif.longitude'])
      .where('album_asset.albumId', '=', asUuid(albumId))
      .where('asset.deletedAt', 'is', null)
      .orderBy('asset.localDateTime')
      .orderBy('asset.id')
      .execute();
  }

  /** The whole trip, or nothing when the album has none or is in the trash. Likes say whether `liker` is among them. */
  @GenerateSql({ params: [DummyValue.UUID, { userId: DummyValue.UUID }] })
  get(albumId: string, liker?: TripLiker) {
    const id = asUuid(albumId);
    return this.db.transaction().execute(async (trx) => {
      const trip = await trx
        .selectFrom('trip')
        .innerJoin('album', 'album.id', 'trip.albumId')
        .selectAll('trip')
        .where('trip.albumId', '=', id)
        .where('album.deletedAt', 'is', null)
        .executeTakeFirst();
      if (!trip) {
        return;
      }
      const [places, stops, assets, legs, overlays, likes] = await Promise.all([
        trx.selectFrom('trip_place').selectAll().where('albumId', '=', id).orderBy('key').execute(),
        trx.selectFrom('trip_stop').selectAll().where('albumId', '=', id).orderBy(stopOrder('trip_stop')).execute(),
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
          .where('album_asset.albumId', '=', id)
          .where('asset.deletedAt', 'is', null)
          .orderBy('asset.localDateTime')
          .orderBy('asset.id')
          .execute(),
        trx
          .selectFrom('trip_leg')
          .innerJoin('trip_stop as from_stop', 'from_stop.id', 'trip_leg.fromStopId')
          .selectAll('trip_leg')
          .where('trip_leg.albumId', '=', id)
          .orderBy(stopOrder('from_stop'))
          .orderBy('trip_leg.id')
          .execute(),
        trx.selectFrom('trip_overlay').selectAll().where('albumId', '=', id).orderBy('id').execute(),
        trx
          .selectFrom('trip_like')
          .innerJoin('asset', 'asset.id', 'trip_like.assetId')
          .select(['trip_like.assetId', sql<number>`count(*)::int`.as('count'), isLiker(liker).as('isLiked')])
          .where('trip_like.albumId', '=', id)
          .where('asset.deletedAt', 'is', null)
          .groupBy('trip_like.assetId')
          .orderBy('trip_like.assetId')
          .execute(),
      ]);
      return { trip, places, stops, assets, legs, overlays, likes };
    });
  }

  /** Whether the album has a trip and the asset is in it, outside the trash. */
  @GenerateSql({ params: [DummyValue.UUID, DummyValue.UUID] })
  async hasAsset(albumId: string, assetId: string): Promise<boolean> {
    const row = await this.db
      .selectFrom('trip')
      .innerJoin('album_asset', 'album_asset.albumId', 'trip.albumId')
      .innerJoin('asset', 'asset.id', 'album_asset.assetId')
      .select('asset.id')
      .where('trip.albumId', '=', asUuid(albumId))
      .where('album_asset.assetId', '=', asUuid(assetId))
      .where('asset.deletedAt', 'is', null)
      .executeTakeFirst();
    return !!row;
  }

  /** One like per liker: a second like of the same asset changes nothing. */
  @GenerateSql({ params: [DummyValue.UUID, DummyValue.UUID, { userId: DummyValue.UUID }] })
  async like(albumId: string, assetId: string, liker: TripLiker): Promise<void> {
    await this.db
      .insertInto('trip_like')
      .values({ albumId, assetId, ...liker })
      .onConflict((oc) => oc.doNothing())
      .execute();
  }

  @GenerateSql({ params: [DummyValue.UUID, DummyValue.UUID, { userId: DummyValue.UUID }] })
  async unlike(albumId: string, assetId: string, liker: TripLiker): Promise<void> {
    await this.db
      .deleteFrom('trip_like')
      .where('albumId', '=', asUuid(albumId))
      .where('assetId', '=', asUuid(assetId))
      .where((eb) =>
        'userId' in liker ? eb('userId', '=', asUuid(liker.userId)) : eb('viewerKey', '=', liker.viewerKey),
      )
      .execute();
  }

  /** The likes of one asset in the trip. */
  @GenerateSql({ params: [DummyValue.UUID, DummyValue.UUID, { userId: DummyValue.UUID }] })
  async getLike(albumId: string, assetId: string, liker?: TripLiker): Promise<{ count: number; isLiked: boolean }> {
    const row = await this.db
      .selectFrom('trip_like')
      .select([sql<number>`count(*)::int`.as('count'), isLiker(liker).as('isLiked')])
      .where('albumId', '=', asUuid(albumId))
      .where('assetId', '=', asUuid(assetId))
      .executeTakeFirstOrThrow();
    return row;
  }

  /**
   * Sets a stop's texts and place. Every id must belong to this trip: there are no composite keys to check it (trips
   * DECISIONS-LOG 2026-10-31). A text set by hand is `manual`, a cleared one has no source. A finish that is the same
   * place as the start takes the start's title (travel-album decision P20).
   */
  @GenerateSql({ params: [DummyValue.UUID, DummyValue.UUID, { title: DummyValue.STRING }] })
  updateStop(albumId: string, stopId: string, { title, story, placeId }: TripStopChanges): Promise<TripEditResult> {
    return editTrip(this.db, albumId, async (trx) => {
      const stop = await trx
        .selectFrom('trip_stop')
        .select('role')
        .where('albumId', '=', asUuid(albumId))
        .where('id', '=', asUuid(stopId))
        .executeTakeFirst();
      if (!stop) {
        return TripEditResult.StopMissing;
      }
      if (placeId) {
        const place = await trx
          .selectFrom('trip_place')
          .select('id')
          .where('albumId', '=', asUuid(albumId))
          .where('id', '=', asUuid(placeId))
          .executeTakeFirst();
        if (!place) {
          return TripEditResult.PlaceForeign;
        }
      }
      await trx
        .updateTable('trip_stop')
        .set({
          ...(title !== undefined && { title, titleSource: title && 'manual' }),
          ...(story !== undefined && { story, storySource: story && 'manual' }),
          ...(placeId !== undefined && { placeId }),
        })
        .where('id', '=', asUuid(stopId))
        .execute();
      if (title !== undefined && stop.role === TripStopRole.Start) {
        await trx
          .updateTable('trip_stop')
          .set({ title, titleSource: title && 'manual' })
          .where('albumId', '=', asUuid(albumId))
          .where('role', '=', TripStopRole.Finish)
          .where('isFinishAtStart', '=', true)
          .execute();
      }
    });
  }

  /**
   * Writes a new trip in one transaction. A lock on the owner serialises imports, so "the album already has a trip"
   * and "the owner already has a Favorites trip" are checked against committed state.
   */
  create(ownerId: string, rows: TripRows): Promise<TripCreateResult> {
    const { trip, places, stops, assets, legs, overlays, likes, generatedCaptions } = rows;
    return this.db.transaction().execute(async (trx) => {
      await sql`SELECT pg_advisory_xact_lock(hashtext(${'trip-import:' + ownerId}))`.execute(trx);
      const albumId = asUuid(trip.albumId);
      const album = await trx
        .selectFrom('album')
        .select('album.id')
        .where('album.id', '=', albumId)
        .where('album.deletedAt', 'is', null)
        .executeTakeFirst();
      if (!album) {
        return TripCreateResult.AlbumMissing;
      }
      const existing = await trx.selectFrom('trip').select('albumId').where('albumId', '=', albumId).executeTakeFirst();
      if (existing) {
        return TripCreateResult.TripExists;
      }
      if (trip.isFavorites && (await hasFavoritesTrip(trx, ownerId))) {
        return TripCreateResult.FavoritesExists;
      }

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
      if (generatedCaptions.length > 0) {
        await trx
          .insertInto('trip_generated_caption')
          .values(generatedCaptions)
          .onConflict((oc) => oc.column('assetId').doUpdateSet((eb) => ({ text: eb.ref('excluded.text') })))
          .execute();
      }
      return TripCreateResult.Created;
    });
  }
}

/**
 * Runs one edit of a trip in a transaction that holds the trip row, so edits of one trip queue up, and bumps its
 * `contentVersion`. A trip whose album is in the trash is missing. `edit` returns why it refused, or nothing.
 */
const editTrip = (
  db: Kysely<DB>,
  albumId: string,
  edit: (trx: Transaction<DB>) => Promise<TripEditResult | void>,
): Promise<TripEditResult> =>
  db.transaction().execute(async (trx) => {
    const trip = await trx
      .selectFrom('trip')
      .innerJoin('album', 'album.id', 'trip.albumId')
      .select('trip.albumId')
      .where('trip.albumId', '=', asUuid(albumId))
      .where('album.deletedAt', 'is', null)
      .forUpdate('trip')
      .executeTakeFirst();
    if (!trip) {
      return TripEditResult.TripMissing;
    }
    const refused = await edit(trx);
    if (refused) {
      return refused;
    }
    await trx
      .updateTable('trip')
      .set((eb) => ({ contentVersion: eb('contentVersion', '+', 1) }))
      .where('albumId', '=', asUuid(albumId))
      .execute();
    return TripEditResult.Updated;
  });

/** Whether the user already owns a Favorites trip (trips PLAN D15: one per album owner). */
const hasFavoritesTrip = async (trx: Transaction<DB>, ownerId: string) => {
  const row = await trx
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
};
