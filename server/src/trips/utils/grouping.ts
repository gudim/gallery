import { TripKind, TripStopRole } from 'src/trips/enum.js';
import { type LatLng, haversineM } from 'src/trips/utils/geo.js';

// How a trip's assets fall into stops, ported from travel-album's atlas/geo/{cluster,interp}.py and
// atlas/albums/transit.py (its PLAN §5.10, §5.12). Pure: callers read the rows, sort them and write the result.
// Times are local wall-clock times stored as if UTC, like asset.localDateTime.

export const RADIUS_M = 400;
export const GAP_MS = 90 * 60_000;

export type TimedPoint = LatLng & { time: Date };
export type Group<T> = LatLng & { items: T[] };

const nearestBy = <T>(items: T[], distance: (item: T) => number): T | undefined => {
  let best: T | undefined;
  let bestDistance = Infinity;
  for (const item of items) {
    const d = distance(item);
    if (d < bestDistance) {
      [best, bestDistance] = [item, d];
    }
  }
  return best;
};

// Route stops. Points in time order; a point opens a new group when it lies more than 400 m from the group's running
// mean or more than 90 min after the group's last point.
export const routeGroups = <T extends TimedPoint>(points: T[]): Group<T>[] => {
  const groups: Group<T>[] = [];
  let current: Group<T> | undefined;
  for (const point of points) {
    const last = current?.items.at(-1);
    if (
      current &&
      last &&
      (haversineM(current, point) > RADIUS_M || point.time.getTime() - last.time.getTime() > GAP_MS)
    ) {
      current = undefined;
    }
    if (!current) {
      current = { latitude: point.latitude, longitude: point.longitude, items: [] };
      groups.push(current);
    }
    current.items.push(point);
    const n = current.items.length;
    current.latitude += (point.latitude - current.latitude) / n;
    current.longitude += (point.longitude - current.longitude) / n;
  }
  return groups;
};

// An asset in time order and its anchor: its own GPS or a manual point. Null when it has neither.
export type Shot = { time: Date; anchor: LatLng | null };

// The point of every shot in a route: an anchor keeps its own; a shot between two anchors is interpolated linearly by
// time (a zero span takes the middle), one beyond the last anchor on a side copies the nearest. With no anchor at
// all, every shot takes the start's point, so it still lands in a stop; with no start either, none has a point.
export const inferRoutePoints = (shots: Shot[], start: LatLng | null = null): Array<LatLng | null> => {
  const anchors = shots.flatMap((shot, i) => (shot.anchor ? [i] : []));
  if (anchors.length === 0) {
    return shots.map(() => start);
  }
  let k = 0;
  return shots.map((shot, i) => {
    while (k < anchors.length && anchors[k] < i) {
      k++;
    }
    if (shot.anchor) {
      return shot.anchor;
    }
    const previous = k > 0 ? shots[anchors[k - 1]] : undefined;
    const next = k < anchors.length ? shots[anchors[k]] : undefined;
    if (!previous || !next) {
      return (previous ?? next)!.anchor;
    }
    const [a, b] = [previous.anchor!, next.anchor!];
    const span = next.time.getTime() - previous.time.getTime();
    const f = span <= 0 ? 0.5 : (shot.time.getTime() - previous.time.getTime()) / span;
    return {
      latitude: a.latitude + (b.latitude - a.latitude) * f,
      longitude: a.longitude + (b.longitude - a.longitude) * f,
    };
  });
};

// The point of every shot in a Places trip, which never interpolates across months. A walk is a run of shots with
// gaps of 90 min or less; a shot without an anchor takes the anchor of its walk nearest in time (the earlier on a
// tie). In a walk without anchors it has no point and stays Unplaced until the owner picks a place.
export const inferPlacePoints = (shots: Shot[]): Array<LatLng | null> => {
  const walks: Shot[][] = [];
  let previous: Shot | undefined;
  for (const shot of shots) {
    if (!previous || shot.time.getTime() - previous.time.getTime() > GAP_MS) {
      walks.push([]);
    }
    walks.at(-1)!.push(shot);
    previous = shot;
  }
  return walks.flatMap((walk) => {
    const anchors = walk.filter((shot) => shot.anchor);
    return walk.map(
      (shot) =>
        shot.anchor ??
        nearestBy(anchors, (anchor) => Math.abs(anchor.time.getTime() - shot.time.getTime()))?.anchor ??
        null,
    );
  });
};

