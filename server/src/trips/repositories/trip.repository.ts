import { Injectable } from '@nestjs/common';
import { Insertable, Kysely, Transaction, sql } from 'kysely';
import { InjectKysely } from 'nestjs-kysely';
import type { ClockAsset } from 'src/trips/utils/clock.js';
import { DummyValue, GenerateSql } from 'src/decorators.js';
import { AlbumUserRole, AssetType } from 'src/enum.js';
import { DB } from 'src/schema/index.js';
import { TripKind, TripPointSource, TripStopRole } from 'src/trips/enum.js';
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

export enum TripCreateResult {
  Created = 'created',
  AlbumMissing = 'album-missing',
  TripExists = 'trip-exists',
  FavoritesExists = 'favorites-exists',
}

// Trip order (travel-album `ordered_stops`, decision P20): the start first, the finish last, the rest by local start
// time. A point added by hand without a time comes first after the start, where it was placed; a stop of assets
// without a time (a Plain trip's undated section) comes just before the finish.
export const stopOrder = (stop: 'trip_stop' | 'from_stop') =>
  sql.join([
    sql`CASE
      WHEN ${sql.ref(`${stop}.role`)} = ${sql.lit(TripStopRole.Start)} THEN 0
      WHEN ${sql.ref(`${stop}.role`)} = ${sql.lit(TripStopRole.Finish)} THEN 3
      WHEN ${sql.ref(`${stop}.localStart`)} IS NULL AND NOT ${sql.ref(`${stop}.isAddedByHand`)} THEN 2
      ELSE 1 END`,
    sql`${sql.ref(`${stop}.localStart`)} ASC NULLS FIRST`,
    sql.ref(`${stop}.sequence`),
    sql.ref(`${stop}.id`),
  ]);

@Injectable()
export class TripRepository {
  constructor(@InjectKysely() private db: Kysely<DB>) {}

