import { TripKind, TripLegMode } from 'src/trips/enum.js';
import { type LatLng, type Located, haversineM, pointOf, round6 } from 'src/trips/utils/geo.js';
import { GAP_MS, RADIUS_M, daySections, inferPoints, placeGroups } from 'src/trips/utils/grouping.js';
import { routeLegs } from 'src/trips/utils/lay-out.js';

// Filing assets the trip has not seen yet into its stops (trips PLAN D12; travel-album's assign and sync_legs). The
// owner's stops keep their texts, pins they moved and legs they set; a stop only grows to take new assets. Pure: the
// caller reads the rows and writes the result.

// A stop filing may add assets to: not the start or finish, not one added by hand, not a centre stop. `count` is its
// number of assets, which weighs its centre.
export type FilingStop = Located & {
  id: string;
  start: Date | null;
  end: Date | null;
  count: number;
  isPositionManual: boolean;
};
// An album asset in time order: `anchor` is its own GPS or manual point; `isNew` when the trip has not filed it yet.
export type FilingAsset = { id: string; time: Date; anchor: LatLng | null; isNew: boolean };
// A stop filing grew or opened (`isNew`), and where each new asset went with its inferred point.
export type FiledStop = FilingStop & { isNew: boolean };
export type Filing = {
  stops: FiledStop[];
  assets: Array<{ assetId: string; stopId: string | null; point: LatLng | null }>;
};

// How far a time lies outside a stop's [start, end].
const gapMs = (time: Date, { start, end }: FiledStop) => {
  const [from, to] = [start!.getTime(), (end ?? start)!.getTime()];
  return time.getTime() < from ? from - time.getTime() : Math.max(time.getTime() - to, 0);
};

/** `start` is a route's start, where its assets go when none has GPS; `newId` names a new stop. */
export const fileAssets = (
  kind: TripKind,
  stops: FilingStop[],
  assets: FilingAsset[],
  { start = null, newId }: { start?: LatLng | null; newId: () => string },
): Filing => {
  const points = inferPoints(kind, assets, start);
  const fresh = assets.flatMap((asset, i) => (asset.isNew ? [{ ...asset, point: points[i] }] : []));
  const touched = new Map<string, FiledStop>();
  const stopOf = new Map<string, string>();
  const existing = stops.map((stop) => ({ ...stop, isNew: false }));

  const join = (stop: FiledStop, { id, time }: { id: string; time: Date }) => {
    stop.start = stop.start && stop.start < time ? stop.start : time;
    stop.end = stop.end && stop.end > time ? stop.end : time;
    stopOf.set(id, stop.id);
    touched.set(stop.id, stop);
  };
  const open = (point: LatLng | null): FiledStop => ({
    id: newId(),
    latitude: point?.latitude ?? null,
    longitude: point?.longitude ?? null,
    start: null,
    end: null,
    count: 0,
    isPositionManual: false,
    isNew: true,
  });

  if (kind === TripKind.Route) {
    // The candidate is the stop nearest in time, then in distance; it takes the asset within 90 min and 400 m.
    const candidates = existing.filter((stop) => stop.start && pointOf(stop));
    for (const asset of fresh) {
      if (!asset.point) {
        continue;
      }
      let best: { stop: FiledStop; gap: number; distance: number } | undefined;
      for (const stop of candidates) {
        const [gap, distance] = [gapMs(asset.time, stop), haversineM(pointOf(stop)!, asset.point)];
        if (!best || gap < best.gap || (gap === best.gap && distance < best.distance)) {
          best = { stop, gap, distance };
        }
      }
      let stop = best && best.gap <= GAP_MS && best.distance <= RADIUS_M ? best.stop : undefined;
      if (!stop) {
        stop = open(asset.point);
        candidates.push(stop);
      }
      stop.count++;
      if (!stop.isPositionManual) {
        stop.latitude! += (asset.point.latitude - stop.latitude!) / stop.count;
        stop.longitude! += (asset.point.longitude - stop.longitude!) / stop.count;
      }
      join(stop, asset);
    }
  } else if (kind === TripKind.Places) {
    const places = existing.flatMap((stop) => {
      const point = pointOf(stop);
      return point ? [{ ...point, id: stop.id, count: stop.count, isFixed: stop.isPositionManual }] : [];
    });
    const located = fresh.flatMap(({ id, time, point }) => (point ? [{ ...point, id, time }] : []));
    for (const group of placeGroups(located, places)) {
      if (group.items.length === 0) {
        continue;
      }
      const stop = existing.find(({ id }) => id === group.id) ?? open(group);
      stop.latitude = group.latitude;
      stop.longitude = group.longitude;
      stop.count += group.items.length;
      for (const item of group.items) {
        join(stop, item);
      }
    }
  } else {
    for (const { id, items } of daySections(fresh, existing)) {
      const stop = existing.find((section) => section.id === id) ?? open(null);
      stop.count += items.length;
      for (const item of items) {
        join(stop, item);
      }
    }
  }

  return {
    stops: touched
      .values()
      .map((stop) => ({
        ...stop,
        latitude: stop.latitude === null ? null : round6(stop.latitude),
        longitude: stop.longitude === null ? null : round6(stop.longitude),
      }))
      .toArray(),
    assets: fresh.map(({ id, anchor, point }) => ({
      assetId: id,
      stopId: stopOf.get(id) ?? null,
      point: anchor ? null : point,
    })),
  };
};

export type FilingLeg = { id: string; fromStopId: string; toStopId: string; mode: TripLegMode; isModeManual: boolean };

const pairKey = (fromStopId: string, toStopId: string) => `${fromStopId}/${toStopId}`;

/**
 * Legs between consecutive stops of a route in trip order; a transit stop lies on a leg, not between two. Legs whose
 * stops are no longer neighbours go; a new pair is pending, and inherits the mode the owner set on a removed leg that
 * spanned it (travel-album decision P17).
 */
export const syncLegs = (
  stops: Array<Located & { id: string; isTransit: boolean | null }>,
  legs: FilingLeg[],
): { removedIds: string[]; added: Array<Omit<FilingLeg, 'id'>> } => {
  const real = stops.filter(({ isTransit }) => !isTransit);
  const position = new Map(real.map(({ id }, i) => [id, i]));
  const pairs = routeLegs(real);
  const wanted = new Set(pairs.map(({ from, to }) => pairKey(from.id, to.id)));
  const have = new Set(legs.map(({ fromStopId, toStopId }) => pairKey(fromStopId, toStopId)));
  const gone = legs.filter(({ fromStopId, toStopId }) => !wanted.has(pairKey(fromStopId, toStopId)));
  const added = pairs.flatMap(({ from, to, mode }, i) => {
    if (have.has(pairKey(from.id, to.id))) {
      return [];
    }
    const parent = gone.find(
      (leg) =>
        leg.isModeManual &&
        (position.get(leg.fromStopId) ?? real.length) <= i &&
        (position.get(leg.toStopId) ?? -1) >= i + 1,
    );
    return [
      {
        fromStopId: from.id,
        toStopId: to.id,
        ...(parent ? { mode: parent.mode, isModeManual: true } : { mode, isModeManual: false }),
      },
    ];
  });
  return { removedIds: gone.map(({ id }) => id), added };
};
