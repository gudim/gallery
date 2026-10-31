import { Injectable } from '@nestjs/common';
import { Insertable, Kysely, NotNull, Transaction, sql } from 'kysely';
import { InjectKysely } from 'nestjs-kysely';
import { randomUUID } from 'node:crypto';
import type { ClockAsset } from 'src/trips/utils/clock.js';
import type { BuiltLeg } from 'src/trips/utils/route-leg.js';
import type { Station } from 'src/trips/utils/routing.js';
import { DummyValue, GenerateSql } from 'src/decorators.js';
import { AlbumUserRole, AssetType } from 'src/enum.js';
import { DB } from 'src/schema/index.js';
import {
  TripKind,
  TripLegMode,
  TripLegStatus,
  TripPointSource,
  TripStationSide,
  TripStopRole,
} from 'src/trips/enum.js';
import { TripsDB } from 'src/trips/schema/index.js';
import { fileAssets, syncLegs } from 'src/trips/utils/filing.js';
import { type LatLng, pointOf } from 'src/trips/utils/geo.js';
import { TRIP_TITLE_SOURCE_GEOCODED } from 'src/trips/utils/naming.js';
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

/**
 * A name for a stop, with the point and title source the stop had when it was read: the write is skipped if either
 * changed while Nominatim was asked.
 */
export type TripStopName = {
  id: string;
  latitude: number;
  longitude: number;
  titleSource: string | null;
  title: string;
  region: string | null;
  country: string | null;
};

/** What filing did: how many assets it filed, and how many stops it opened for them. */
export type TripFileResult = { assets: number; stops: number };

