import { TripKind } from 'src/trips/enum.js';
import { pointOf } from 'src/trips/utils/geo.js';
import { type TimedPoint, routeGroups } from 'src/trips/utils/layout.js';

// The clock-offset wizard (trips PLAN D9, travel-album `ingest/clock.py` and `ingest/cameras.py`). A camera is EXIF
// make and model, videos a camera of their own (trips DECISIONS-LOG 2026-10-31, owner); a reference camera has GPS on
// at least half of its assets. Its stops, padded by 5 min, are the windows; a camera without GPS with at least 10
// assets is shifted from −14 to +14 h by the minute, scored by the share of its assets that fall in a window. A shift
// is suggested when it scores at least 0.5 and gains at least 0.2 over none. Times are local wall-clock times, as
// Immich keeps `asset.localDateTime`, and a shift applied moves them, so the current shift is always none. Pure.

const PAD_MS = 5 * 60_000;
export const RANGE_MIN = 14 * 60;
const MIN_ASSETS = 10;
const SUGGEST_BEST = 0.5;
const SUGGEST_GAIN = 0.2;
const REFERENCE_SHARE = 0.5;

export type ClockWindow = [start: number, end: number];

/** The stops of GPS assets, each padded by 5 min, merged where they overlap, in time order (ms). */
export const clockWindows = (points: TimedPoint[]): ClockWindow[] => {
  const spans = routeGroups(points.toSorted((a, b) => a.time.getTime() - b.time.getTime()))
    .map(({ items }): ClockWindow => [items[0].time.getTime() - PAD_MS, items.at(-1)!.time.getTime() + PAD_MS])
    .toSorted((a, b) => a[0] - b[0]);
  const merged: ClockWindow[] = [];
  for (const [start, end] of spans) {
    const last = merged.at(-1);
    if (last && start <= last[1]) {
      last[1] = Math.max(last[1], end);
    } else {
      merged.push([start, end]);
    }
  }
  return merged;
};

// How many of the times shifted by `offsetMs` fall in a window.
const hits = (times: number[], windows: ClockWindow[], offsetMs: number) => {
  let count = 0;
  for (const time of times) {
    const shifted = time + offsetMs;
    let [lo, hi] = [0, windows.length];
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (windows[mid][0] <= shifted) {
        lo = mid + 1;
      } else {
        hi = mid;
      }
    }
    if (lo > 0 && shifted <= windows[lo - 1][1]) {
      count++;
    }
  }
  return count;
};

/**
 * The shift in minutes for scores from −14 h by the minute: the middle of a run of the best score, of several runs
 * the one nearest zero. Windows are 5 min wider than the stops, so the best score holds over a band, and its edge would
 * miss by 5 min.
 */
export const pickOffset = (counts: number[]): number => {
  const best = Math.max(...counts);
  const middles: number[] = [];
  let lo: number | null = null;
  for (const [i, count] of [...counts, null].entries()) {
    if (count === best && lo === null) {
      lo = i;
    } else if (count !== best && lo !== null) {
      middles.push((lo + i - 1) / 2 - RANGE_MIN);
      lo = null;
    }
  }
  const middle = nearestZero(middles);
  // `+ 0` turns −0 into 0.
  return nearestZero([Math.floor(middle), Math.ceil(middle)]) + 0;
};

// The value nearest zero, the first on a tie.
const nearestZero = (values: number[]) => {
  let nearest = values[0];
  for (const value of values) {
    if (Math.abs(value) < Math.abs(nearest)) {
      nearest = value;
    }
  }
  return nearest;
};

export type ClockSuggestion = { offsetMinutes: number; current: number; best: number; isSuggested: boolean };

const round3 = (value: number) => Math.round(value * 1000) / 1000;

/** The best shift of a camera's times against the windows, and whether to suggest it. */
export const suggestOffset = (times: Date[], windows: ClockWindow[]): ClockSuggestion => {
  const ms = times.map((time) => time.getTime());
  const counts = Array.from({ length: 2 * RANGE_MIN + 1 }, (_, i) => hits(ms, windows, (i - RANGE_MIN) * 60_000));
  const offsetMinutes = pickOffset(counts);
  const best = Math.max(...counts) / ms.length;
  const current = hits(ms, windows, 0) / ms.length;
  return {
    offsetMinutes,
    current: round3(current),
    best: round3(best),
    isSuggested: offsetMinutes !== 0 && best >= SUGGEST_BEST && best - current >= SUGGEST_GAIN,
  };
};

/** An album asset outside the trash with its camera, owner, local time and own GPS. */
export type ClockAsset = {
  id: string;
  ownerId: string;
  make: string | null;
  model: string | null;
  isVideo: boolean;
  time: Date;
  latitude: number | null;
  longitude: number | null;
};

export type ClockCamera = {
  make: string | null;
  model: string | null;
  isVideo: boolean;
  assetCount: number;
  gpsCount: number;
  isReference: boolean;
  /** The caller's assets of the camera, the only ones they may shift (trips PLAN D9) */
  ownAssetIds: string[];
  /** A shift to suggest, or null */
  suggestion: { offsetMinutes: number; current: number; best: number } | null;
};

/**
 * The album's cameras, most assets first, each with a suggested shift where one is worth it. A Places trip gets none,
 * as in travel-album: its visits lie years apart, and only a shift by hand is offered.
 */
export const clockCameras = (assets: ClockAsset[], userId: string, kind: TripKind): ClockCamera[] => {
  const byCamera = new Map<string, ClockAsset[]>();
  for (const asset of assets) {
    const key = JSON.stringify([asset.make, asset.model, asset.isVideo]);
    byCamera.set(key, [...(byCamera.get(key) ?? []), asset]);
  }
  const cameras = byCamera
    .values()
    .map((list) => {
      const gps = list.filter((asset) => pointOf(asset));
      return { list, gps, isReference: gps.length / list.length >= REFERENCE_SHARE };
    })
    .toArray();
  const windows = clockWindows(
    cameras.flatMap(({ gps, isReference }) =>
      isReference
        ? gps.map(({ time, latitude, longitude }) => ({ time, latitude: latitude!, longitude: longitude! }))
        : [],
    ),
  );
  return cameras
    .map(({ list, gps, isReference }): ClockCamera => {
      const [{ make, model, isVideo }] = list;
      const found =
        kind !== TripKind.Places && !isReference && list.length >= MIN_ASSETS && windows.length > 0
          ? suggestOffset(
              list.map(({ time }) => time),
              windows,
            )
          : null;
      return {
        make,
        model,
        isVideo,
        assetCount: list.length,
        gpsCount: gps.length,
        isReference,
        ownAssetIds: list.filter(({ ownerId }) => ownerId === userId).map(({ id }) => id),
        suggestion: found?.isSuggested
          ? { offsetMinutes: found.offsetMinutes, current: found.current, best: found.best }
          : null,
      };
    })
    .toSorted((a, b) => b.assetCount - a.assetCount);
};
