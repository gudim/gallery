import { describe, expect, it } from 'vitest';
import { TripStopRole } from 'src/trips/enum.js';
import {
  type Shot,
  type TransitStop,
  daySections,
  inferPlacePoints,
  inferRoutePoints,
  placeGroups,
  routeGroups,
  transitSuggestions,
} from 'src/trips/utils/grouping.js';

const T0 = Date.UTC(2026, 7, 1, 10, 0);
const at = (minutes: number) => new Date(T0 + minutes * 60_000);
const point = (latitude: number, longitude: number) => ({ latitude, longitude });
const labels = <T extends { label: string }>(groups: Array<{ items: T[] }>) =>
  groups.map(({ items }) => items.map(({ label }) => label));

// ~300 m along a meridian
const S = 0.0027;
const P1 = point(52.2297, 21.0122);
const FAR = point(P1.latitude + 0.045, P1.longitude); // ~5 km

const shot = (minutes: number, anchor: ReturnType<typeof point> | null = null): Shot => ({
  time: at(minutes),
  anchor,
});
const p = (latitude: number, label: string) => ({ latitude, longitude: 21, label });
const place = (id: string, latitude: number, count: number, isFixed = false) => ({
  id,
  latitude,
  longitude: 21,
  count,
  isFixed,
});
const item = (time: string | null, label: string) => ({ time: time ? new Date(`${time}Z`) : null, label });
const stop = (id: string, minutes: number, latitude: number | null, overrides: Partial<TransitStop> = {}) => ({
  id,
  role: null,
  isAddedByHand: false,
  isTransit: null,
  start: at(minutes),
  end: at(minutes),
  latitude,
  longitude: latitude === null ? null : 21,
  ...overrides,
});

describe('routeGroups', () => {
  it('splits by 400 m from the running mean and by 90 min since the last point', () => {
    const points = [
      { time: at(0), ...point(52, 21) },
      { time: at(10), ...point(52.002, 21) }, // 222 m: same group
      { time: at(100), ...point(52.002, 21) }, // 90 min after the last point: still the same
      { time: at(191), ...point(52.002, 21) }, // 91 min: new
      { time: at(192), ...point(52.01, 21) }, // ~890 m: new
    ];
    const groups = routeGroups(points);
    expect(groups.map(({ items }) => items.length)).toEqual([3, 1, 1]);
    expect(groups[0].latitude).toBeCloseTo((52 + 52.002 * 2) / 3, 9);
    expect(groups[0].longitude).toBeCloseTo(21, 9);
  });
});

describe('inferRoutePoints', () => {
  it('copies the nearest anchor at the ends and interpolates between anchors by time', () => {
    const shots = [
      shot(-60),
      shot(0, point(52, 21)),
      shot(5),
      shot(10, point(52.1, 21.1)),
      shot(120, point(52.2, 21.2)),
      shot(120), // a zero span takes the middle
      shot(120, point(52.4, 21.4)),
      shot(180),
    ];
    const points = inferRoutePoints(shots);
    expect(points[0]).toEqual(point(52, 21));
    expect(points[1]).toEqual(point(52, 21));
    expect(points[2]!.latitude).toBeCloseTo(52.05, 9);
    expect(points[2]!.longitude).toBeCloseTo(21.05, 9);
    expect(points[5]!.latitude).toBeCloseTo(52.3, 9);
    expect(points[7]).toEqual(point(52.4, 21.4));
  });

  it('puts every shot at the start without anchors, and nowhere without a start', () => {
    const start = point(54.68, 25.28);
    expect(inferRoutePoints([shot(0), shot(5)], start)).toEqual([start, start]);
    expect(inferRoutePoints([shot(0)])).toEqual([null]);
    expect(inferRoutePoints([])).toEqual([]);
  });
});

describe('inferPlacePoints', () => {
  it('takes the nearest anchor of the walk and never crosses a gap over 90 min', () => {
    const shots: Shot[] = [
      { time: at(0), anchor: P1 },
      { time: at(50), anchor: null }, // nearer to the next anchor
      { time: at(90), anchor: FAR },
      { time: at(240), anchor: null }, // 150 min later: a walk of its own, without anchors
      { time: at(270), anchor: null },
    ];
    expect(inferPlacePoints(shots)).toEqual([P1, FAR, FAR, null, null]);
  });

  it('takes the earlier anchor on a tie', () => {
    const shots: Shot[] = [
      { time: at(0), anchor: P1 },
      { time: at(30), anchor: null },
      { time: at(60), anchor: FAR },
    ];
    expect(inferPlacePoints(shots)[1]).toEqual(P1);
  });
});

