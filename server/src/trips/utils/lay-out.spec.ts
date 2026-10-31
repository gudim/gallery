import { describe, expect, it } from 'vitest';
import { TripKind, TripLegMode } from 'src/trips/enum.js';
import { haversineM } from 'src/trips/utils/geo.js';
import { type LayoutAsset, layOutTrip, routeLegs } from 'src/trips/utils/lay-out.js';

const P1 = { latitude: 52.2297, longitude: 21.0122 };
const NEAR = { latitude: P1.latitude + 0.0009, longitude: P1.longitude }; // ~100 m
const FAR = { latitude: P1.latitude + 0.045, longitude: P1.longitude }; // ~5 km
const HOME = { latitude: 54.68, longitude: 25.28 };

const asset = (id: string, time: string, point: typeof P1 | null = null): LayoutAsset => ({
  id,
  time: new Date(time.length === 5 ? `2026-08-01T${time}:00Z` : `${time}Z`),
  latitude: point?.latitude ?? null,
  longitude: point?.longitude ?? null,
});

const filing = (layout: ReturnType<typeof layOutTrip>) =>
  Object.fromEntries(layout.assets.map(({ assetId, stopIndex }) => [assetId, stopIndex]));

describe('layOutTrip', () => {
  it('builds route stops by 400 m and 90 min, centred on their assets', () => {
    const assets = [
      asset('a', '10:00', P1),
      asset('b', '10:10', NEAR),
      asset('c', '10:20', FAR),
      asset('d', '12:30', P1),
    ];
    const { stops, assets: filed } = layOutTrip(TripKind.Route, assets);
    expect(stops.map(({ start, end }) => [start.toISOString().slice(11, 16), end.toISOString().slice(11, 16)])).toEqual(
      [
        ['10:00', '10:10'],
        ['10:20', '10:20'],
        ['12:30', '12:30'],
      ],
    );
    expect(stops[0].latitude).toBe(Math.round(((P1.latitude + NEAR.latitude) / 2) * 1e6) / 1e6);
    expect(filing({ stops, assets: filed })).toEqual({ a: 0, b: 0, c: 1, d: 2 });
    expect(filed.every(({ point }) => point === null)).toBe(true);
  });

  it('infers the points of route assets without GPS and files them by those', () => {
    const { stops, assets } = layOutTrip(TripKind.Route, [
      asset('a', '10:00', P1),
      asset('x', '10:05'),
      asset('b', '10:10', P1),
    ]);
    expect(stops).toHaveLength(1);
    expect(assets[1]).toEqual({ assetId: 'x', stopIndex: 0, point: P1 });
  });

  it('puts a route without any GPS at the start, and leaves it Unplaced without one', () => {
    const assets = [asset('a', '10:00'), asset('b', '10:30')];
    const atStart = layOutTrip(TripKind.Route, assets, HOME);
    expect(atStart.stops).toEqual([expect.objectContaining({ index: 0, ...HOME })]);
    expect(atStart.assets.map(({ point }) => point)).toEqual([HOME, HOME]);

    const nowhere = layOutTrip(TripKind.Route, assets);
    expect(nowhere).toEqual({
      stops: [],
      assets: [
        { assetId: 'a', stopIndex: null, point: null },
        { assetId: 'b', stopIndex: null, point: null },
      ],
    });
  });

  it('makes visits years apart one place and walks assets without GPS to the nearest anchor', () => {
    const assets = [
      asset('a', '2021-05-01T10:00:00', P1),
      asset('walked', '2021-05-01T10:50:00'),
      asset('b', '2021-05-01T11:30:00', FAR),
      asset('alone', '2021-05-01T14:00:00'),
      asset('c', '2022-06-01T15:00:00', NEAR),
    ];
    const layout = layOutTrip(TripKind.Places, assets, HOME);
    expect(filing(layout)).toEqual({ a: 0, c: 0, walked: 1, b: 1, alone: null });
    expect(layout.assets.find(({ assetId }) => assetId === 'walked')!.point).toEqual(FAR);
    expect(layout.stops[0].end.toISOString()).toBe('2022-06-01T15:00:00.000Z');
  });

  it('sections a plain trip by day without points', () => {
    const assets = [
      asset('a', '2021-05-01T23:50:00', P1),
      asset('b', '2021-05-02T00:10:00', P1),
      asset('c', '2021-05-02T18:00:00'),
    ];
    const layout = layOutTrip(TripKind.Plain, assets);
    expect(filing(layout)).toEqual({ a: 0, b: 1, c: 1 });
    expect(layout.stops.map(({ latitude, longitude }) => [latitude, longitude])).toEqual([
      [null, null],
      [null, null],
    ]);
    expect(layout.assets.every(({ point }) => point === null)).toBe(true);
  });
});

describe('routeLegs', () => {
  it('walks short legs and drives long ones or those without a point', () => {
    const stops = [{ ...HOME }, { ...P1 }, { ...NEAR }, { latitude: null, longitude: null }];
    expect(haversineM(HOME, P1)).toBeGreaterThan(2000);
    expect(routeLegs(stops).map(({ mode }) => mode)).toEqual([
      TripLegMode.Driving,
      TripLegMode.Foot,
      TripLegMode.Driving,
    ]);
    expect(routeLegs([stops[0]])).toEqual([]);
  });
});
