import { TripKind, TripLegMode } from 'src/trips/enum.js';
import { type LatLng, type Located, defaultMode, haversineM, pointOf, round6 } from 'src/trips/utils/geo.js';
import {
  type Shot,
  daySections,
  inferPlacePoints,
  inferRoutePoints,
  placeGroups,
  routeGroups,
} from 'src/trips/utils/grouping.js';

// The first layout of a trip (travel-album's locate + full_cluster): every album asset filed into a new stop, or left
// Unplaced. Pure: the caller reads the assets and writes the result.

// An album asset in time order, with its own GPS when it has one.
export type LayoutAsset = { id: string; time: Date; latitude: number | null; longitude: number | null };

// `index` names the stop within this layout; stops come in time order.
export type LaidOutStop = { index: number; latitude: number | null; longitude: number | null; start: Date; end: Date };
// `point` is an inferred point; an asset with GPS of its own or none at all has none.
export type LaidOutAsset = { assetId: string; stopIndex: number | null; point: LatLng | null };
export type TripLayout = { stops: LaidOutStop[]; assets: LaidOutAsset[] };

const toStop = (index: number, items: Array<{ time: Date }>, centre: LatLng | null): LaidOutStop => ({
  index,
  latitude: centre && round6(centre.latitude),
  longitude: centre && round6(centre.longitude),
  start: new Date(Math.min(...items.map(({ time }) => time.getTime()))),
  end: new Date(Math.max(...items.map(({ time }) => time.getTime()))),
});

/** `start` is a route's start, where its assets go when none has GPS. */
export const layOutTrip = (kind: TripKind, assets: LayoutAsset[], start: LatLng | null = null): TripLayout => {
  const shots: Shot[] = assets.map((asset) => ({ time: asset.time, anchor: pointOf(asset) }));
  const stopOf = new Map<string, number>();
  const points =
    kind === TripKind.Route
      ? inferRoutePoints(shots, start)
      : kind === TripKind.Places
        ? inferPlacePoints(shots)
        : shots.map(() => null);
  const located = assets.flatMap((asset, i) => {
    const point = points[i];
    return point ? [{ ...point, id: asset.id, time: asset.time }] : [];
  });

  let stops: LaidOutStop[];
  if (kind === TripKind.Plain) {
    stops = daySections(assets).map(({ items }, index) => {
      for (const { id } of items) {
        stopOf.set(id, index);
      }
      return toStop(index, items, null);
    });
  } else {
    const groups = kind === TripKind.Route ? routeGroups(located) : placeGroups(located);
    stops = groups
      .map((group) => ({ group, stop: toStop(0, group.items, group) }))
      .sort((a, b) => a.stop.start.getTime() - b.stop.start.getTime())
      .map(({ group, stop }, index) => {
        for (const { id } of group.items) {
          stopOf.set(id, index);
        }
        return { ...stop, index };
      });
  }

  return {
    stops,
    assets: assets.map((asset, i) => ({
      assetId: asset.id,
      stopIndex: stopOf.get(asset.id) ?? null,
      point: shots[i].anchor ? null : points[i],
    })),
  };
};

// Legs of a route between consecutive stops, in trip order: on foot when close, by car otherwise or when an end has
// no point (travel-album's sync_legs).
export const routeLegs = <T extends Located>(stops: T[]): Array<{ from: T; to: T; mode: TripLegMode }> =>
  stops.slice(1).map((to, i) => {
    const from = stops[i];
    const [a, b] = [pointOf(from), pointOf(to)];
    return { from, to, mode: a && b ? defaultMode(haversineM(a, b)) : TripLegMode.Driving };
  });