describe('placeGroups', () => {
  it('groups by distance only', () => {
    const groups = placeGroups([p(52, 'a'), p(52.1, 'b'), p(52 + S, 'c'), p(52.1, 'd')]);
    expect(labels(groups)).toEqual([
      ['a', 'c'],
      ['b', 'd'],
    ]);
    expect(groups[0].latitude).toBeCloseTo(52 + S / 2, 9);
    expect(groups.map(({ id }) => id)).toEqual([null, null]);
  });

  it('moves a point to the nearest final place on the second pass', () => {
    // b joined the first place while its centre was near; c pulled the centre back, and d, opened later, is nearer b
    const points = [p(52, 'a'), p(52 + S, 'b'), p(52 - 0.8 * S, 'c'), p(52 + 1.9 * S, 'd')];
    expect(labels(placeGroups(points))).toEqual([
      ['a', 'c'],
      ['b', 'd'],
    ]);
  });

  it('merges centres that end up closer than 400 m', () => {
    // b opened a second place, then c and d pulled the first centre to within 280 m of it
    const points = [p(52, 'a'), p(52 + 1.4 * S, 'b'), p(52 + 0.6 * S, 'c'), p(52 + 0.8 * S, 'd')];
    const groups = placeGroups(points);
    expect(labels(groups)).toEqual([['a', 'b', 'c', 'd']]);
    expect(groups[0].latitude).toBeCloseTo(52 + 0.7 * S, 9);
  });

  it('keeps close existing places apart, and returns those without new points', () => {
    const groups = placeGroups([p(52.001, 'a')], [place('7', 52, 3), place('8', 52.0027, 2)]);
    expect(groups.map(({ id, items }) => [id, items.map(({ label }) => label)])).toEqual([
      ['7', ['a']],
      ['8', []],
    ]);
  });

  it("keeps a fixed place's centre", () => {
    const groups = placeGroups([p(52.001, 'a'), p(53, 'b')], [place('7', 52, 3, true)]);
    expect(groups.map(({ id, items }) => [id, items.map(({ label }) => label)])).toEqual([
      ['7', ['a']],
      [null, ['b']],
    ]);
    expect([groups[0].latitude, groups[0].longitude]).toEqual([52, 21]);
  });

  it("weighs an existing place's earlier points in its centre", () => {
    const [group] = placeGroups([p(52.001, 'a')], [place('7', 52, 3)]);
    expect(group.latitude).toBeCloseTo((52 * 3 + 52.001) / 4, 9);
  });
});

describe('daySections', () => {
  it('makes one section per calendar day, undated last', () => {
    const items = [
      item('2021-05-01T23:50:00', 'a'),
      item('2021-05-02T00:10:00', 'b'),
      item('2021-05-02T18:00:00', 'c'),
      item('2021-05-03T10:00:00', 'e'),
      item(null, 'd'),
    ];
    const sections = daySections(items);
    expect(labels(sections)).toEqual([['a'], ['b', 'c'], ['e'], ['d']]);
    expect(sections.map(({ id }) => id)).toEqual([null, null, null, null]);
  });

  it('files into an existing section whose days cover the item', () => {
    const existing = [
      { id: '1', start: new Date('2021-05-01T10:00:00Z'), end: new Date('2021-05-02T09:00:00Z') },
      { id: '2', start: null, end: null },
    ];
    const items = [item('2021-05-02T21:00:00', 'same'), item('2021-05-04T09:00:00', 'later'), item(null, 'undated')];
    expect(daySections(items, existing).map(({ id, items }) => [id, items.map(({ label }) => label)])).toEqual([
      ['1', ['same']],
      [null, ['later']],
      ['2', ['undated']],
    ]);
  });
});

describe('transitSuggestions', () => {
  // one degree of latitude is ~111 km, so 1° in 20 min is ~333 km/h
  it('groups neighbours fast on both sides and reports the top speed', () => {
    const stops = [stop('home', 0, 50), stop('air1', 20, 51), stop('air2', 40, 52), stop('away', 60, 53)];
    expect(transitSuggestions(stops, new Set())).toEqual([{ stopIds: ['air1', 'air2'], kmh: 334 }]);
  });

  it('skips the airport of departure, fast on one side only', () => {
    const stops = [stop('home', 0, 50), stop('airport', 600, 50.001), stop('air', 620, 51), stop('away', 640, 52)];
    expect(transitSuggestions(stops, new Set())).toEqual([{ stopIds: ['air'], kmh: 334 }]);
  });

  it('suggests a blind stop between neighbours at least 100 km apart', () => {
    const stops = [stop('home', 0, 50), stop('under', 600, 50.5), stop('away', 1200, 51)];
    expect(transitSuggestions(stops, new Set(['under']))).toEqual([{ stopIds: ['under'], kmh: null }]);
    expect(transitSuggestions(stops, new Set())).toEqual([]);
  });

  it('leaves out the ends, decided stops, stops added by hand, the start and finish, and undated stops', () => {
    const cases: Array<Partial<TransitStop>> = [
      { isTransit: false },
      { isTransit: true },
      { isAddedByHand: true },
      { role: TripStopRole.Start },
      { start: null, end: null },
    ];
    for (const overrides of cases) {
      const stops = [stop('a', 0, 50), stop('b', 20, 51, overrides), stop('c', 40, 52)];
      expect(transitSuggestions(stops, new Set(['b']))).toEqual([]);
    }
    expect(transitSuggestions([stop('a', 0, 50), stop('b', 20, 51)], new Set(['a', 'b']))).toEqual([]);
  });

  it('counts a side it cannot measure as slow', () => {
    const stops = [stop('a', 0, null), stop('b', 20, 51), stop('c', 40, 52)];
    expect(transitSuggestions(stops, new Set())).toEqual([]);
  });
});
