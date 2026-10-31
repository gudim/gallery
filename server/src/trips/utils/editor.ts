import { TripStopRole } from 'src/trips/enum.js';

// Pure parts of the stop editor (trips PLAN §2.5), ported from travel-album's atlas/albums/{editor,transit}.py.

export type OrderedStop = { id: string; role: TripStopRole | null; localStart: Date | null; localEnd: Date | null };

export type PointPlacement = { localTime: Date | null; sequences: Array<{ id: string; sequence: number }> };

const sameTime = (a: Date | null, b: Date | null) =>
  a === null ? b === null : b !== null && a.getTime() === b.getTime();

/**
 * Where a point added by hand goes when placed right after `afterStopId`, or right after the start for null
 * (travel-album `_place`). Stops are ordered by time (decision P20), so the point takes the end time of the stop before
 * it (no time right after the start, which sorts first), and every stop sharing that time is renumbered in the wanted
 * order, else the tie would go by id. `order` is the trip order without the point. `missing` when `afterStopId` is not a
 * stop of the trip, `finish` when it is the finish.
 */
export const placeAfter = (
  order: OrderedStop[],
  pointId: string,
  afterStopId: string | null,
): PointPlacement | 'missing' | 'finish' => {
  let localTime: Date | null = null;
  let index = order.filter(({ role }) => role === TripStopRole.Start).length;
  if (afterStopId !== null) {
    const after = order.findIndex(({ id }) => id === afterStopId);
    if (after === -1) {
      return 'missing';
    }
    const stop = order[after];
    if (stop.role === TripStopRole.Finish) {
      return 'finish';
    }
    if (stop.role === null) {
      localTime = stop.localEnd ?? stop.localStart;
    }
    index = after + 1;
  }
  const wanted = order.map(({ id, role, localStart }) => ({ id, role, localStart }));
  wanted.splice(index, 0, { id: pointId, role: null, localStart: localTime });
  const sequences = wanted
    .filter(({ role, localStart }) => role === null && sameTime(localStart, localTime))
    .map(({ id }, sequence) => ({ id, sequence }));
  return { localTime, sequences };
};

/**
 * Each stop shot on the way, mapped to the real stops before and after it, whose leg it lies on (travel-album
 * `transit.spans`). A transit stop with no real stop on one side has no leg and is left out.
 */
export const transitSpans = (stops: Array<{ id: string; isTransit: boolean | null }>) => {
  const spans = new Map<string, [from: string, to: string]>();
  let previous: string | undefined;
  let waiting: string[] = [];
  for (const { id, isTransit } of stops) {
    if (isTransit) {
      if (previous !== undefined) {
        waiting.push(id);
      }
      continue;
    }
    for (const transit of waiting) {
      spans.set(transit, [previous!, id]);
    }
    waiting = [];
    previous = id;
  }
  return spans;
};
