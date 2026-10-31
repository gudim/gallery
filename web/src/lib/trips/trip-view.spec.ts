import {
  AssetTypeEnum,
  TripKind,
  TripLegMode,
  TripLegStatus,
  TripStopRole,
  type AssetResponseDto,
  type TripLegDto,
  type TripResponseDto,
  type TripStopDto,
} from '@immich/sdk';
import { buildTripView, decodePolyline, inkOn, timeSpan, transitFraction, tripStats } from '$lib/trips/trip-view';

const stop = (id: string, overrides: Partial<TripStopDto> = {}): TripStopDto => ({
  id,
  placeId: null,
  latitude: 54.68,
  longitude: 25.28,
  isPositionManual: false,
  sequence: 0,
  title: id,
  titleSource: null,
  story: null,
  storySource: null,
  region: null,
  country: 'Lithuania',
  isAddedByHand: false,
  role: null,
  isFinishAtStart: false,
  isTransit: null,
  isAtCenter: false,
  localStart: null,
  localEnd: null,
  ...overrides,
});

const leg = (id: string, fromStopId: string, toStopId: string, overrides: Partial<TripLegDto> = {}): TripLegDto => ({
  id,
  fromStopId,
  toStopId,
  mode: TripLegMode.Driving,
  isModeManual: false,
  status: TripLegStatus.Ok,
  // (38.5, -120.2) → (38.501, -120.2), at precision 6
  polyline: '_izlhA~rlgdFo}@?',
  distance: 1000,
  duration: 60,
  departureName: null,
  departureLatitude: null,
  departureLongitude: null,
  arrivalName: null,
  arrivalLatitude: null,
  arrivalLongitude: null,
  ...overrides,
});

const asset = (id: string, localDateTime: string, type = AssetTypeEnum.Image) =>
  ({ id, localDateTime, type, exifInfo: { latitude: 1, longitude: 2 } }) as AssetResponseDto;

// Start, day one: A, shot on the way, B; day two: C; finish. D has no assets.
const trip = (): TripResponseDto => ({
  albumId: 'album',
  kind: TripKind.Route,
  isFavorites: false,
  isShowcased: false,
  isFeatured: false,
  contentVersion: 1,
  places: [{ id: 'p', key: 'p', title: null, article: 'An article', articleSource: null }],
  stops: [
    stop('start', { role: TripStopRole.Start }),
    stop('a', {
      localStart: '2026-08-08T10:00:00.000Z',
      localEnd: '2026-08-08T11:00:00.000Z',
      region: 'Vilnius',
      placeId: 'p',
    }),
    stop('way', { localStart: '2026-08-08T12:00:00.000Z', isTransit: true }),
    stop('b', { localStart: '2026-08-08T14:00:00.000Z', localEnd: '2026-08-08T14:00:00.000Z', region: 'Biržai' }),
    stop('c', { localStart: '2026-08-09T09:00:00.000Z', region: 'Riga', country: 'Latvia' }),
    stop('d', { localStart: '2026-08-09T12:00:00.000Z' }),
    stop('finish', { role: TripStopRole.Finish }),
  ],
  assets: [
    { assetId: 'a1', stopId: 'a', latitude: null, longitude: null, pointSource: null },
    { assetId: 'a2', stopId: 'a', latitude: 5, longitude: 6, pointSource: 'inferred' as never },
    { assetId: 'w1', stopId: 'way', latitude: null, longitude: null, pointSource: null },
    { assetId: 'b1', stopId: 'b', latitude: null, longitude: null, pointSource: null },
    { assetId: 'c1', stopId: 'c', latitude: null, longitude: null, pointSource: null },
  ],
  legs: [
    leg('l1', 'start', 'a', { mode: TripLegMode.Foot }),
    leg('l2', 'a', 'b'),
    leg('l3', 'b', 'c', { polyline: null, distance: 2500 }),
    leg('l4', 'c', 'finish'),
  ],
  overlays: [],
  likes: [{ assetId: 'b1', count: 3, isLiked: true }],
});

const assets = [
  asset('a1', '2026-08-08T10:05:00.000Z'),
  asset('a2', '2026-08-08T10:50:00.000Z', AssetTypeEnum.Video),
  asset('w1', '2026-08-08T13:00:00.000Z'),
  asset('b1', '2026-08-08T14:00:00.000Z'),
  asset('c1', '2026-08-09T09:30:00.000Z'),
];

