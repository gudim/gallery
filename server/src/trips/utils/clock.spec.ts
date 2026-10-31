import { describe, expect, it } from 'vitest';
import { TripKind } from 'src/trips/enum.js';
import {
  type ClockAsset,
  RANGE_MIN,
  clockCameras,
  clockWindows,
  pickOffset,
  suggestOffset,
} from 'src/trips/utils/clock.js';

const T0 = Date.parse('2026-08-01T10:00:00Z');
const at = (minutes: number) => new Date(T0 + minutes * 60_000);
const P1 = { latitude: 52, longitude: 21 };
const P2 = { latitude: 50, longitude: 20 };

describe(clockWindows.name, () => {
  it('pads each stop of the GPS assets by 5 min and merges windows that overlap', () => {
    expect(
      clockWindows([
        { time: at(0), ...P1 },
        { time: at(20), ...P1 },
        { time: at(26), ...P2 }, // another place, its window overlaps
        { time: at(300), ...P2 },
      ]),
    ).toEqual([
      [T0 - 5 * 60_000, T0 + 31 * 60_000],
      [T0 + 295 * 60_000, T0 + 305 * 60_000],
    ]);
  });
});

// Scores of 5 over the runs of minutes given, 0 elsewhere.
const counts = (...runs: Array<[number, number]>) => {
  const scores = Array.from({ length: 2 * RANGE_MIN + 1 }, () => 0);
  for (const [lo, hi] of runs) {
    for (let minute = lo; minute <= hi; minute++) {
      scores[minute + RANGE_MIN] = 5;
    }
  }
  return scores;
};

describe(pickOffset.name, () => {
  it('takes the middle of the best run, of several runs the one nearest zero', () => {
    expect(pickOffset(counts([-44, -34]))).toBe(-39);
    expect(pickOffset(counts([-44, -34], [20, 30]))).toBe(25);
    expect(pickOffset(counts([-3, 0]))).toBe(-1); // the middle −1.5 rounds towards zero
    expect(pickOffset(counts())).toBe(0);
  });
});

describe(suggestOffset.name, () => {
  // A phone with GPS at three stops of a day; a camera 39 min fast shot at the same stops.
  const phone = [0, 10, 120, 130, 300, 310].map((minute, i) => ({ time: at(minute), ...(i < 2 ? P1 : P2) }));
  const camera = [2, 5, 8, 122, 125, 128, 302, 305, 308, 309].map((minute) => at(minute + 39));

  it('finds a camera 39 min fast', () => {
    const suggestion = suggestOffset(camera, clockWindows(phone));
    expect(suggestion).toMatchObject({ current: 0, best: 1, isSuggested: true });
    expect(Math.abs(suggestion.offsetMinutes + 39)).toBeLessThanOrEqual(1);
  });

  it('suggests nothing to a camera already right', () => {
    expect(
      suggestOffset(
        camera.map((time) => new Date(time.getTime() - 39 * 60_000)),
        clockWindows(phone),
      ),
    ).toMatchObject({ offsetMinutes: 0, isSuggested: false });
  });
});

describe(clockCameras.name, () => {
  const asset = (
    id: string,
    minute: number,
    camera: Partial<ClockAsset> = {},
    point: typeof P1 | null = null,
  ): ClockAsset => ({
    id,
    ownerId: 'me',
    make: 'Canon',
    model: 'EOS',
    isVideo: false,
    time: at(minute),
    latitude: point?.latitude ?? null,
    longitude: point?.longitude ?? null,
    ...camera,
  });
  const phone = (id: string, minute: number, point: typeof P1) =>
    asset(id, minute, { make: 'Google', model: 'Pixel' }, point);
  const canon = (count: number, offset: number, ownerId = 'me') =>
    Array.from({ length: count }, (_, i) =>
      asset(`${ownerId}-c${i}`, [3, 5, 7, 120, 300][i % 5] + offset, { ownerId }),
    );
  const phones = [phone('p0', 0, P1), phone('p1', 10, P1), phone('p2', 120, P2), phone('p3', 300, P1)];

  it('counts cameras by make, model and video, the reference by its GPS share, and suggests a shift', () => {
    const cameras = clockCameras([...phones, ...canon(10, 39), asset('v', 0, { isVideo: true })], 'me', TripKind.Route);
    expect(
      cameras.map(({ make, model, isVideo, assetCount, gpsCount, isReference }) => [
        make,
        model,
        isVideo,
        assetCount,
        gpsCount,
        isReference,
      ]),
    ).toEqual([
      ['Canon', 'EOS', false, 10, 0, false],
      ['Google', 'Pixel', false, 4, 4, true],
      ['Canon', 'EOS', true, 1, 0, false],
    ]);
    expect(Math.abs(cameras[0].suggestion!.offsetMinutes + 39)).toBeLessThanOrEqual(1);
    expect(cameras[2].suggestion).toBeNull(); // fewer than 10 assets
  });

  it('lists only the caller’s assets to shift', () => {
    const cameras = clockCameras([...phones, ...canon(5, 39), ...canon(5, 39, 'other')], 'me', TripKind.Route);
    expect(cameras[0]).toMatchObject({ assetCount: 10, ownAssetIds: ['me-c0', 'me-c1', 'me-c2', 'me-c3', 'me-c4'] });
  });

  it('suggests no shift on a Places trip', () => {
    expect(clockCameras([...phones, ...canon(10, 39)], 'me', TripKind.Places)[0].suggestion).toBeNull();
  });
});
