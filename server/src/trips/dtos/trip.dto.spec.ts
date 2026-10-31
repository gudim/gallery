import { describe, expect, it } from 'vitest';
import { TripCreateDto, TripImportDto } from 'src/trips/dtos/trip.dto.js';

const assetId = '6f9619ff-8b86-4011-b42d-00c04fc964ff';

const stop = (key: string, overrides: Record<string, unknown> = {}) => ({
  key,
  placeKey: null,
  latitude: null,
  longitude: null,
  isPositionManual: false,
  localStart: null,
  localEnd: null,
  sequence: 0,
  title: null,
  titleSource: null,
  story: null,
  storySource: null,
  region: null,
  country: null,
  isAddedByHand: false,
  role: null,
  isFinishAtStart: false,
  isTransit: null,
  isAtCenter: false,
  ...overrides,
});

const issues = (document: object) => {
  const result = TripImportDto.schema.safeParse(document);
  return result.success ? [] : result.error.issues.map(({ message }) => message);
};

const parseStart = (localStart: string) =>
  TripImportDto.schema.safeParse({ kind: 'route', stops: [stop('a', { localStart })] });

describe('TripImportDto', () => {
  it('accepts a bare trip and fills the defaults', () => {
    expect(TripImportDto.schema.parse({ kind: 'plain' })).toEqual({
      kind: 'plain',
      isFavorites: false,
      isShowcased: false,
      language: null,
      places: [],
      stops: [],
      assets: [],
      legs: [],
      overlays: [],
      likes: [],
    });
  });

  it('refuses duplicate keys and references to unknown keys', () => {
    expect(
      issues({
        kind: 'route',
        stops: [stop('a', { placeKey: 'nowhere' }), stop('a')],
        assets: [{ assetId, stopKey: 'b', latitude: null, longitude: null, pointSource: null }],
        legs: [
          {
            fromStopKey: 'a',
            toStopKey: 'c',
            mode: 'foot',
            isModeManual: false,
            status: 'ok',
            polyline: null,
            distance: null,
            duration: null,
            departureName: null,
            departureLatitude: null,
            departureLongitude: null,
            arrivalName: null,
            arrivalLatitude: null,
            arrivalLongitude: null,
          },
        ],
      }),
    ).toEqual([
      'Stop keys must be unique',
      'Stop a names an unknown place nowhere',
      `Asset ${assetId} names an unknown stop b`,
      'Leg a → c names an unknown stop',
    ]);
  });

  it('refuses two starts, a Favorites trip that is not Places, and a half-given point', () => {
    expect(
      issues({
        kind: 'route',
        isFavorites: true,
        stops: [stop('a', { role: 'start' }), stop('b', { role: 'start' })],
        assets: [{ assetId, stopKey: null, latitude: 1, longitude: 2, pointSource: null }],
      }),
    ).toEqual([
      'At most one stop can be the start',
      'A Favorites trip is a Places trip',
      `Asset ${assetId} needs latitude, longitude and pointSource together`,
    ]);
  });

  it('refuses a stop that ends before it starts, a leg to its own stop, and assets at a start or finish', () => {
    const leg = {
      fromStopKey: 'a',
      toStopKey: 'a',
      mode: 'foot',
      isModeManual: false,
      status: 'ok',
      polyline: null,
      distance: null,
      duration: null,
      departureName: null,
      departureLatitude: null,
      departureLongitude: null,
      arrivalName: null,
      arrivalLatitude: null,
      arrivalLongitude: null,
    };
    expect(
      issues({
        kind: 'route',
        stops: [
          stop('a', { localStart: '2026-05-01T12:00:00Z', localEnd: '2026-05-01T11:00:00Z' }),
          stop('home', { role: 'start' }),
        ],
        assets: [{ assetId, stopKey: 'home', latitude: null, longitude: null, pointSource: null }],
        legs: [leg],
      }),
    ).toEqual([
      'Stop a ends before it starts',
      `Asset ${assetId} is filed to a start or finish, which has no assets`,
      'Leg a → a leaves and reaches the same stop',
    ]);
  });

  it('refuses a start or finish outside a Route trip', () => {
    expect(issues({ kind: 'places', stops: [stop('home', { role: 'finish' })] })).toEqual([
      'Only a Route trip has a start and a finish',
    ]);
  });

  it('reads a stop time as wall-clock time and refuses an offset', () => {
    expect(parseStart('2026-05-01T10:00:00').data?.stops[0].localStart).toEqual(new Date('2026-05-01T10:00:00.000Z'));
    expect(parseStart('2026-05-01T10:00:00.000Z').data?.stops[0].localStart).toEqual(
      new Date('2026-05-01T10:00:00.000Z'),
    );
    expect(parseStart('2026-05-01T10:00:00+03:00').success).toBe(false);
  });
});

const albumId = '6f9619ff-8b86-4011-b42d-00c04fc964ff';
const createdLanguage = (value: string) =>
  TripCreateDto.schema.parse({ albumId, kind: 'route', language: value }).language;
const createIssues = (dto: object) => {
  const result = TripCreateDto.schema.safeParse({ albumId, ...dto });
  return result.success ? [] : result.error.issues.map(({ message }) => message);
};

describe('TripCreateDto', () => {
  const start = { latitude: 54.68, longitude: 25.28, title: ' ' };

  it('takes a route with a start and a finish at it, and leaves a blank title to naming', () => {
    expect(TripCreateDto.schema.parse({ albumId, kind: 'route', start, isFinishAtStart: true })).toEqual({
      albumId,
      kind: 'route',
      start: { latitude: 54.68, longitude: 25.28, title: null },
      finish: null,
      isFinishAtStart: true,
      language: null,
    });
  });

  it('takes the client’s locale as the naming language, as Nominatim’s accept-language takes it', () => {
    expect(createdLanguage('de')).toBe('de');
    expect(createdLanguage(' DE ')).toBe('de');
    expect(createdLanguage('pt_BR')).toBe('pt-BR');
    expect(createdLanguage('zh_hans')).toBe('zh-Hans');
    expect(TripImportDto.schema.parse({ kind: 'plain', language: 'sr_Latn' }).language).toBe('sr-Latn');
  });

  it('refuses a language that is not a language tag', () => {
    for (const language of ['', 'deutsch', 'de;en', 'de-', 'd']) {
      expect(createIssues({ kind: 'route', language })).toEqual([`Not a language tag: ${language}`]);
    }
  });

  it('gives a start and a finish only to a route', () => {
    expect(createIssues({ kind: 'places', start })).toEqual(['Only a Route trip has a start and a finish']);
    expect(createIssues({ kind: 'plain', isFinishAtStart: true })).toContain(
      'Only a Route trip has a start and a finish',
    );
  });

  it('needs a start, and no finish of its own, for a finish at the start', () => {
    const issue = 'A finish at the start needs a start and no finish of its own';
    expect(createIssues({ kind: 'route', isFinishAtStart: true })).toEqual([issue]);
    expect(createIssues({ kind: 'route', start, finish: start, isFinishAtStart: true })).toEqual([issue]);
  });
});
