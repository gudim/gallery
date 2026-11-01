import { Injectable } from '@nestjs/common';
import { Kysely, NotNull, Transaction } from 'kysely';
import { InjectKysely } from 'nestjs-kysely';
import type { BuiltLeg } from 'src/trips/utils/route-leg.js';
import type { Station } from 'src/trips/utils/routing.js';
import { DummyValue, GenerateSql } from 'src/decorators.js';
import { DB } from 'src/schema/index.js';
import { TripLegMode, TripLegStatus, TripStationSide } from 'src/trips/enum.js';
import { bumpContentVersion, lockTrip, stopOrder } from 'src/trips/repositories/trip.repository.js';
import { syncLegs } from 'src/trips/utils/filing.js';
import { asUuid } from 'src/utils/database.js';

// The legs of a route and their lines (trips PLAN §2.5, travel-album `route_legs`).
@Injectable()
export class TripRouteRepository {
  constructor(@InjectKysely() private db: Kysely<DB>) {}

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
      .$narrowType<{ fromLatitude: NotNull; fromLongitude: NotNull; toLatitude: NotNull; toLongitude: NotNull }>()
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
}

const stationColumns = [
  'departureName',
  'departureLatitude',
  'departureLongitude',
  'arrivalName',
  'arrivalLatitude',
  'arrivalLongitude',
] as const;

export type RoutingLegRow = Awaited<ReturnType<TripRouteRepository['getRoutingLegs']>>[number];

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