// The point of every shot as the trip's kind infers it; a Plain trip has no map, so no shot has a point.
export const inferPoints = (kind: TripKind, shots: Shot[], start: LatLng | null = null): Array<LatLng | null> => {
  switch (kind) {
    case TripKind.Route: {
      return inferRoutePoints(shots, start);
    }
    case TripKind.Places: {
      return inferPlacePoints(shots);
    }
    case TripKind.Plain: {
      return shots.map(() => null);
    }
  }
};

// An existing place of a Places trip; `isFixed` when the owner moved its pin, so its centre stays.
export type Place = LatLng & { id: string; count: number; isFixed: boolean };
export type PlaceGroup<T> = Group<T> & { id: string | null };

// Places by distance alone, so visits years apart fall into one place. A point joins the nearest place within 400 m
// or opens a new one; centres follow a running mean unless fixed. A second pass puts every point into the nearest of
// the resulting places, as centres drift after the points that formed them. Centres that end up closer than 400 m
// are one place: the smaller new one dissolves into its neighbours and the pass repeats. Two existing places never
// merge; that is the owner's call. Returns every place, existing ones without new points included (`id` null: new).
export const placeGroups = <T extends LatLng>(points: T[], places: Place[] = []): PlaceGroup<T>[] => {
  type Working = PlaceGroup<T> & { count: number; isFixed: boolean; base: LatLng & { count: number } };
  let groups: Working[] = places.map((place) => ({
    ...place,
    items: [],
    base: { latitude: place.latitude, longitude: place.longitude, count: place.count },
  }));
  const nearest = (point: LatLng) => nearestBy(groups, (group) => haversineM(group, point));

  for (const point of points) {
    let best = nearest(point);
    if (!best || haversineM(best, point) > RADIUS_M) {
      const { latitude, longitude } = point;
      best = {
        id: null,
        latitude,
        longitude,
        count: 0,
        isFixed: false,
        items: [],
        base: { latitude, longitude, count: 0 },
      };
      groups.push(best);
    }
    best.count++;
    if (best.isFixed) {
      continue;
    }
    best.latitude += (point.latitude - best.latitude) / best.count;
    best.longitude += (point.longitude - best.longitude) / best.count;
  }

  for (;;) {
    for (const group of groups) {
      group.items = [];
    }
    for (const point of points) {
      nearest(point)!.items.push(point);
    }
    groups = groups.filter((group) => group.id !== null || group.items.length > 0);
    for (const group of groups) {
      if (group.isFixed || group.items.length === 0) {
        continue;
      }
      const { base, items } = group;
      const n = base.count + items.length;
      group.latitude = (base.latitude * base.count + items.reduce((sum, p) => sum + p.latitude, 0)) / n;
      group.longitude = (base.longitude * base.count + items.reduce((sum, p) => sum + p.longitude, 0)) / n;
    }
    let closest: { distance: number; keep: Working; drop: Working } | undefined;
    for (const [i, a] of groups.entries()) {
      for (const b of groups.slice(i + 1)) {
        const distance = haversineM(a, b);
        if ((a.id === null || b.id === null) && (!closest || distance < closest.distance)) {
          closest = { distance, keep: a, drop: b };
        }
      }
    }
    if (!closest || closest.distance > RADIUS_M) {
      break;
    }
    const { keep, drop } = closest;
    const dropped = drop.id !== null || (keep.id === null && keep.items.length < drop.items.length) ? keep : drop;
    groups = groups.filter((group) => group !== dropped);
  }

  return groups.map(({ id, latitude, longitude, items }) => ({ id, latitude, longitude, items }));
};

// An existing section of a plain trip: the days [start, end] it covers, both null for "No date".
export type Section = { id: string; start: Date | null; end: Date | null };
export type SectionGroup<T> = { id: string | null; items: T[] };

const dayOf = (time: Date) => time.toISOString().slice(0, 10);