  /** Of `assetIds`, or of every asset without them, those in the album, trashed ones included. */
  @GenerateSql({ params: [DummyValue.UUID, [DummyValue.UUID]] })
  async getAlbumAssetIds(albumId: string, assetIds?: string[]): Promise<Set<string>> {
    if (assetIds?.length === 0) {
      return new Set();
    }
    const rows = await this.db
      .selectFrom('album_asset')
      .select('album_asset.assetId')
      .where('album_asset.albumId', '=', asUuid(albumId))
      .$if(!!assetIds, (qb) => qb.where('album_asset.assetId', 'in', assetIds!))
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
   * Writes a new trip in one transaction. A lock on the owner serialises imports, so "the album already has a trip"
   * and "the owner already has a Favorites trip" are checked against committed state.
   */
  create(ownerId: string, rows: TripRows): Promise<TripCreateResult> {
    const { trip, places, stops, assets, legs, overlays, likes, generatedCaptions } = rows;
    return this.db.transaction().execute(async (trx) => {
      await lockOwner(trx, ownerId);
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
      if (trip.isFavorites && (await getFavoritesAlbumId(trx, ownerId))) {
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
        await recordLocalTimes(trx, trip.albumId);
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

  /** Albums with a trip, outside the trash, that hold the asset. */
  @GenerateSql({ params: [DummyValue.UUID] })
  async getTripAlbumIds(assetId: string): Promise<string[]> {
    const rows = await this.db
      .selectFrom('trip')
      .innerJoin('album', 'album.id', 'trip.albumId')
      .innerJoin('album_asset', 'album_asset.albumId', 'trip.albumId')
      .select('trip.albumId')
      .where('album_asset.assetId', '=', asUuid(assetId))
      .where('album.deletedAt', 'is', null)
      .execute();
    return rows.map(({ albumId }) => albumId);
  }

  /** Whether the album, outside the trash, has a trip. */
  @GenerateSql({ params: [DummyValue.UUID] })
  async hasTrip(albumId: string): Promise<boolean> {
    const row = await this.db
      .selectFrom('trip')
      .innerJoin('album', 'album.id', 'trip.albumId')
      .select('trip.albumId')
      .where('trip.albumId', '=', asUuid(albumId))
      .where('album.deletedAt', 'is', null)
      .executeTakeFirst();
    return !!row;
  }

  /** The trip's kind; null for no trip. */
  @GenerateSql({ params: [DummyValue.UUID] })
  async getKind(albumId: string): Promise<TripKind | null> {
    const row = await this.db
      .selectFrom('trip')
      .select('kind')
      .where('albumId', '=', asUuid(albumId))
      .executeTakeFirst();
    return row?.kind ?? null;
  }

  /** The album's assets outside the trash with their camera, owner, local time and own GPS, for the clock wizard. */
  @GenerateSql({ params: [DummyValue.UUID] })
  getClockAssets(albumId: string): Promise<ClockAsset[]> {
    return this.db
      .selectFrom('album_asset')
      .innerJoin('asset', 'asset.id', 'album_asset.assetId')
      .leftJoin('asset_exif', 'asset_exif.assetId', 'asset.id')
      .select([
        'asset.id',
        'asset.ownerId',
        'asset_exif.make',
        'asset_exif.model',
        sql<boolean>`"asset"."type" = ${AssetType.Video}`.as('isVideo'),
        'asset.localDateTime as time',
        'asset_exif.latitude',
        'asset_exif.longitude',
      ])
      .where('album_asset.albumId', '=', asUuid(albumId))
      .where('asset.deletedAt', 'is', null)
      .orderBy('asset.localDateTime')
      .orderBy('asset.id')
      .execute();
  }

  /** The language the trip's stops and stations are named in; null for the instance's, or for no trip. */
  @GenerateSql({ params: [DummyValue.UUID] })
  async getLanguage(albumId: string): Promise<string | null> {
    const row = await this.db
      .selectFrom('trip')
      .select('language')
      .where('albumId', '=', asUuid(albumId))
      .executeTakeFirst();
    return row?.language ?? null;
  }

  /**
   * The Unplaced assets with a CLIP embedding, outside the trash and in time order, each with the place of its most
   * similar anchor (`placeHints`): an asset with its own GPS or a manual point, in a stop that is not the start, the
   * finish or the centre. The anchors are materialized so the nearest one is found exactly, not by the vector index,
   * which would filter them after an approximate scan. Also whether the trip has a centre. Null for a trip that is not
   * Places, or no trip.
   */
  @GenerateSql({ params: [DummyValue.UUID] })
  async getPlaceHintRows(albumId: string) {
    const id = asUuid(albumId);
    const trip = await this.db
      .selectFrom('trip')
      .select((eb) =>
        eb
          .exists(
            eb
              .selectFrom('trip_stop')
              .select('trip_stop.id')
              .whereRef('trip_stop.albumId', '=', 'trip.albumId')
              .where('trip_stop.isAtCenter', '=', true),
          )
          .as('hasCenter'),
      )
      .where('trip.albumId', '=', id)
      .where('trip.kind', '=', TripKind.Places)
      .executeTakeFirst();
    if (!trip) {
      return null;
    }
    const rows = await this.db
      .with(
        (cte) => cte('anchor').materialized(),
        (qb) =>
          qb
            .selectFrom('trip_asset')
            .innerJoin('trip_stop', 'trip_stop.id', 'trip_asset.stopId')
            .innerJoin('asset', 'asset.id', 'trip_asset.assetId')
            .innerJoin('smart_search', 'smart_search.assetId', 'trip_asset.assetId')
            .leftJoin('asset_exif', 'asset_exif.assetId', 'trip_asset.assetId')
            .select(['trip_asset.stopId', 'smart_search.embedding'])
            .where('trip_asset.albumId', '=', id)
            .where('asset.deletedAt', 'is', null)
            .where('trip_stop.role', 'is', null)
            .where('trip_stop.isAtCenter', '=', false)
            .where((eb) =>
              eb.or([
                eb('trip_asset.pointSource', '=', TripPointSource.Manual),
                eb.and([eb('trip_asset.pointSource', 'is', null), eb('asset_exif.latitude', 'is not', null)]),
              ]),
            ),
      )
      .selectFrom('trip_asset')
      .innerJoin('asset', 'asset.id', 'trip_asset.assetId')
      .innerJoin('smart_search', 'smart_search.assetId', 'trip_asset.assetId')
      .leftJoinLateral(
        (eb) =>
          eb
            .selectFrom('anchor')
            .select(['anchor.stopId', sql<number>`anchor.embedding <=> smart_search.embedding`.as('distance')])
            .orderBy('distance')
            .limit(1)
            .as('nearest'),
        (join) => join.onTrue(),
      )
      .select(['trip_asset.assetId', 'nearest.stopId', sql<number | null>`1 - nearest.distance`.as('similarity')])
      .where('trip_asset.albumId', '=', id)
      .where('trip_asset.stopId', 'is', null)
      .where('asset.deletedAt', 'is', null)
      .orderBy('asset.localDateTime')
      .orderBy('asset.id')
      .execute();
    return { rows, hasCenter: Boolean(trip.hasCenter) };
  }

  /** The owners of Favorites trips outside the trash: the nightly sweep mirrors stars no event reported. */
  @GenerateSql()
  async getFavoritesOwnerIds(): Promise<string[]> {
    const rows = await this.db
      .selectFrom('trip')
      .innerJoin('album', 'album.id', 'trip.albumId')
      .innerJoin('album_user', 'album_user.albumId', 'trip.albumId')
      .select('album_user.userId')
      .distinct()
      .where('trip.isFavorites', '=', true)
      .where('album.deletedAt', 'is', null)
      .where('album_user.role', '=', AlbumUserRole.Owner)
      .execute();
    return rows.map(({ userId }) => userId);
  }
}

// Holds the trip row, so writes to one trip queue up. Nothing when the trip is missing or its album is in the trash.
export const lockTrip = (trx: Transaction<DB>, albumId: string) =>
  trx
    .selectFrom('trip')
    .innerJoin('album', 'album.id', 'trip.albumId')
    .select(['trip.albumId', 'trip.kind'])
    .where('trip.albumId', '=', asUuid(albumId))
    .where('album.deletedAt', 'is', null)
    .forUpdate('trip')
    .executeTakeFirst();

/**
 * Records the asset's local time on every filing of the trip that has none yet, so a time changed later is seen
 * (`TripEditorRepository.retime`). Called after each write that adds filings.
 */
export const recordLocalTimes = (trx: Transaction<DB>, albumId: string) =>
  sql`
    UPDATE "trip_asset" SET "localDateTime" = "asset"."localDateTime"
    FROM "asset"
    WHERE "asset"."id" = "trip_asset"."assetId" AND "trip_asset"."albumId" = ${asUuid(albumId)}
      AND "trip_asset"."localDateTime" IS NULL
  `.execute(trx);

export const bumpContentVersion = (trx: Transaction<DB>, albumId: string) =>
  trx
    .updateTable('trip')
    .set((eb) => ({ contentVersion: eb('contentVersion', '+', 1) }))
    .where('albumId', '=', asUuid(albumId))
    .execute();

// Serialises the writes that create an owner's trips: imports, and the Favorites trip made by a star.
export const lockOwner = (trx: Transaction<DB>, ownerId: string) =>
  sql`SELECT pg_advisory_xact_lock(hashtext(${'trip-owner:' + ownerId}))`.execute(trx);

/** The album of the user's Favorites trip, outside the trash (trips PLAN D15: one per album owner). */
export const getFavoritesAlbumId = async (trx: Transaction<DB>, ownerId: string) => {
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
    .orderBy('album.createdAt')
    .executeTakeFirst();
  return row?.albumId ?? null;
};
