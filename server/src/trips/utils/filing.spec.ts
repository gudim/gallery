import { describe, expect, it } from 'vitest';
import { TripKind, TripLegMode } from 'src/trips/enum.js';
import { type FilingAsset, type FilingStop, fileAssets, syncLegs } from 'src/trips/utils/filing.js';

const P1 = { latitude: 52.2297, longitude: 21.0122 };
const NEAR = { latitude: P1.latitude + 0.0009, longitude: P1.longitude }; // ~100 m
const FAR = { latitude: P1.latitude + 0.045, longitude: P1.longitude }; // ~5 km

const at = (time: string) => new Date(time.length === 5 ? `2026-08-01T${time}:00Z` : `${time}Z`);
const asset = (id: string, time: string, anchor: typeof P1 | null, isNew = true): FilingAsset => ({
  id,
  time: at(time),
  anchor,
  isNew,
});
const stop = (
  id: string,
  point: typeof P1 | null,
  start: string,
  end: string,
  count: number,
  isPositionManual = false,
) => ({
  id,
  latitude: point?.latitude ?? null,
  longitude: point?.longitude ?? null,
  start: at(start),
  end: at(end),
  count,
  isPositionManual,
});
const counter = () => {
  let n = 0;
  return () => `new${++n}`;
};
const placed = ({ assets }: ReturnType<typeof fileAssets>) =>
  Object.fromEntries(assets.map(({ assetId, stopId }) => [assetId, stopId]));

describe('fileAssets', () => {
  it('files a route asset into the stop nearest in time within 90 min and 400 m, or opens a new stop', () => {
    const stops: FilingStop[] = [stop('s1', P1, '10:00', '10:30', 2), stop('s2', P1, '12:05', '12:30', 2)];
    const assets = [
      asset('a', '10:00', P1, false),
      asset('b', '10:30', P1, false),
      asset('inside', '10:40', NEAR),
      asset('far', '11:00', FAR),
      asset('between', '11:40', P1), // 70 min after s1, 25 min before s2
      asset('c', '12:05', P1, false),
      asset('d', '12:30', P1, false),
    ];

    const filing = fileAssets(TripKind.Route, stops, assets, { newId: counter() });

    expect(placed(filing)).toEqual({ inside: 's1', far: 'new1', between: 's2' });
    const s1 = filing.stops.find(({ id }) => id === 's1')!;
    expect(s1.end).toEqual(at('10:40'));
    expect(s1.latitude).toBe(Math.round(((2 * P1.latitude + NEAR.latitude) / 3) * 1e6) / 1e6);
    expect(filing.stops.find(({ id }) => id === 'new1')).toMatchObject({ ...FAR, start: at('11:00'), isNew: true });
    expect(filing.stops.find(({ id }) => id === 's2')!.start).toEqual(at('11:40'));
  });

  it('keeps a moved pin, and leaves stops that took nothing out', () => {
    const stops = [stop('pinned', P1, '10:00', '10:00', 1, true), stop('idle', FAR, '18:00', '18:00', 1)];
    const filing = fileAssets(TripKind.Route, stops, [asset('a', '10:10', NEAR)], { newId: counter() });
    expect(filing.stops).toEqual([expect.objectContaining({ id: 'pinned', ...P1, end: at('10:10') })]);
  });

  it('infers the point of a route asset without GPS from its neighbours and files it by that', () => {
    const stops = [stop('s1', P1, '10:00', '10:30', 2)];
    const assets = [asset('a', '10:00', P1, false), asset('x', '10:15', null), asset('b', '10:30', P1, false)];
    const filing = fileAssets(TripKind.Route, stops, assets, { newId: counter() });
    expect(filing.assets).toEqual([{ assetId: 'x', stopId: 's1', point: P1 }]);
  });

  it('leaves a route asset without any point Unplaced', () => {
    const filing = fileAssets(TripKind.Route, [], [asset('x', '10:15', null)], { newId: counter() });
    expect(filing).toEqual({ stops: [], assets: [{ assetId: 'x', stopId: null, point: null }] });
  });

  it('files a new visit years later into an existing place', () => {
    const stops = [stop('p', P1, '2021-05-01T10:00:00', '2021-05-01T10:00:00', 1)];
    const assets = [
      asset('a', '2021-05-01T10:00:00', P1, false),
      asset('b', '2024-01-01T09:00:00', NEAR),
      asset('far', '2024-01-01T09:05:00', FAR),
    ];
    const filing = fileAssets(TripKind.Places, stops, assets, { newId: counter() });
    expect(placed(filing)).toEqual({ b: 'p', far: 'new1' });
    expect(filing.stops.find(({ id }) => id === 'p')).toMatchObject({
      latitude: Math.round(((P1.latitude + NEAR.latitude) / 2) * 1e6) / 1e6,
      start: at('2021-05-01T10:00:00'),
      end: at('2024-01-01T09:00:00'),
      count: 2,
    });
  });

  it('files a plain asset into the section whose days cover it, or a new day', () => {
    const stops = [{ ...stop('day', null, '2021-05-01T10:00:00', '2021-05-02T09:00:00', 1) }];
    const assets = [
      asset('a', '2021-05-01T10:00:00', null, false),
      asset('same', '2021-05-02T21:00:00', P1),
      asset('later', '2021-05-04T09:00:00', null),
    ];
    const filing = fileAssets(TripKind.Plain, stops, assets, { newId: counter() });
    expect(placed(filing)).toEqual({ same: 'day', later: 'new1' });
    expect(filing.assets.every(({ point }) => point === null)).toBe(true);
    expect(filing.stops.find(({ id }) => id === 'day')!.end).toEqual(at('2021-05-02T21:00:00'));
  });
});