// Sections of a plain trip, by the calendar day of each asset's time; points are kept but not used. Items in time
// order, undated last. A day joins the existing section whose days cover it (the owner may have merged days),
// otherwise it opens a new one (`id` null). Undated items form the "No date" section.
export const daySections = <T extends { time: Date | null }>(
  items: T[],
  sections: Section[] = [],
): SectionGroup<T>[] => {
  const days = new Map<string | null, T[]>();
  for (const item of items) {
    const day = item.time ? dayOf(item.time) : null;
    days.set(day, [...(days.get(day) ?? []), item]);
  }
  return [...days].map(([day, dayItems]) => {
    const section = sections.find(({ start, end }) =>
      day === null ? start === null : start !== null && dayOf(start) <= day && day <= dayOf(end ?? start),
    );
    return { id: section?.id ?? null, items: dayItems };
  });
};

export const TRANSIT_SPEED_KMH = 150;
// Shorter than this, speed from minute-precision times means nothing.
const TRANSIT_MIN_DISTANCE_M = 2000;
// A stop with no GPS of its own between neighbours this far apart was inferred somewhere under the flight path.
const TRANSIT_FAR_M = 100_000;

export type TransitStop = {
  id: string;
  role: TripStopRole | null;
  isAddedByHand: boolean;
  isTransit: boolean | null;
  start: Date | null;
  end: Date | null;
  latitude: number | null;
  longitude: number | null;
};

const pointOf = ({ latitude, longitude }: TransitStop): LatLng | null =>
  latitude === null || longitude === null ? null : { latitude, longitude };

// Speed from the end of stop `a` to the start of `b`, centre to centre; null when it cannot be told.
export const speedKmh = (a: TransitStop, b: TransitStop): number | null => {
  const [p, q] = [pointOf(a), pointOf(b)];
  const t0 = a.end ?? a.start;
  if (!p || !q || !t0 || !b.start || b.start <= t0) {
    return null;
  }
  const distance = haversineM(p, q);
  if (distance < TRANSIT_MIN_DISTANCE_M) {
    return null;
  }
  return distance / 1000 / ((b.start.getTime() - t0.getTime()) / 3_600_000);
};

const isFar = (a: TransitStop, b: TransitStop) => {
  const [p, q] = [pointOf(a), pointOf(b)];
  return !!p && !!q && haversineM(p, q) >= TRANSIT_FAR_M;
};

export type TransitSuggestion = { stopIds: string[]; kmh: number | null };

// Stops that look shot on the way, as groups of neighbours; the owner confirms or declines them. Stops in trip order;
// `blind` holds the stops none of whose assets has GPS of its own. A stop qualifies when the speed both from the
// previous stop and to the next is at least 150 km/h (an airport of departure is fast on one side only; a side whose
// speed cannot be told counts as slow), or when it is blind and its neighbours are at least 100 km apart. `kmh` is
// the top speed seen, null when only blindness qualified the group.
export const transitSuggestions = (stops: TransitStop[], blind: ReadonlySet<string>): TransitSuggestion[] => {
  const suggestions: TransitSuggestion[] = [];
  let current: TransitSuggestion | undefined;
  for (const [i, stop] of stops.entries()) {
    const isCandidate = stop.role === null && !stop.isAddedByHand && stop.isTransit === null && stop.start !== null;
    if (!isCandidate || i === 0 || i === stops.length - 1) {
      current = undefined;
      continue;
    }
    const [previous, next] = [stops[i - 1], stops[i + 1]];
    const sides = [speedKmh(previous, stop), speedKmh(stop, next)];
    const isFast = sides.every((kmh) => kmh !== null && kmh >= TRANSIT_SPEED_KMH);
    if (!isFast && !(blind.has(stop.id) && isFar(previous, next))) {
      current = undefined;
      continue;
    }
    if (!current) {
      current = { stopIds: [], kmh: null };
      suggestions.push(current);
    }
    current.stopIds.push(stop.id);
    if (isFast) {
      current.kmh = Math.round(Math.max(current.kmh ?? 0, ...(sides as number[])));
    }
  }
  return suggestions;
};