describe('buildTripView', () => {
  it('splits a route into days, numbers stops with assets and orders transit after its stop', () => {
    const view = buildTripView(trip(), assets);

    expect(view.days.map(({ date, color, count, regions }) => ({ date, color, count, regions }))).toEqual([
      { date: '2026-08-08', color: '#e6394a', count: 4, regions: ['Vilnius', 'Biržai'] },
      { date: '2026-08-09', color: '#f2792b', count: 1, regions: ['Riga'] },
    ]);
    expect(view.stops.map(({ id, number, day, t0, t1 }) => ({ id, number, day, t0, t1 }))).toEqual([
      { id: 'start', number: undefined, day: 0, t0: '—', t1: '—' },
      { id: 'a', number: 1, day: 0, t0: '10:00', t1: '11:00' },
      { id: 'b', number: 2, day: 0, t0: '14:00', t1: '14:00' },
      { id: 'c', number: 3, day: 1, t0: '09:00', t1: '09:00' },
      { id: 'd', number: undefined, day: 1, t0: '12:00', t1: '12:00' },
      { id: 'finish', number: undefined, day: 1, t0: '—', t1: '—' },
    ]);
    expect(view.order.map(({ id }) => id)).toEqual(['a', 'way', 'b', 'c']);
    expect(view.photos.map(({ id }) => id)).toEqual(['a1', 'a2', 'w1', 'b1', 'c1']);
    expect(view.isMultiCountry).toBe(true);
    expect(view.stops[1].article).toBe('An article');
  });

  it('puts assets shot on the way on the leg between the stops around them', () => {
    const [way] = buildTripView(trip(), assets).transit;

    expect(way).toMatchObject({ fromStopId: 'a', toStopId: 'b', stopIds: ['way'], day: 0, t0: '13:00' });
    // 13:00 between the end of A (11:00) and the start of B (14:00)
    expect(way.fraction).toBe(0.667);
  });

  it('draws legs with a line, counts every leg in km and carries likes and points', () => {
    const view = buildTripView(trip(), assets);

    expect(view.legs.map(({ id, day }) => ({ id, day }))).toEqual([
      { id: 'l1', day: 0 },
      { id: 'l2', day: 0 },
      { id: 'l4', day: 1 },
    ]);
    expect(view.km).toBe(6);
    expect(tripStats(view)).toEqual({ assets: 5, videos: 1, stops: 3, days: 2, km: 6 });
    const [a1, a2, , b1] = view.photos;
    expect(a1).toMatchObject({ latitude: 1, longitude: 2, isInferred: false, time: '10:05', likes: 0 });
    expect(a2).toMatchObject({ latitude: 5, longitude: 6, isInferred: true, isVideo: true });
    expect(b1).toMatchObject({ likes: 3, isLiked: true });
  });

  it('skips trip assets the caller cannot see', () => {
    const view = buildTripView(trip(), assets.slice(1));

    expect(view.stops[1].photos.map(({ id }) => id)).toEqual(['a2']);
  });

  it('gives a Places trip no days or legs, and keeps its unplaced assets', () => {
    const places = { ...trip(), kind: TripKind.Places, legs: [] };
    places.stops = places.stops.filter(({ role, isTransit }) => !role && !isTransit);
    places.assets.push({ assetId: 'w1', stopId: null, latitude: null, longitude: null, pointSource: null });
    places.assets = places.assets.filter(({ assetId, stopId }) => assetId !== 'w1' || stopId === null);

    const view = buildTripView(places, assets);

    expect(view.days).toEqual([]);
    expect(view.legs).toEqual([]);
    expect(view.km).toBeNull();
    expect(view.unplaced?.photos.map(({ id }) => id)).toEqual(['w1']);
    expect(view.order.at(-1)?.type).toBe('unplaced');
  });
});

describe('helpers', () => {
  it('decodes an encoded polyline', () => {
    expect(decodePolyline('_izlhA~rlgdF')).toEqual([[38.5, -120.2]]);
    expect(decodePolyline('_p~iF~ps|U_ulLnnqC_mqNvxq`@', 5)).toEqual([
      [38.5, -120.2],
      [40.7, -120.95],
      [43.252, -126.453],
    ]);
  });

  it('places transit in the middle when times are missing', () => {
    expect(transitFraction(stop('x'), stop('y'), [])).toBe(0.5);
  });

  it('picks text colour and time spans', () => {
    expect(inkOn('#5c6bc0')).toBe('#fff');
    expect(inkOn('#e8b32c')).toBe('#000');
    expect(timeSpan({ t0: '10:00', t1: '10:00' })).toBe('10:00');
    expect(timeSpan({ t0: '10:00', t1: '11:00' })).toBe('10:00–11:00');
  });
});
