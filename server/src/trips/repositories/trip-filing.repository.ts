import { Injectable } from '@nestjs/common';
import { Kysely, Transaction, sql } from 'kysely';
import { InjectKysely } from 'nestjs-kysely';
import { randomUUID } from 'node:crypto';
import { DummyValue, GenerateSql } from 'src/decorators.js';
import { AlbumUserRole } from 'src/enum.js';
import { DB } from 'src/schema/index.js';
import { TripKind, TripPointSource, TripStopRole } from 'src/trips/enum.js';
import { syncRouteLegs } from 'src/trips/repositories/trip-route.repository.js';
import { bumpContentVersion, lockTrip, recordLocalTimes } from 'src/trips/repositories/trip.repository.js';
import { fileAssets } from 'src/trips/utils/filing.js';
import { type LatLng, pointOf } from 'src/trips/utils/geo.js';
import { asUuid } from 'src/utils/database.js';

/** What filing did: how many assets it filed, and how many stops it opened for them. */
export type TripFileResult = { assets: number; stops: number };

// Files album assets into the trip's stops (trips PLAN D12).
@Injectable()
export class TripFilingRepository {
  constructor(@InjectKysely() private db: Kysely<DB>) {}

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
}

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

const isFavoritesTrip = async (trx: Transaction<DB>, albumId: string) => {
  const row = await trx
    .selectFrom('trip')
    .select('isFavorites')
    .where('albumId', '=', asUuid(albumId))
    .executeTakeFirst();
  return !!row?.isFavorites;
};