const legStop = (id: string, point: typeof P1 | null = P1, isTransit: boolean | null = null) => ({
  id,
  latitude: point?.latitude ?? null,
  longitude: point?.longitude ?? null,
  isTransit,
});
const leg = (id: string, fromStopId: string, toStopId: string, mode = TripLegMode.Driving, isModeManual = false) => ({
  id,
  fromStopId,
  toStopId,
  mode,
  isModeManual,
});

describe('syncLegs', () => {
  it('splits a leg around a new stop, which inherits the mode the owner set', () => {
    const result = syncLegs(
      [legStop('s1'), legStop('new', FAR), legStop('s2')],
      [leg('l', 's1', 's2', TripLegMode.Foot, true)],
    );
    expect(result).toEqual({
      removedIds: ['l'],
      added: [
        { fromStopId: 's1', toStopId: 'new', mode: TripLegMode.Foot, isModeManual: true },
        { fromStopId: 'new', toStopId: 's2', mode: TripLegMode.Foot, isModeManual: true },
      ],
    });
  });

  it('keeps legs that still join neighbours, and picks the default mode for new pairs', () => {
    const result = syncLegs(
      [legStop('s1'), legStop('s2', NEAR), legStop('s3', FAR), legStop('s4', null)],
      [leg('l', 's1', 's2')],
    );
    expect(result).toEqual({
      removedIds: [],
      added: [
        { fromStopId: 's2', toStopId: 's3', mode: TripLegMode.Driving, isModeManual: false },
        { fromStopId: 's3', toStopId: 's4', mode: TripLegMode.Driving, isModeManual: false },
      ],
    });
  });

  it('runs a leg across a transit stop', () => {
    const result = syncLegs(
      [legStop('s1'), legStop('air', FAR, true), legStop('s2', NEAR)],
      [leg('l', 's1', 'air'), leg('m', 'air', 's2')],
    );
    expect(result).toEqual({
      removedIds: ['l', 'm'],
      added: [{ fromStopId: 's1', toStopId: 's2', mode: TripLegMode.Foot, isModeManual: false }],
    });
  });
});
