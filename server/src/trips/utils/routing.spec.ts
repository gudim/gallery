import { describe, expect, it } from 'vitest';
import { TripGeoService } from 'src/trips/enum.js';
import { TripGeoError } from 'src/trips/repositories/trip-geo.repository.js';
import { buildTripGeoRequest, resolveTripGeoConfig } from 'src/trips/utils/geo-services.js';
import { encodePolyline } from 'src/trips/utils/polyline.js';
import {
  brouterRequest,
  isOffered,
  parseBRouter,
  parseStations,
  parseValhalla,
  stationsRequest,
  valhallaRequest,
} from 'src/trips/utils/routing.js';

const WARSAW = { latitude: 52.2297, longitude: 21.0122 };
const KRAKOW = { latitude: 50.0647, longitude: 19.945 };
const config = resolveTripGeoConfig({});

describe('valhalla', () => {
  it('posts both ends, the costing and kilometres, as travel-album does', () => {
    const request = valhallaRequest('pedestrian', { latitude: 52.22971234, longitude: 21.0122 }, KRAKOW);
    expect(request).toEqual({
      service: TripGeoService.Valhalla,
      json: {
        locations: [
          { lat: 52.229712, lon: 21.0122 },
          { lat: 50.0647, lon: 19.945 },
        ],
        costing: 'pedestrian',
        directions_options: { units: 'kilometers' },
      },
    });
    expect(buildTripGeoRequest(request, config)).toMatchObject({
      method: 'POST',
      url: 'https://valhalla1.openstreetmap.de/route',
      contentType: 'application/json',
    });
  });

  it('reads the shape of every leg, the length in metres and the time', () => {
    const route = parseValhalla({
      trip: {
        legs: [{ shape: encodePolyline([WARSAW, KRAKOW]) }],
        summary: { length: 293.4, time: 10_800 },
      },
    });
    expect(route).toEqual({ points: [WARSAW, KRAKOW], distance: 293_400, duration: 10_800 });
  });

  it('throws on an answer without a route', () => {
    for (const data of [{}, { trip: { legs: [], summary: { length: 1, time: 1 } } }, null, { error: 'No path' }]) {
      expect(() => parseValhalla(data)).toThrow(TripGeoError);
    }
  });
});

describe('brouter', () => {
  it('asks for the first route as GeoJSON, ends as lon,lat with six decimals', () => {
    const request = brouterRequest('rail', WARSAW, KRAKOW);
    expect(request.query).toEqual({
      lonlats: '21.012200,52.229700|19.945000,50.064700',
      profile: 'rail',
      alternativeidx: 0,
      format: 'geojson',
    });
    expect(buildTripGeoRequest(request, config)).toMatchObject({ method: 'GET', host: 'brouter.de' });
  });

  it('reads [lon, lat, elevation] points and the string properties', () => {
    const route = parseBRouter({
      type: 'FeatureCollection',
      features: [
        {
          geometry: {
            type: 'LineString',
            coordinates: [
              [21.0122, 52.2297, 100],
              [19.945, 50.0647, 210],
            ],
          },
          properties: { 'track-length': '301234', 'total-time': '9000' },
        },
      ],
    });
    expect(route).toEqual({ points: [WARSAW, KRAKOW], distance: 301_234, duration: 9000 });
  });

  it('throws on an answer without a route', () => {
    const one = { geometry: { coordinates: [[21, 52]] }, properties: { 'track-length': '1', 'total-time': '1' } };
    for (const data of [{}, { features: [] }, { features: [one] }, 'no route']) {
      expect(() => parseBRouter(data)).toThrow(TripGeoError);
    }
  });
});

const node = (id: number, lat: number, name?: string) => ({
  type: 'node',
  id,
  lat,
  lon: 21.0122,
  ...(name && { tags: { name, railway: 'station' } }),
});

describe('stations', () => {
  it('asks Overpass for stations and halts within 3 km', () => {
    const request = stationsRequest(WARSAW);
    expect(request.form).toEqual({
      data: '[out:json][timeout:25];node["railway"~"^(station|halt)$"](around:3000,52.229700,21.012200);out;',
    });
    expect(buildTripGeoRequest(request, config)).toMatchObject({
      method: 'POST',
      contentType: 'application/x-www-form-urlencoded',
    });
  });

  it('lists up to five nodes, nearest first, with their names and distances', () => {
    const stations = parseStations(WARSAW)({
      elements: [
        node(1, 52.25, 'Far'),
        node(2, 52.23, 'Near'),
        { type: 'way', id: 3 },
        node(4, 52.24),
        node(5, 52.241, 'E'),
        node(6, 52.242, 'F'),
        node(7, 52.243, 'G'),
      ],
    });
    expect(stations.map(({ name }) => name)).toEqual(['Near', '', 'E', 'F', 'G']);
    expect(stations[0]).toEqual({ name: 'Near', latitude: 52.23, longitude: 21.0122, distance: 33 });
  });

  it('takes an empty answer, and throws on one that is not Overpass’s', () => {
    expect(parseStations(WARSAW)({ elements: [] })).toEqual([]);
    expect(() => parseStations(WARSAW)({ remark: 'runtime error' })).toThrow(TripGeoError);
  });

  it('tells an offered station by its name and point', () => {
    const offered = [{ name: 'Warszawa Centralna', latitude: 52.2289, longitude: 21.0031 }];
    expect(isOffered({ name: 'Warszawa Centralna', latitude: 52.2289, longitude: 21.0031 }, offered)).toBe(true);
    expect(isOffered({ name: 'Warszawa', latitude: 52.2289, longitude: 21.0031 }, offered)).toBe(false);
    expect(isOffered({ name: 'Warszawa Centralna', latitude: 52.229, longitude: 21.0031 }, offered)).toBe(false);
  });
});
