import { Injectable } from '@nestjs/common';
import { Kysely, Transaction, sql } from 'kysely';
import { InjectKysely } from 'nestjs-kysely';
import { randomUUID } from 'node:crypto';
import type { Station } from 'src/trips/utils/routing.js';
import { DummyValue, GenerateSql } from 'src/decorators.js';
import { DB } from 'src/schema/index.js';
import {
  TripKind,
  TripLegMode,
  TripLegStatus,
  TripPointSource,
  TripStationSide,
  TripStopRole,
} from 'src/trips/enum.js';
import {
  TripEditResult,
  bumpContentVersion,
  fileTripAssets,
  lockTrip,
  noStations,
  recordLocalTimes,
  stationValues,
  stopOrder,
  syncRouteLegs,
  unbuilt,
} from 'src/trips/repositories/trip.repository.js';
import { placeAfter, transitSpans } from 'src/trips/utils/editor.js';
import { type LatLng, defaultMode, haversineM, pointOf } from 'src/trips/utils/geo.js';
import { inferPoints, speedKmh } from 'src/trips/utils/grouping.js';
import { asUuid } from 'src/utils/database.js';

// The stop and leg editor (trips PLAN §2.5, travel-album `atlas/albums/editor.py`). Every id an edit takes must belong to the
// trip it edits: there are no composite keys to check it (trips DECISIONS-LOG 2026-10-31).

/** A point the owner picked, with its name; without one, naming gives it. */
export type TripPoint = LatLng & { title: string | null };

// travel-album `transit.FLIGHT_KMH`: a transit leg faster than this becomes a flight.
const FLIGHT_KMH = 300;

export type TripStopChanges = {
  title?: string | null;
  story?: string | null;
  placeId?: string | null;
  latitude?: number;
  longitude?: number;
  isPositionManual?: false;
};

/** What an edit did, and the jobs it leaves work for: routing pending legs, naming untitled stops. */
export type TripEdited = { result: TripEditResult; needsRouting: boolean; needsNaming: boolean };

// `touch` names the stops whose assets changed, whose times and centre follow them.
type Edit = (
  trx: Transaction<DB>,
  kind: TripKind,
  touch: (...stopIds: string[]) => void,
) => Promise<TripEditResult | void>;

// A stop that moved less than this kept its legs: the centre is a mean, and float rounding is not a move.
const MOVED_M = 1;

@Injectable()
export class TripEditorRepository {
  constructor(@InjectKysely() private db: Kysely<DB>) {}

