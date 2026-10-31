import { Injectable } from '@nestjs/common';
import { Kysely, Transaction, sql } from 'kysely';
import { InjectKysely } from 'nestjs-kysely';
import { randomUUID } from 'node:crypto';
import { DummyValue, GenerateSql } from 'src/decorators.js';
import { DB } from 'src/schema/index.js';
import { TripKind, TripLegMode, TripLegStatus, TripStopRole } from 'src/trips/enum.js';
import {
  TripEditResult,
  bumpContentVersion,
  lockTrip,
  noStations,
  stopOrder,
  syncRouteLegs,
  unbuilt,
} from 'src/trips/repositories/trip.repository.js';
import { type LatLng, haversineM, pointOf } from 'src/trips/utils/geo.js';
import { asUuid } from 'src/utils/database.js';

// The stop editor (trips PLAN §2.5, travel-album `atlas/albums/editor.py`). Every id an edit takes must belong to the
// trip it edits: there are no composite keys to check it (trips DECISIONS-LOG 2026-10-31).

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
   * Runs one stop edit in a transaction that holds the trip row, then does what travel-album's `editor.edited` did:
   * the times and centres of the stops it touched follow their assets, a route's legs follow its stop order, legs of
   * a stop that moved are built again without their stations, and `contentVersion` goes up. A refused edit is rolled
   * back. Stops it did not touch keep their times and centres: an imported trip's may differ from what its assets
   * give, and a text edit must not move them.
   */
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
const refreshStops = async (trx: Transaction<DB>, albumId: string, kind: TripKind, stopIds: string[]) => {
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
