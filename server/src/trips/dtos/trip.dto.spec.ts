import { describe, expect, it } from 'vitest';
import { TripImportDto } from 'src/trips/dtos/trip.dto.js';

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
  isManualPoint: false,
  role: null,
  isSameAsOrigin: false,
  isTransit: null,
  isAtCenter: false,
  ...overrides,
});

const issues = (document: object) => {
  const result = TripImportDto.schema.safeParse(document);
  return result.success ? [] : result.error.issues.map(({ message }) => message);
};

describe('TripImportDto', () => {
  it('accepts a bare trip and fills the defaults', () => {
    expect(TripImportDto.schema.parse({ kind: 'plain' })).toEqual({
      kind: 'plain',
      isFavorites: false,
      isShowcased: false,
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
        stops: [stop('a', { role: 'origin' }), stop('b', { role: 'origin' })],
        assets: [{ assetId, stopKey: null, latitude: 1, longitude: 2, pointSource: null }],
      }),
    ).toEqual([
      'At most one stop can be the origin',
      'A Favorites trip is a Places trip',
      `Asset ${assetId} needs latitude, longitude and pointSource together`,
    ]);
  });
});