  /**
   * Sets a stop's texts, place and pin. A text set by hand is `manual`, a cleared one has no source; a finish that is
   * the same place as the start takes the start's title (travel-album decision P20). A pin the owner moves stays where
   * they put it; `isPositionManual: false` gives it back to the mean of its assets. The start and finish move through
   * their own edits, and a stop added by hand has no assets to follow.
   */
  @GenerateSql({ params: [DummyValue.UUID, DummyValue.UUID, { title: DummyValue.STRING }] })
  updateStop(albumId: string, stopId: string, changes: TripStopChanges): Promise<TripEdited> {
    const { title, story, placeId, latitude, longitude, isPositionManual } = changes;
    return this.edit(albumId, async (trx, kind, touch) => {
      const stop = await getStop(trx, albumId, stopId);
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
      const isPinMoved = latitude !== undefined && longitude !== undefined;
      if ((isPinMoved || isPositionManual === false) && stop.role) {
        return TripEditResult.StopIsEnd;
      }
      if (isPinMoved && kind === TripKind.Plain) {
        return TripEditResult.NoMap;
      }
      if (isPositionManual === false && stop.isAddedByHand) {
        return TripEditResult.StopIsPoint;
      }
      await trx
        .updateTable('trip_stop')
        .set({
          ...(title !== undefined && { title, titleSource: title && 'manual' }),
          ...(story !== undefined && { story, storySource: story && 'manual' }),
          ...(placeId !== undefined && { placeId }),
          ...(isPinMoved && { latitude, longitude, isPositionManual: true }),
          ...(isPositionManual === false && { isPositionManual }),
        })
        .where('id', '=', asUuid(stopId))
        .execute();
      if (isPositionManual === false) {
        touch(stopId);
      }
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
   * Merges a stop into the next one in trip order (travel-album `merge_next`): the assets of the second join the
   * first, which keeps its texts and place and takes the second's where its own are empty. The legs to the second go
   * with it, and the neighbours get one leg.
   */
  @GenerateSql({ params: [DummyValue.UUID, DummyValue.UUID] })
  mergeNext(albumId: string, stopId: string): Promise<TripEdited> {
    return this.edit(albumId, async (trx, _kind, touch) => {
      const order = await trx
        .selectFrom('trip_stop')
        .selectAll()
        .where('albumId', '=', asUuid(albumId))
        .orderBy(stopOrder('trip_stop'))
        .execute();
      const index = order.findIndex(({ id }) => id === stopId);
      if (index === -1) {
        return TripEditResult.StopMissing;
      }
      const [first, second] = [order[index], order[index + 1]];
      if (!second) {
        return TripEditResult.MergeLast;
      }
      if (first.role || second.role) {
        return TripEditResult.StopIsEnd;
      }
      if (first.isAddedByHand || second.isAddedByHand) {
        return TripEditResult.StopIsPoint;
      }
      await trx
        .updateTable('trip_stop')
        .set({
          ...(!first.title && second.title && { title: second.title, titleSource: second.titleSource }),
          ...(!first.story && second.story && { story: second.story, storySource: second.storySource }),
          ...(first.placeId === null && second.placeId !== null && { placeId: second.placeId }),
        })
        .where('id', '=', first.id)
        .execute();
      await trx.updateTable('trip_asset').set({ stopId: first.id }).where('stopId', '=', second.id).execute();
      await trx.deleteFrom('trip_stop').where('id', '=', second.id).execute();
      touch(first.id);
    });
  }

  /**
   * Splits a stop at one of its assets (travel-album `split`): that asset and every later one, in time order, go to a
   * new stop. The first asset cannot split a stop: the stop would be left empty.
   */
  @GenerateSql({ params: [DummyValue.UUID, DummyValue.UUID, DummyValue.UUID] })
  split(albumId: string, stopId: string, assetId: string): Promise<TripEdited> {
    return this.edit(albumId, async (trx, _kind, touch) => {
      if (!(await getStop(trx, albumId, stopId))) {
        return TripEditResult.StopMissing;
      }
      const assets = await trx
        .selectFrom('trip_asset')
        .innerJoin('asset', 'asset.id', 'trip_asset.assetId')
        .select('trip_asset.assetId')
        .where('trip_asset.albumId', '=', asUuid(albumId))
        .where('trip_asset.stopId', '=', asUuid(stopId))
        .orderBy('asset.localDateTime')
        .orderBy('asset.id')
        .execute();
      const index = assets.findIndex((asset) => asset.assetId === assetId);
      if (index === -1) {
        return TripEditResult.AssetForeign;
      }
      if (index === 0) {
        return TripEditResult.SplitFirst;
      }
      // Assets in the trash go along by their time, so a restored one is where its neighbours are.
      const newStopId = randomUUID();
      await trx.insertInto('trip_stop').values({ id: newStopId, albumId }).execute();
      await trx
        .updateTable('trip_asset')
        .set({ stopId: newStopId })
        .where('albumId', '=', asUuid(albumId))
        .where(
          'assetId',
          'in',
          assets.slice(index).map((asset) => asset.assetId),
        )
        .execute();
      touch(stopId, newStopId);
    });
  }

  /** Deletes a stop without assets, such as a point added by hand (travel-album `delete_stop`); its neighbours get one leg. */
  @GenerateSql({ params: [DummyValue.UUID, DummyValue.UUID] })
  deleteStop(albumId: string, stopId: string): Promise<TripEdited> {
    return this.edit(albumId, async (trx) => {
      const stop = await getStop(trx, albumId, stopId);
      if (!stop) {
        return TripEditResult.StopMissing;
      }
      if (stop.role) {
        return TripEditResult.StopIsEnd;
      }
      // An asset in the trash still counts: restored, it is back in its stop.
      const filed = await trx
        .selectFrom('trip_asset')
        .select('assetId')
        .where('stopId', '=', asUuid(stopId))
        .executeTakeFirst();
      if (filed) {
        return TripEditResult.StopHasAssets;
      }
      await trx.deleteFrom('trip_stop').where('id', '=', asUuid(stopId)).execute();
    });
  }

  /**
   * Moves album assets into a stop of the trip (travel-album `update_media_many` with a stop). A stop the move would
   * empty is refused: that is a merge, which keeps its texts. An asset filing has not seen yet is filed here, so
   * filing leaves it where the owner put it.
   */
  @GenerateSql({ params: [DummyValue.UUID, [DummyValue.UUID], DummyValue.UUID] })
  moveAssets(albumId: string, assetIds: string[], stopId: string): Promise<TripEdited> {
    return this.edit(albumId, async (trx, _kind, touch) => {
      const target = await getStop(trx, albumId, stopId);
      if (!target) {
        return TripEditResult.StopMissing;
      }
      if (target.role) {
        return TripEditResult.StopIsEnd;
      }
      if (target.isAddedByHand) {
        return TripEditResult.StopIsPoint;
      }
      return moveAssets(trx, albumId, assetIds, stopId, touch);
    });
  }

  /**
   * A point added by hand (travel-album decision P4) right after `afterStopId`, or right after the start for null. Only
   * a route has an order of way to put it in. Without a title, naming gives it one.
   */
  @GenerateSql({ params: [DummyValue.UUID, { latitude: 54.68, longitude: 25.28, title: null }, null] })
  addPoint(albumId: string, point: TripPoint, afterStopId: string | null): Promise<TripEdited> {
    return this.editRoute(albumId, async (trx) => {
      const id = randomUUID();
      await trx
        .insertInto('trip_stop')
        .values({ id, albumId, ...pointValues(point), isAddedByHand: true, isPositionManual: true })
        .execute();
      return placePoint(trx, albumId, id, afterStopId);
    });
  }

  /**
   * Puts a point added by hand right after another stop (travel-album `move_point`). Stops of assets go by the time
   * their assets were taken (decision P20) and are not moved in the order.
   */
  @GenerateSql({ params: [DummyValue.UUID, DummyValue.UUID, null] })
  movePoint(albumId: string, stopId: string, afterStopId: string | null): Promise<TripEdited> {
    return this.edit(albumId, async (trx) => {
      const stop = await getStop(trx, albumId, stopId);
      if (!stop) {
        return TripEditResult.StopMissing;
      }
      if (stop.role || !stop.isAddedByHand) {
        return TripEditResult.StopNotPoint;
      }
      return placePoint(trx, albumId, stopId, afterStopId);
    });
  }

  /**
   * Sets, moves or removes the start of a route (travel-album `ends.set_origin`); a finish at the start follows it, and
   * goes with it. Assets without GPS of their own are placed again from it.
   */
  @GenerateSql({ params: [DummyValue.UUID, { latitude: 54.68, longitude: 25.28, title: null }] })
  setStart(albumId: string, point: TripPoint | null): Promise<TripEdited> {
    return this.editRoute(albumId, async (trx, kind, touch) => {
      await putEnd(trx, albumId, TripStopRole.Start, point);
      const finish = await getEnd(trx, albumId, TripStopRole.Finish);
      if (finish?.isFinishAtStart) {
        await putEnd(trx, albumId, TripStopRole.Finish, point, true);
      }
      // Assets without GPS lean on the start: their points move with it, and those left Unplaced for want of a point
      // are filed (travel-album `locate` and `assign`).
      await relocate(trx, albumId, kind, touch);
      const filed = await fileTripAssets(trx, albumId, { kind, isFavorites: false }, { isUnplacedRefiled: true });
      touch(...filed.stopIds);
    });
  }

  /**
   * Sets, moves or removes the finish of a route (travel-album `ends.set_finish`). A finish at the start takes the
   * start's point and title, and follows it from then on.
   */
  @GenerateSql({ params: [DummyValue.UUID, { latitude: 54.68, longitude: 25.28, title: null }, false] })
  setFinish(albumId: string, point: TripPoint | null, isFinishAtStart: boolean): Promise<TripEdited> {
    return this.editRoute(albumId, async (trx) => {
      if (isFinishAtStart) {
        const start = await getEnd(trx, albumId, TripStopRole.Start);
        if (!start) {
          return TripEditResult.NoStart;
        }
        point = { latitude: start.latitude!, longitude: start.longitude!, title: start.title };
      }
      await putEnd(trx, albumId, TripStopRole.Finish, point, isFinishAtStart);
    });
  }

  /**
   * Marks stops as shot on the way (true), not (false: the suggestion is not made again) or undecided (null), as
   * travel-album's `set_transit`. A transit stop lies on the leg between the real stops around it. That leg becomes a
   * flight unless the owner set its mode, when one of the legs it replaces was a flight or the way between its ends
   * was faster than a plane flies low.
   */
  @GenerateSql({ params: [DummyValue.UUID, [DummyValue.UUID], true] })
  setTransit(albumId: string, stopIds: string[], isTransit: boolean | null): Promise<TripEdited> {
    return this.editRoute(albumId, async (trx) => {
      const ids = [...new Set(stopIds)];
      const stops = await trx
        .selectFrom('trip_stop')
        .select(['id', 'role', 'isAddedByHand'])
        .where('albumId', '=', asUuid(albumId))
        .where('id', 'in', ids)
        .execute();
      if (stops.length !== ids.length) {
        return TripEditResult.StopMissing;
      }
      if (stops.some(({ role }) => role)) {
        return TripEditResult.StopIsEnd;
      }
      if (stops.some(({ isAddedByHand }) => isAddedByHand)) {
        return TripEditResult.StopIsPoint;
      }
      const flight = await trx
        .selectFrom('trip_leg')
        .select('id')
        .where('albumId', '=', asUuid(albumId))
        .where('mode', '=', TripLegMode.Flight)
        .where((eb) => eb.or([eb('fromStopId', 'in', ids), eb('toStopId', 'in', ids)]))
        .executeTakeFirst();
      await trx.updateTable('trip_stop').set({ isTransit }).where('id', 'in', ids).execute();
      if (!isTransit) {
        return;
      }
      await syncRouteLegs(trx, albumId);
      const order = await trx
        .selectFrom('trip_stop')
        .select([
          'id',
          'role',
          'isAddedByHand',
          'isTransit',
          'localStart as start',
          'localEnd as end',
          'latitude',
          'longitude',
        ])
        .where('albumId', '=', asUuid(albumId))
        .orderBy(stopOrder('trip_stop'))
        .execute();
      const byId = new Map(order.map((stop) => [stop.id, stop]));
      const spans = transitSpans(order);
      const legs = new Map(ids.flatMap((id) => (spans.has(id) ? [[spans.get(id)!.join(','), spans.get(id)!]] : [])));
      for (const [from, to] of legs.values()) {
        const kmh = speedKmh(byId.get(from)!, byId.get(to)!);
        if (flight || (kmh !== null && kmh >= FLIGHT_KMH)) {
          await trx
            .updateTable('trip_leg')
            .set({ mode: TripLegMode.Flight, isModeManual: true, ...unbuilt, ...noStations })
            .where('fromStopId', '=', from)
            .where('toStopId', '=', to)
            .where('isModeManual', '=', false)
            .execute();
        }
      }
    });
  }

  /**
   * A new stop of the chosen assets (travel-album `new_stop`): a split for any set of assets. It takes its place in
   * the trip by their times; a stop the move would empty is refused, as for a move.
   */
  @GenerateSql({ params: [DummyValue.UUID, [DummyValue.UUID]] })
  newStop(albumId: string, assetIds: string[]): Promise<TripEdited> {
    return this.edit(albumId, async (trx, _kind, touch) => {
      const stopId = randomUUID();
      await trx.insertInto('trip_stop').values({ id: stopId, albumId }).execute();
      return moveAssets(trx, albumId, assetIds, stopId, touch);
    });
  }

  /**
   * Sets the owner's point of an asset in the trip, or removes it for null (travel-album `update_media` with a point).
   * The point stays in the trip, never in the asset (trips PLAN D10). The other assets without GPS are placed again
   * around it, and the centres of their stops follow.
   */
  @GenerateSql({ params: [DummyValue.UUID, DummyValue.UUID, { latitude: 54.68, longitude: 25.28 }] })
  setAssetPoint(albumId: string, assetId: string, point: LatLng | null): Promise<TripEdited> {
    return this.edit(albumId, async (trx, kind, touch) => {
      const asset = await trx
        .selectFrom('trip_asset')
        .innerJoin('asset', 'asset.id', 'trip_asset.assetId')
        .select('trip_asset.stopId')
        .where('trip_asset.albumId', '=', asUuid(albumId))
        .where('trip_asset.assetId', '=', asUuid(assetId))
        .where('asset.deletedAt', 'is', null)
        .executeTakeFirst();
      if (!asset) {
        return TripEditResult.AssetMissing;
      }
      if (kind === TripKind.Plain) {
        return TripEditResult.NoMap;
      }
      await trx
        .updateTable('trip_asset')
        .set({
          latitude: point?.latitude ?? null,
          longitude: point?.longitude ?? null,
          pointSource: point && TripPointSource.Manual,
        })
        .where('albumId', '=', asUuid(albumId))
        .where('assetId', '=', asUuid(assetId))
        .execute();
      if (asset.stopId) {
        touch(asset.stopId);
      }
      await relocate(trx, albumId, kind, touch);
    });
  }

  /**
   * Files Unplaced assets of a Places trip to its centre (travel-album `to_center`): into the stop "<centre>, no exact
   * place", which the first call makes at `centre` with a pin by hand (trips DECISIONS-LOG 2026-10-31, owner); later
   * calls file into it and leave out `centre`.
   */
  @GenerateSql({ params: [DummyValue.UUID, [DummyValue.UUID], null] })
  toCenter(albumId: string, assetIds: string[], centre: TripPoint | null): Promise<TripEdited> {
    return this.edit(albumId, async (trx, kind, touch) => {
      if (kind !== TripKind.Places) {
        return TripEditResult.NotPlaces;
      }
      const ids = [...new Set(assetIds)];
      const assets = await trx
        .selectFrom('trip_asset')
        .innerJoin('asset', 'asset.id', 'trip_asset.assetId')
        .select(['trip_asset.assetId', 'trip_asset.stopId'])
        .where('trip_asset.albumId', '=', asUuid(albumId))
        .where('trip_asset.assetId', 'in', ids)
        .where('asset.deletedAt', 'is', null)
        .execute();
      if (assets.length !== ids.length) {
        return TripEditResult.AssetForeign;
      }
      if (assets.some(({ stopId }) => stopId !== null)) {
        return TripEditResult.AssetPlaced;
      }
      let stop = await trx
        .selectFrom('trip_stop')
        .select('id')
        .where('albumId', '=', asUuid(albumId))
        .where('isAtCenter', '=', true)
        .executeTakeFirst();
      if (!stop) {
        if (!centre) {
          return TripEditResult.NoCenter;
        }
        stop = { id: randomUUID() };
        await trx
          .insertInto('trip_stop')
          .values({ id: stop.id, albumId, ...pointValues(centre), isAtCenter: true, isPositionManual: true })
          .execute();
      }
      await trx
        .updateTable('trip_asset')
        .set({ stopId: stop.id })
        .where('albumId', '=', asUuid(albumId))
        .where('assetId', 'in', ids)
        .execute();
      touch(stop.id);
    });
  }

  /**
   * Follows the assets whose local time changed since the trip placed them, by the clock-offset wizard or any date
   * edit (trips PLAN D9, travel-album `reclock.set_offset`): their new times are recorded, the points of assets
   * without GPS are inferred again, and their stops' times and centres follow, with a route's legs. Stops are not
   * laid out again. `Unchanged` when no time changed, and then nothing is written.
   */
  @GenerateSql({ params: [DummyValue.UUID] })
  retime(albumId: string): Promise<TripEdited> {
    return this.edit(albumId, async (trx, kind, touch) => {
      const id = asUuid(albumId);
      const changed = await trx
        .selectFrom('trip_asset')
        .innerJoin('asset', 'asset.id', 'trip_asset.assetId')
        .select(['trip_asset.assetId', 'trip_asset.stopId'])
        .where('trip_asset.albumId', '=', id)
        .where('trip_asset.localDateTime', 'is not', null)
        .where(sql<boolean>`"trip_asset"."localDateTime" IS DISTINCT FROM "asset"."localDateTime"`)
        .execute();
      if (changed.length === 0) {
        return TripEditResult.Unchanged;
      }
      await sql`
        UPDATE "trip_asset" SET "localDateTime" = "asset"."localDateTime"
        FROM "asset"
        WHERE "asset"."id" = "trip_asset"."assetId" AND "trip_asset"."albumId" = ${id}
          AND "trip_asset"."assetId" IN (${sql.join(changed.map(({ assetId }) => assetId))})
      `.execute(trx);
      touch(...changed.flatMap(({ stopId }) => (stopId ? [stopId] : [])));
      await relocate(trx, albumId, kind, touch);
    });
  }

  /**
   * Runs one stop edit in a transaction that holds the trip row, then does what travel-album's `editor.edited` did:
   * the times and centres of the stops it touched follow their assets, a route's legs follow its stop order, legs of
   * a stop that moved are built again without their stations, and `contentVersion` goes up. A refused edit is rolled
   * back. Stops it did not touch keep their times and centres: an imported trip's may differ from what its assets
   * give, and a text edit must not move them.
   */
  /**
   * The owner's mode for a leg (travel-album `set_leg_mode`): kept by every later build and by filing. `null` gives the
   * leg back to the default by distance. Either way the leg is built again from scratch, its stations forgotten.
   */
  @GenerateSql({ params: [DummyValue.UUID, DummyValue.UUID, TripLegMode.Train] })
  setLegMode(albumId: string, legId: string, mode: TripLegMode | null): Promise<TripEditResult> {
    return editTrip(this.db, albumId, async (trx) => {
      const leg = await trx
        .selectFrom('trip_leg')
        .innerJoin('trip_stop as from_stop', 'from_stop.id', 'trip_leg.fromStopId')
        .innerJoin('trip_stop as to_stop', 'to_stop.id', 'trip_leg.toStopId')
        .select([
          'from_stop.latitude as fromLatitude',
          'from_stop.longitude as fromLongitude',
          'to_stop.latitude as toLatitude',
          'to_stop.longitude as toLongitude',
        ])
        .where('trip_leg.albumId', '=', asUuid(albumId))
        .where('trip_leg.id', '=', asUuid(legId))
        .executeTakeFirst();
      if (!leg) {
        return TripEditResult.LegMissing;
      }
      await trx
        .updateTable('trip_leg')
        .set({
          mode: mode ?? automaticMode(leg),
          isModeManual: mode !== null,
          ...unbuilt,
          ...noStations,
        })
        .where('id', '=', asUuid(legId))
        .execute();
    });
  }

  /**
   * The owner's station at one end of a train leg (travel-album `set_leg_station`); the leg is built again. The
   * caller checks that it is one of the stations offered at that end.
   */
  @GenerateSql({
    params: [
      DummyValue.UUID,
      DummyValue.UUID,
      TripStationSide.Departure,
      { name: DummyValue.STRING, latitude: 54.68, longitude: 25.28 },
    ],
  })
  setLegStation(albumId: string, legId: string, side: TripStationSide, station: Station): Promise<TripEditResult> {
    return editTrip(this.db, albumId, async (trx) => {
      const leg = await trx
        .selectFrom('trip_leg')
        .select('mode')
        .where('albumId', '=', asUuid(albumId))
        .where('id', '=', asUuid(legId))
        .executeTakeFirst();
      if (!leg) {
        return TripEditResult.LegMissing;
      }
      if (leg.mode !== TripLegMode.Train) {
        return TripEditResult.LegNotTrain;
      }
      await trx
        .updateTable('trip_leg')
        .set({ ...stationValues(side, station), ...unbuilt })
        .where('id', '=', asUuid(legId))
        .execute();
    });
  }

  /** A leg that needs attention goes back to the routing queue as it is (travel-album `retry_leg`). */
  @GenerateSql({ params: [DummyValue.UUID, DummyValue.UUID] })
  retryLeg(albumId: string, legId: string): Promise<TripEditResult> {
    return editTrip(this.db, albumId, async (trx) => {
      const leg = await trx
        .selectFrom('trip_leg')
        .select('status')
        .where('albumId', '=', asUuid(albumId))
        .where('id', '=', asUuid(legId))
        .executeTakeFirst();
      if (!leg) {
        return TripEditResult.LegMissing;
      }
      if (leg.status !== TripLegStatus.Attention) {
        return TripEditResult.LegNotAttention;
      }
      await trx.updateTable('trip_leg').set(unbuilt).where('id', '=', asUuid(legId)).execute();
    });
  }

  /** Every leg of the trip that needs attention goes back to the routing queue (travel-album `retry_legs`). */
  @GenerateSql({ params: [DummyValue.UUID] })
  retryLegs(albumId: string): Promise<TripEditResult> {
    return editTrip(this.db, albumId, async (trx) => {
      const { numUpdatedRows } = await trx
        .updateTable('trip_leg')
        .set(unbuilt)
        .where('albumId', '=', asUuid(albumId))
        .where('status', '=', TripLegStatus.Attention)
        .executeTakeFirst();
      if (numUpdatedRows === 0n) {
        return TripEditResult.NoLegsToRetry;
      }
    });
  }

  // An edit only a route has; another kind of trip refuses it.
  private editRoute(albumId: string, edit: Edit): Promise<TripEdited> {
    return this.edit(albumId, (trx, kind, touch) =>
      kind === TripKind.Route ? edit(trx, kind, touch) : Promise.resolve(TripEditResult.NotRoute),
    );
  }

  private edit(albumId: string, edit: Edit): Promise<TripEdited> {
    return this.db
      .transaction()
      .execute(async (trx) => {
        const trip = await lockTrip(trx, albumId);
        if (!trip) {
          return refused(TripEditResult.TripMissing);
        }
        const before = await positions(trx, albumId);
        const touched = new Set<string>();
        const result = await edit(trx, trip.kind, (...stopIds) => {
          for (const id of stopIds) touched.add(id);
        });
        if (result) {
          throw new Refused(result);
        }
        await refreshStops(trx, albumId, trip.kind, [...touched]);
        if (trip.kind === TripKind.Route) {
          await syncRouteLegs(trx, albumId);
        }
        const moved = movedStopIds(before, await positions(trx, albumId));
        if (moved.length > 0) {
          await trx
            .updateTable('trip_leg')
            .set({ ...unbuilt, ...noStations })
            .where('albumId', '=', asUuid(albumId))
            .where('mode', '!=', TripLegMode.Trail)
            .where((eb) => eb.or([eb('fromStopId', 'in', moved), eb('toStopId', 'in', moved)]))
            .execute();
        }
        await bumpContentVersion(trx, albumId);
        return { result: TripEditResult.Updated, ...(await pendingWork(trx, albumId, trip.kind)) };
      })
      .catch((error: unknown) => {
        if (error instanceof Refused) {
          return refused(error.result);
        }
        throw error;
      });
  }
}

const refused = (result: TripEditResult): TripEdited => ({ result, needsRouting: false, needsNaming: false });

// Thrown out of the transaction so a refused edit writes nothing.
class Refused extends Error {
  constructor(readonly result: TripEditResult) {
    super(result);
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
    const trip = await lockTrip(trx, albumId);
    if (!trip) {
      return TripEditResult.TripMissing;
    }
    const refused = await edit(trx);
    if (refused) {
      return refused;
    }
    await bumpContentVersion(trx, albumId);
    return TripEditResult.Updated;
  });

// The mode a leg without the owner's choice has until it is built: by its straight length, by car without points.
const automaticMode = (leg: Record<'fromLatitude' | 'fromLongitude' | 'toLatitude' | 'toLongitude', number | null>) => {
  const from = pointOf({ latitude: leg.fromLatitude, longitude: leg.fromLongitude });
  const to = pointOf({ latitude: leg.toLatitude, longitude: leg.toLongitude });
  return from && to ? defaultMode(haversineM(from, to)) : TripLegMode.Driving;
};

const pointValues = ({ latitude, longitude, title }: TripPoint) => ({
  latitude,
  longitude,
  title,
  titleSource: title && 'manual',
});

// Writes the point's time and the order among stops of the same time; the point's row must exist.
const placePoint = async (trx: Transaction<DB>, albumId: string, pointId: string, afterStopId: string | null) => {
  const order = await trx
    .selectFrom('trip_stop')
    .select(['id', 'role', 'localStart', 'localEnd'])
    .where('albumId', '=', asUuid(albumId))
    .where('id', '!=', asUuid(pointId))
    .orderBy(stopOrder('trip_stop'))
    .execute();
  const placement = placeAfter(order, pointId, afterStopId);
  if (placement === 'missing') {
    return TripEditResult.StopMissing;
  }
  if (placement === 'finish') {
    return TripEditResult.AfterFinish;
  }
  const { localTime, sequences } = placement;
  await trx
    .updateTable('trip_stop')
    .set({ localStart: localTime, localEnd: localTime })
    .where('id', '=', asUuid(pointId))
    .execute();
  for (const { id, sequence } of sequences) {
    await trx.updateTable('trip_stop').set({ sequence }).where('id', '=', asUuid(id)).execute();
  }
};

const getEnd = (trx: Transaction<DB>, albumId: string, role: TripStopRole) =>
  trx
    .selectFrom('trip_stop')
    .select(['id', 'latitude', 'longitude', 'title', 'isFinishAtStart'])
    .where('albumId', '=', asUuid(albumId))
    .where('role', '=', role)
    .executeTakeFirst();

// Writes a start or finish at `point`, or removes it with its legs; the legs of a moved one are routed again.
const putEnd = async (
  trx: Transaction<DB>,
  albumId: string,
  role: TripStopRole,
  point: TripPoint | null,
  isFinishAtStart = false,
) => {
  const end = await getEnd(trx, albumId, role);
  if (!point) {
    if (end) {
      await trx.deleteFrom('trip_stop').where('id', '=', end.id).execute();
    }
    return;
  }
  const values = { ...pointValues(point), isFinishAtStart, region: null, country: null };
  await (end
    ? trx.updateTable('trip_stop').set(values).where('id', '=', end.id).execute()
    : trx
        .insertInto('trip_stop')
        .values({ id: randomUUID(), albumId, role, isAddedByHand: true, ...values })
        .execute());
};

/**
 * Infers again the point of every asset of the trip without one of its own, GPS or the owner's (travel-album
 * `locate`): along the route between its neighbours in time, or at a Places trip's nearest anchor in its walk. The
 * stops of assets whose point changed are touched, so their centres follow.
 */
const relocate = async (
  trx: Transaction<DB>,
  albumId: string,
  kind: TripKind,
  touch: (...stopIds: string[]) => void,
) => {
  if (kind === TripKind.Plain) {
    return;
  }
  const id = asUuid(albumId);
  const [assets, start] = await Promise.all([
    trx
      .selectFrom('trip_asset')
      .innerJoin('asset', 'asset.id', 'trip_asset.assetId')
      .leftJoin('asset_exif', 'asset_exif.assetId', 'asset.id')
      .select([
        'trip_asset.assetId',
        'trip_asset.stopId',
        'trip_asset.latitude',
        'trip_asset.longitude',
        'trip_asset.pointSource',
        'asset.localDateTime as time',
        'asset_exif.latitude as gpsLatitude',
        'asset_exif.longitude as gpsLongitude',
      ])
      .where('trip_asset.albumId', '=', id)
      .where('asset.deletedAt', 'is', null)
      .orderBy('asset.localDateTime')
      .orderBy('asset.id')
      .execute(),
    getEnd(trx, albumId, TripStopRole.Start),
  ]);
  const shots = assets.map((asset) => ({
    time: asset.time,
    anchor:
      asset.pointSource === TripPointSource.Manual
        ? pointOf(asset)
        : pointOf({ latitude: asset.gpsLatitude, longitude: asset.gpsLongitude }),
  }));
  const points = inferPoints(kind, shots, start ? pointOf(start) : null);
  for (const [i, asset] of assets.entries()) {
    if (asset.pointSource === TripPointSource.Manual) {
      continue;
    }
    const point = shots[i].anchor ? null : points[i];
    const [latitude, longitude] = [point?.latitude ?? null, point?.longitude ?? null];
    if (latitude === asset.latitude && longitude === asset.longitude) {
      continue;
    }
    await trx
      .updateTable('trip_asset')
      .set({ latitude, longitude, pointSource: point && TripPointSource.Inferred })
      .where('albumId', '=', id)
      .where('assetId', '=', asset.assetId)
      .execute();
    if (asset.stopId) {
      touch(asset.stopId);
    }
  }
};

const getStop = (trx: Transaction<DB>, albumId: string, stopId: string) =>
  trx
    .selectFrom('trip_stop')
    .select(['id', 'role', 'isAddedByHand'])
    .where('albumId', '=', asUuid(albumId))
    .where('id', '=', asUuid(stopId))
    .executeTakeFirst();

/**
 * Files album assets into `stopId`. Every asset must be in the album and outside the trash; a stop it would leave
 * without assets is refused (travel-album `_move`).
 */
const moveAssets = async (
  trx: Transaction<DB>,
  albumId: string,
  assetIds: string[],
  stopId: string,
  touch: (...stopIds: string[]) => void,
): Promise<TripEditResult | void> => {
  const ids = [...new Set(assetIds)];
  const rows =
    ids.length === 0
      ? []
      : await trx
          .selectFrom('album_asset')
          .innerJoin('asset', 'asset.id', 'album_asset.assetId')
          .leftJoin('trip_asset', (join) =>
            join
              .onRef('trip_asset.albumId', '=', 'album_asset.albumId')
              .onRef('trip_asset.assetId', '=', 'album_asset.assetId'),
          )
          .select(['album_asset.assetId', 'trip_asset.stopId'])
          .where('album_asset.albumId', '=', asUuid(albumId))
          .where('album_asset.assetId', 'in', ids)
          .where('asset.deletedAt', 'is', null)
          .execute();
  if (rows.length === 0 || rows.length !== ids.length) {
    return TripEditResult.AssetForeign;
  }
  const leaving = new Map<string, number>();
  for (const { stopId: from } of rows) {
    if (from && from !== stopId) {
      leaving.set(from, (leaving.get(from) ?? 0) + 1);
    }
  }
  if (leaving.size > 0) {
    const counts = await trx
      .selectFrom('trip_asset')
      .select(['stopId', sql<number>`count(*)::int`.as('count')])
      .where('stopId', 'in', leaving.keys().toArray())
      .groupBy('stopId')
      .execute();
    if (counts.some(({ stopId: from, count }) => leaving.get(from!) === count)) {
      return TripEditResult.MoveEmpties;
    }
  }
  await trx
    .insertInto('trip_asset')
    .values(ids.map((assetId) => ({ albumId, assetId, stopId })))
    .onConflict((oc) => oc.columns(['albumId', 'assetId']).doUpdateSet({ stopId }))
    .execute();
  await recordLocalTimes(trx, albumId);
  touch(stopId, ...leaving.keys());
};

const positions = async (trx: Transaction<DB>, albumId: string) => {
  const rows = await trx
    .selectFrom('trip_stop')
    .select(['id', 'latitude', 'longitude'])
    .where('albumId', '=', asUuid(albumId))
    .execute();
  return new Map(rows.map((row) => [row.id, pointOf(row)]));
};

// Stops that kept their row and changed their point.
const movedStopIds = (before: Map<string, LatLng | null>, after: Map<string, LatLng | null>) =>
  [...after].flatMap(([id, point]) => {
    if (!before.has(id)) {
      return [];
    }
    const old = before.get(id)!;
    const isMoved = !old || !point ? old !== point : haversineM(old, point) > MOVED_M;
    return isMoved ? [id] : [];
  });

/**
 * The local times of `stopIds` span their assets', and their centre is the mean of the assets' points: the trip's own
 * point of an asset, else its GPS (travel-album `refresh_stops`). A start, a finish, a stop without assets and a pin
 * the owner placed keep theirs; a Plain trip's sections have no point.
 */
export const refreshStops = async (trx: Transaction<DB>, albumId: string, kind: TripKind, stopIds: string[]) => {
  if (stopIds.length === 0) {
    return;
  }
  const id = asUuid(albumId);
  const stops = sql.join(stopIds.map((stopId) => asUuid(stopId)));
  await sql`
    UPDATE "trip_stop" SET "localStart" = "filed"."start", "localEnd" = "filed"."end"
    FROM (
      SELECT "trip_asset"."stopId", min("asset"."localDateTime") AS "start", max("asset"."localDateTime") AS "end"
      FROM "trip_asset" INNER JOIN "asset" ON "asset"."id" = "trip_asset"."assetId"
      WHERE "trip_asset"."albumId" = ${id} AND "trip_asset"."stopId" IN (${stops})
      GROUP BY "trip_asset"."stopId"
    ) AS "filed"
    WHERE "trip_stop"."id" = "filed"."stopId" AND "trip_stop"."role" IS NULL
  `.execute(trx);
  if (kind === TripKind.Plain) {
    return;
  }
  await sql`
    UPDATE "trip_stop" SET "latitude" = "centre"."latitude", "longitude" = "centre"."longitude"
    FROM (
      SELECT
        "trip_asset"."stopId",
        round(avg(coalesce("trip_asset"."latitude", "asset_exif"."latitude"))::numeric, 6)::double precision AS "latitude",
        round(avg(coalesce("trip_asset"."longitude", "asset_exif"."longitude"))::numeric, 6)::double precision AS "longitude"
      FROM "trip_asset" LEFT JOIN "asset_exif" ON "asset_exif"."assetId" = "trip_asset"."assetId"
      WHERE "trip_asset"."albumId" = ${id} AND "trip_asset"."stopId" IN (${stops})
        AND ("trip_asset"."latitude" IS NOT NULL
          OR ("asset_exif"."latitude" IS NOT NULL AND "asset_exif"."longitude" IS NOT NULL))
      GROUP BY "trip_asset"."stopId"
    ) AS "centre"
    WHERE "trip_stop"."id" = "centre"."stopId" AND "trip_stop"."role" IS NULL AND NOT "trip_stop"."isPositionManual"
  `.execute(trx);
};

// What the edit leaves to the jobs: pending legs to route, and on a trip with a map, stops with a point to name.
const pendingWork = async (trx: Transaction<DB>, albumId: string, kind: TripKind) => {
  const id = asUuid(albumId);
  const [leg, stop] = await Promise.all([
    trx
      .selectFrom('trip_leg')
      .select('id')
      .where('albumId', '=', id)
      .where('status', '=', TripLegStatus.Pending)
      .where('mode', '!=', TripLegMode.Trail)
      .executeTakeFirst(),
    trx
      .selectFrom('trip_stop')
      .select('id')
      .where('albumId', '=', id)
      .where('latitude', 'is not', null)
      .where('longitude', 'is not', null)
      .where(sql`coalesce(btrim("title"), '')`, '=', '')
      .executeTakeFirst(),
  ]);
  return { needsRouting: !!leg, needsNaming: kind !== TripKind.Plain && !!stop };
};