export enum TripEditResult {
  Updated = 'updated',
  TripMissing = 'trip-missing',
  StopMissing = 'stop-missing',
  StopIsEnd = 'stop-is-end',
  StopIsPoint = 'stop-is-point',
  StopHasAssets = 'stop-has-assets',
  StopNotPoint = 'stop-not-point',
  NotRoute = 'not-route',
  NoStart = 'no-start',
  AfterFinish = 'after-finish',
  NoMap = 'no-map',
  MergeLast = 'merge-last',
  SplitFirst = 'split-first',
  AssetForeign = 'asset-foreign',
  AssetMissing = 'asset-missing',
  AssetPlaced = 'asset-placed',
  NotPlaces = 'not-places',
  NoCenter = 'no-center',
  MoveEmpties = 'move-empties',
  PlaceForeign = 'place-foreign',
  LegMissing = 'leg-missing',
  LegNotTrain = 'leg-not-train',
  LegNotAttention = 'leg-not-attention',
  NoLegsToRetry = 'no-legs-to-retry',
  Unchanged = 'unchanged',
}

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

  /**
   * Trips, outside the trash, with album assets waiting to be filed, or whose local time changed since the trip placed
   * them (what `TripEditorRepository.retime` follows), so a missed `AssetMetadataExtracted` is caught up.
   */
  @GenerateSql()
  async getAlbumIdsToFile(): Promise<string[]> {
    const rows = await this.db
      .selectFrom('trip')
      .innerJoin('album', 'album.id', 'trip.albumId')
      .select('trip.albumId')
      .where('album.deletedAt', 'is', null)
      .where((eb) =>
        eb.exists(
          eb
            .selectFrom('album_asset')
            .innerJoin('asset', 'asset.id', 'album_asset.assetId')
            .innerJoin('asset_job_status', 'asset_job_status.assetId', 'asset.id')
            .leftJoin('trip_asset', (join) =>
              join
                .onRef('trip_asset.albumId', '=', 'album_asset.albumId')
                .onRef('trip_asset.assetId', '=', 'album_asset.assetId'),
            )
            .select('asset.id')
            .whereRef('album_asset.albumId', '=', 'trip.albumId')
            .where('asset.deletedAt', 'is', null)
            .where('asset_job_status.metadataExtractedAt', 'is not', null)
            .where((eb) =>
              eb.or([
                eb('trip_asset.assetId', 'is', null),
                eb.and([
                  eb('trip_asset.localDateTime', 'is not', null),
                  sql<boolean>`"trip_asset"."localDateTime" IS DISTINCT FROM "asset"."localDateTime"`,
                ]),
              ]),
            ),
        ),
      )
      .execute();
    return rows.map(({ albumId }) => albumId);
  }

  /**
   * Files the album assets the trip has not seen yet into its stops (trips PLAN D12): an asset outside the trash whose
   * metadata is extracted and that has no `trip_asset` row. Every one gets a row, Unplaced when it fits no stop. The
   * trip row is held throughout, so filing queues up behind edits.
   */
  @GenerateSql({ params: [DummyValue.UUID] })
  fileNewAssets(albumId: string): Promise<TripFileResult> {
    return this.db.transaction().execute(async (trx) => {
      const trip = await lockTrip(trx, albumId);
      if (!trip) {
        return { assets: 0, stops: 0 };
      }
      const { assets, stops } = await fileTripAssets(trx, albumId, trip.kind, { isUnplacedRefiled: false });
      if (assets > 0) {
        await bumpContentVersion(trx, albumId);
      }
      return { assets, stops };
    });
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

  /** Whether the trip has legs waiting for their line. */
  @GenerateSql({ params: [DummyValue.UUID] })
  async hasPendingLegs(albumId: string): Promise<boolean> {
    const row = await this.db
      .selectFrom('trip_leg')
      .select('id')
      .where('albumId', '=', asUuid(albumId))
      .where('status', '=', TripLegStatus.Pending)
      .where('mode', '!=', TripLegMode.Trail)
      .executeTakeFirst();
    return !!row;
  }

  /**
   * The legs the routing job builds, in trip order: pending, not a trail, both stops with a point, in a trip outside
   * the trash. Each row is also what the job's write compares against (`writeRoutedLegs`).
   */
  @GenerateSql({ params: [DummyValue.UUID] })
  getRoutingLegs(albumId: string) {
    return this.db
      .selectFrom('trip_leg')
      .innerJoin('album', 'album.id', 'trip_leg.albumId')
      .innerJoin('trip_stop as from_stop', 'from_stop.id', 'trip_leg.fromStopId')
      .innerJoin('trip_stop as to_stop', 'to_stop.id', 'trip_leg.toStopId')
      .select([
        'trip_leg.id',
        'trip_leg.mode',
        'trip_leg.isModeManual',
        ...stationColumns.map((column) => `trip_leg.${column}` as const),
        'from_stop.latitude as fromLatitude',
        'from_stop.longitude as fromLongitude',
        'to_stop.latitude as toLatitude',
        'to_stop.longitude as toLongitude',
      ])
      .where('trip_leg.albumId', '=', asUuid(albumId))
      .where('album.deletedAt', 'is', null)
      .where('trip_leg.status', '=', TripLegStatus.Pending)
      .where('trip_leg.mode', '!=', TripLegMode.Trail)
      .where('from_stop.latitude', 'is not', null)
      .where('from_stop.longitude', 'is not', null)
      .where('to_stop.latitude', 'is not', null)
      .where('to_stop.longitude', 'is not', null)
      .orderBy(stopOrder('from_stop'))
      .orderBy('trip_leg.id')
      .execute();
  }

  /**
   * Writes the lines the routing job built, each only if its leg is as the job read it: still pending, with the same
   * mode, choice of mode and stations, and both stops still at the points the line was built for. A leg the owner
   * changed meanwhile stays pending for the job that change queued. Bumps `contentVersion` when a leg was written, and
   * returns how many were.
   */
  @GenerateSql({ params: [DummyValue.UUID, []] })
  writeRoutedLegs(albumId: string, legs: Array<{ read: RoutingLegRow; built: BuiltLeg }>): Promise<number> {
    return this.db.transaction().execute(async (trx) => {
      if (!(await lockTrip(trx, albumId))) {
        return 0;
      }
      let written = 0;
      for (const { read, built } of legs) {
        const result = await trx
          .updateTable('trip_leg')
          .set({
            mode: built.mode,
            status: built.status,
            polyline: built.polyline,
            distance: built.distance,
            duration: built.duration,
            ...(built.departure && stationValues(TripStationSide.Departure, built.departure)),
            ...(built.arrival && stationValues(TripStationSide.Arrival, built.arrival)),
          })
          .where('trip_leg.id', '=', read.id)
          .where('trip_leg.albumId', '=', asUuid(albumId))
          .where('trip_leg.status', '=', TripLegStatus.Pending)
          .where('trip_leg.mode', '=', read.mode)
          .where('trip_leg.isModeManual', '=', read.isModeManual)
          .where((eb) =>
            eb.and([
              ...stationColumns.map((column) => eb(`trip_leg.${column}`, 'is not distinct from', read[column])),
              eb.exists(
                eb
                  .selectFrom('trip_stop')
                  .select('trip_stop.id')
                  .whereRef('trip_stop.id', '=', 'trip_leg.fromStopId')
                  .where('trip_stop.latitude', '=', read.fromLatitude)
                  .where('trip_stop.longitude', '=', read.fromLongitude),
              ),
              eb.exists(
                eb
                  .selectFrom('trip_stop')
                  .select('trip_stop.id')
                  .whereRef('trip_stop.id', '=', 'trip_leg.toStopId')
                  .where('trip_stop.latitude', '=', read.toLatitude)
                  .where('trip_stop.longitude', '=', read.toLongitude),
              ),
            ]),
          )
          .executeTakeFirst();
        written += Number(result.numUpdatedRows);
      }
      if (written > 0) {
        await bumpContentVersion(trx, albumId);
      }
      return written;
    });
  }

  /** A leg of this trip with its mode and both stops' points; nothing when the leg belongs to another trip. */
  @GenerateSql({ params: [DummyValue.UUID, DummyValue.UUID] })
  getLegEnds(albumId: string, legId: string) {
    return this.db
      .selectFrom('trip_leg')
      .innerJoin('trip_stop as from_stop', 'from_stop.id', 'trip_leg.fromStopId')
      .innerJoin('trip_stop as to_stop', 'to_stop.id', 'trip_leg.toStopId')
      .select([
        'trip_leg.mode',
        'from_stop.latitude as fromLatitude',
        'from_stop.longitude as fromLongitude',
        'to_stop.latitude as toLatitude',
        'to_stop.longitude as toLongitude',
      ])
      .where('trip_leg.albumId', '=', asUuid(albumId))
      .where('trip_leg.id', '=', asUuid(legId))
      .executeTakeFirst();
  }

  /** The trip's kind, language and stops with a point, in trip order, for naming; nothing for a trip in the trash. */
  @GenerateSql({ params: [DummyValue.UUID] })
  async getStopsToName(albumId: string) {
    const id = asUuid(albumId);
    const trip = await this.db
      .selectFrom('trip')
      .innerJoin('album', 'album.id', 'trip.albumId')
      .select(['trip.kind', 'trip.language'])
      .where('trip.albumId', '=', id)
      .where('album.deletedAt', 'is', null)
      .executeTakeFirst();
    if (!trip) {
      return;
    }
    const stops = await this.db
      .selectFrom('trip_stop')
      .select([
        'trip_stop.id',
        'trip_stop.role',
        'trip_stop.isFinishAtStart',
        'trip_stop.latitude',
        'trip_stop.longitude',
        'trip_stop.title',
        'trip_stop.titleSource',
        'trip_stop.region',
        'trip_stop.country',
      ])
      .where('trip_stop.albumId', '=', id)
      .where('trip_stop.latitude', 'is not', null)
      .where('trip_stop.longitude', 'is not', null)
      .orderBy(stopOrder('trip_stop'))
      .$narrowType<{ latitude: NotNull; longitude: NotNull }>()
      .execute();
    return { ...trip, stops };
  }

  /**
   * Writes the names Nominatim gave (trips PLAN D13), each only if its stop still has no title, and the point and the
   * title source it was read with: a stop someone named or moved meanwhile keeps what they did. Bumps `contentVersion`
   * when a stop was named. Returns how many were.
   */
  @GenerateSql({
    params: [
      DummyValue.UUID,
      [
        {
          id: DummyValue.UUID,
          latitude: 54.68,
          longitude: 25.28,
          titleSource: null,
          title: DummyValue.STRING,
          region: DummyValue.STRING,
          country: DummyValue.STRING,
        },
      ],
    ],
  })
  nameStops(albumId: string, names: TripStopName[]): Promise<number> {
    const id = asUuid(albumId);
    return this.db.transaction().execute(async (trx) => {
      if (!(await lockTrip(trx, albumId))) {
        return 0;
      }
      let named = 0;
      for (const name of names) {
        const { numUpdatedRows } = await trx
          .updateTable('trip_stop')
          .set({
            title: name.title,
            titleSource: TRIP_TITLE_SOURCE_GEOCODED,
            region: name.region,
            country: name.country,
          })
          .where('id', '=', asUuid(name.id))
          .where('albumId', '=', id)
          .where(sql`coalesce(btrim("title"), '')`, '=', '')
          .where('titleSource', 'is not distinct from', name.titleSource)
          .where('latitude', '=', name.latitude)
          .where('longitude', '=', name.longitude)
          .executeTakeFirst();
        named += Number(numUpdatedRows);
      }
      if (named > 0) {
        await bumpContentVersion(trx, albumId);
      }
      return named;
    });
  }

  /** Trips with a map, outside the trash, with a stop that has a point and no title: naming's nightly retry. */
  @GenerateSql()
  async getAlbumIdsToName(): Promise<string[]> {
    const rows = await this.db
      .selectFrom('trip')
      .innerJoin('album', 'album.id', 'trip.albumId')
      .select('trip.albumId')
      .where('album.deletedAt', 'is', null)
      .where('trip.kind', '!=', TripKind.Plain)
      .where((eb) =>
        eb.exists(
          eb
            .selectFrom('trip_stop')
            .select('trip_stop.id')
            .whereRef('trip_stop.albumId', '=', 'trip.albumId')
            .where('trip_stop.latitude', 'is not', null)
            .where('trip_stop.longitude', 'is not', null)
            .where(sql`coalesce(btrim("trip_stop"."title"), '')`, '=', ''),
        ),
      )
      .execute();
    return rows.map(({ albumId }) => albumId);
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

const stationColumns = [
  'departureName',
  'departureLatitude',
  'departureLongitude',
  'arrivalName',
  'arrivalLatitude',
  'arrivalLongitude',
] as const;

export type RoutingLegRow = Awaited<ReturnType<TripRepository['getRoutingLegs']>>[number];

export const stationValues = (side: TripStationSide, { name, latitude, longitude }: Station) =>
  side === TripStationSide.Departure
    ? { departureName: name, departureLatitude: latitude, departureLongitude: longitude }
    : { arrivalName: name, arrivalLatitude: latitude, arrivalLongitude: longitude };

// A leg waiting for its line: what the routing job builds.
export const unbuilt = { status: TripLegStatus.Pending, polyline: null, distance: null, duration: null };
export const noStations = Object.fromEntries(stationColumns.map((column) => [column, null])) as Record<
  (typeof stationColumns)[number],
  null
>;

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

/**
 * Files the album assets the trip has not seen yet into its stops (`fileAssets`), and with `isUnplacedRefiled` the
 * Unplaced ones too, as travel-album's `assign` after a new start: an asset outside the trash whose metadata is
 * extracted. Every one gets a row, Unplaced when it fits no stop. The caller holds the trip row. Returns how many
 * assets were filed, how many stops were opened, and every stop that grew or opened.
 */
export const fileTripAssets = async (
  trx: Transaction<DB>,
  albumId: string,
  kind: TripKind,
  { isUnplacedRefiled }: { isUnplacedRefiled: boolean },
): Promise<TripFileResult & { stopIds: string[] }> => {
  const id = asUuid(albumId);
  const assets = await trx
    .selectFrom('album_asset')
    .innerJoin('asset', 'asset.id', 'album_asset.assetId')
    .leftJoin('asset_exif', 'asset_exif.assetId', 'asset.id')
    .leftJoin('asset_job_status', 'asset_job_status.assetId', 'asset.id')
    .leftJoin('trip_asset', (join) =>
      join.onRef('trip_asset.albumId', '=', 'album_asset.albumId').onRef('trip_asset.assetId', '=', 'asset.id'),
    )
    .select([
      'asset.id',
      'asset.localDateTime as time',
      'asset_exif.latitude',
      'asset_exif.longitude',
      'trip_asset.pointSource',
      'trip_asset.latitude as pointLatitude',
      'trip_asset.longitude as pointLongitude',
      (isUnplacedRefiled
        ? sql<boolean>`"trip_asset"."stopId" IS NULL`
        : sql<boolean>`"trip_asset"."assetId" IS NULL`
      ).as('isNew'),
    ])
    .where('album_asset.albumId', '=', id)
    .where('asset.deletedAt', 'is', null)
    // An asset whose metadata is not extracted yet has no time or GPS to file by; extraction queues filing again.
    .where((eb) =>
      eb.or([eb('trip_asset.assetId', 'is not', null), eb('asset_job_status.metadataExtractedAt', 'is not', null)]),
    )
    .orderBy('asset.localDateTime')
    .orderBy('asset.id')
    .execute();
  if (assets.every(({ isNew }) => !isNew)) {
    return { assets: 0, stops: 0, stopIds: [] };
  }
  const stops = await trx
    .selectFrom('trip_stop')
    .select([
      'trip_stop.id',
      'trip_stop.role',
      'trip_stop.latitude',
      'trip_stop.longitude',
      'trip_stop.localStart as start',
      'trip_stop.localEnd as end',
      'trip_stop.isPositionManual',
      'trip_stop.isAddedByHand',
      'trip_stop.isAtCenter',
      (eb) =>
        eb
          .selectFrom('trip_asset')
          .select(sql<number>`count(*)::int`.as('count'))
          .whereRef('trip_asset.stopId', '=', 'trip_stop.id')
          .as('count'),
    ])
    .where('trip_stop.albumId', '=', id)
    .execute();

  const borrowed = await getOtherTripPoints(trx, albumId, kind, assets);
  const start = stops.find(({ role }) => role === TripStopRole.Start);
  const filing = fileAssets(
    kind,
    stops
      .filter(({ role, isAddedByHand, isAtCenter }) => role === null && !isAddedByHand && !isAtCenter)
      .map((stop) => ({ ...stop, count: stop.count ?? 0 })),
    assets.map((asset) => ({
      id: asset.id,
      time: asset.time,
      anchor:
        asset.pointSource === TripPointSource.Manual
          ? pointOf({ latitude: asset.pointLatitude, longitude: asset.pointLongitude })
          : (pointOf(asset) ?? borrowed.get(asset.id) ?? null),
      isNew: asset.isNew,
    })),
    { start: start ? pointOf(start) : null, newId: () => randomUUID() },
  );

  const created = filing.stops.filter(({ isNew }) => isNew);
  if (created.length > 0) {
    await trx
      .insertInto('trip_stop')
      .values(
        created.map(({ id, latitude, longitude, start, end }) => ({
          id,
          albumId,
          latitude,
          longitude,
          localStart: start,
          localEnd: end,
        })),
      )
      .execute();
  }
  for (const { id, isNew, latitude, longitude, start, end } of filing.stops) {
    if (isNew) {
      continue;
    }
    await trx
      .updateTable('trip_stop')
      .set({ latitude, longitude, localStart: start, localEnd: end })
      .where('id', '=', id)
      .execute();
  }
  await trx
    .insertInto('trip_asset')
    .values(
      filing.assets.map(({ assetId, stopId, point: inferred }) => {
        // A borrowed point anchors the asset like GPS, but it is the trip's own, so it is kept as inferred.
        const point = inferred ?? borrowed.get(assetId) ?? null;
        return {
          albumId,
          assetId,
          stopId,
          latitude: point?.latitude ?? null,
          longitude: point?.longitude ?? null,
          pointSource: point && TripPointSource.Inferred,
        };
      }),
    )
    // An Unplaced asset filed again keeps its point, which the caller has inferred already.
    .onConflict((oc) => oc.columns(['albumId', 'assetId']).doUpdateSet((eb) => ({ stopId: eb.ref('excluded.stopId') })))
    .execute();
  await recordLocalTimes(trx, albumId);

  if (kind === TripKind.Route && created.length > 0) {
    await syncRouteLegs(trx, albumId);
  }
  return { assets: filing.assets.length, stops: created.length, stopIds: filing.stops.map((stop) => stop.id) };
};

/**
 * For a Favorites trip, the point of each new asset without GPS: the centre of its stop in another trip of the same
 * owner, the oldest album first (travel-album `favorites._coords`: an inferred point is not GPS, and its stop stands
 * there anyway). A start, a finish and Unplaced do not count. Any other trip borrows nothing.
 */
const getOtherTripPoints = async (
  trx: Transaction<DB>,
  albumId: string,
  kind: TripKind,
  assets: Array<{ id: string; isNew: boolean; latitude: number | null; longitude: number | null }>,
): Promise<Map<string, LatLng>> => {
  const assetIds = assets.filter((asset) => asset.isNew && !pointOf(asset)).map(({ id }) => id);
  if (kind !== TripKind.Places || assetIds.length === 0 || !(await isFavoritesTrip(trx, albumId))) {
    return new Map();
  }
  const rows = await trx
    .selectFrom('trip_asset')
    .innerJoin('trip_stop', 'trip_stop.id', 'trip_asset.stopId')
    .innerJoin('album', 'album.id', 'trip_asset.albumId')
    .innerJoin('album_user as other_owner', (join) =>
      join.onRef('other_owner.albumId', '=', 'album.id').on('other_owner.role', '=', sql.lit(AlbumUserRole.Owner)),
    )
    .innerJoin('album_user as owner', (join) =>
      join
        .onRef('owner.userId', '=', 'other_owner.userId')
        .on('owner.albumId', '=', asUuid(albumId))
        .on('owner.role', '=', sql.lit(AlbumUserRole.Owner)),
    )
    .distinctOn('trip_asset.assetId')
    .select(['trip_asset.assetId', 'trip_stop.latitude', 'trip_stop.longitude'])
    .where('trip_asset.assetId', 'in', assetIds)
    .where('trip_asset.albumId', '!=', asUuid(albumId))
    .where('trip_stop.role', 'is', null)
    .where('trip_stop.latitude', 'is not', null)
    .where('trip_stop.longitude', 'is not', null)
    .where('album.deletedAt', 'is', null)
    .orderBy('trip_asset.assetId')
    .orderBy('album.createdAt')
    .execute();
  const points = new Map<string, LatLng>();
  for (const { assetId, ...point } of rows) {
    const latLng = pointOf(point);
    if (latLng) {
      points.set(assetId, latLng);
    }
  }
  return points;
};

/**
 * Legs between consecutive stops of a route in trip order (`syncLegs`): legs between stops that are no longer
 * neighbours go, a new pair is pending.
 */
export const syncRouteLegs = async (trx: Transaction<DB>, albumId: string) => {
  const id = asUuid(albumId);
  const [ordered, legs] = await Promise.all([
    trx
      .selectFrom('trip_stop')
      .select(['id', 'latitude', 'longitude', 'isTransit'])
      .where('albumId', '=', id)
      .orderBy(stopOrder('trip_stop'))
      .execute(),
    trx
      .selectFrom('trip_leg')
      .select(['id', 'fromStopId', 'toStopId', 'mode', 'isModeManual'])
      .where('albumId', '=', id)
      .execute(),
  ]);
  const { removedIds, added } = syncLegs(ordered, legs);
  if (removedIds.length > 0) {
    await trx.deleteFrom('trip_leg').where('id', 'in', removedIds).execute();
  }
  if (added.length > 0) {
    await trx
      .insertInto('trip_leg')
      .values(added.map((leg) => ({ ...leg, albumId })))
      .execute();
  }
};

const isFavoritesTrip = async (trx: Transaction<DB>, albumId: string) => {
  const row = await trx
    .selectFrom('trip')
    .select('isFavorites')
    .where('albumId', '=', asUuid(albumId))
    .executeTakeFirst();
  return !!row?.isFavorites;
};

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
