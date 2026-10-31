import { describe, expect, it } from 'vitest';
import { TripGeoService } from 'src/trips/enum.js';
import { buildTripGeoRequest, defaultTripGeoUserAgent, resolveTripGeoConfig } from 'src/trips/utils/geo-services.js';

describe('resolveTripGeoConfig', () => {
  it('uses the public servers travel-album calls', () => {
    expect(resolveTripGeoConfig({})).toEqual({
      urls: {
        valhalla: 'https://valhalla1.openstreetmap.de/route',
        brouter: 'https://brouter.de/brouter',
        overpass: 'https://overpass-api.de/api/interpreter',
        nominatim: 'https://nominatim.openstreetmap.org',
      },
      userAgent: defaultTripGeoUserAgent(),
    });
  });

  it('names the server and the project in the User-Agent', () => {
    expect(defaultTripGeoUserAgent()).toMatch(/^gallery-server\/\d+\.\d+\.\d+\S* trips \(\+https:\/\/\S+\)$/);
  });

  it('takes each URL and the User-Agent from its environment variable', () => {
    const config = resolveTripGeoConfig({
      TRIPS_VALHALLA_URL: 'https://valhalla.lan:8002/route',
      TRIPS_BROUTER_URL: 'https://brouter.lan/brouter',
      TRIPS_OVERPASS_URL: 'https://overpass.lan/api/interpreter',
      TRIPS_NOMINATIM_URL: ' https://nominatim.lan ',
      TRIPS_USER_AGENT: 'my-gallery/1.0 (me@example.com)',
    });
    expect(config).toEqual({
      urls: {
        valhalla: 'https://valhalla.lan:8002/route',
        brouter: 'https://brouter.lan/brouter',
        overpass: 'https://overpass.lan/api/interpreter',
        nominatim: 'https://nominatim.lan',
      },
      userAgent: 'my-gallery/1.0 (me@example.com)',
    });
  });

  it('keeps the default for an empty variable', () => {
    const config = resolveTripGeoConfig({ TRIPS_NOMINATIM_URL: '', TRIPS_USER_AGENT: ' ' });
    expect(config.urls.nominatim).toBe('https://nominatim.openstreetmap.org');
    expect(config.userAgent).toBe(defaultTripGeoUserAgent());
  });

  it('refuses a variable that is not an http(s) URL', () => {
    expect(() => resolveTripGeoConfig({ TRIPS_BROUTER_URL: 'brouter.lan' })).toThrow('TRIPS_BROUTER_URL');
    expect(() => resolveTripGeoConfig({ TRIPS_BROUTER_URL: 'ftp://brouter.lan' })).toThrow('TRIPS_BROUTER_URL');
  });
});

describe('buildTripGeoRequest', () => {
  const config = resolveTripGeoConfig({ TRIPS_NOMINATIM_URL: 'https://nominatim.example.org/' });

  it('appends the path and sorts the query', () => {
    const http = buildTripGeoRequest(
      { service: TripGeoService.Nominatim, path: '/reverse', query: { lon: 21.01, lat: 52.23, format: 'jsonv2' } },
      config,
    );
    expect(http).toMatchObject({
      method: 'GET',
      url: 'https://nominatim.example.org/reverse?format=jsonv2&lat=52.23&lon=21.01',
      host: 'nominatim.example.org',
      body: undefined,
      timeoutMs: 20_000,
      description: 'GET https://nominatim.example.org/reverse?format=jsonv2&lat=52.23&lon=21.01',
    });
    expect(http.key).toMatch(/^[\da-f]{64}$/);
  });

  it('gives the same key whatever order the query was written in', () => {
    const a = buildTripGeoRequest({ service: TripGeoService.Nominatim, query: { a: 1, b: 2 } }, config);
    const b = buildTripGeoRequest({ service: TripGeoService.Nominatim, query: { b: 2, a: 1 } }, config);
    expect(a.key).toBe(b.key);
  });

  it('posts JSON and puts the body in the key', () => {
    const http = buildTripGeoRequest({ service: TripGeoService.Valhalla, json: { costing: 'auto' } }, config);
    expect(http).toMatchObject({
      method: 'POST',
      url: 'https://valhalla1.openstreetmap.de/route',
      host: 'valhalla1.openstreetmap.de',
      body: '{"costing":"auto"}',
      contentType: 'application/json',
      timeoutMs: 40_000,
    });
    const other = buildTripGeoRequest({ service: TripGeoService.Valhalla, json: { costing: 'pedestrian' } }, config);
    expect(other.key).not.toBe(http.key);
  });

  it('posts a form', () => {
    const http = buildTripGeoRequest({ service: TripGeoService.Overpass, form: { data: 'node(1);out;' } }, config);
    expect(http).toMatchObject({
      method: 'POST',
      body: 'data=node%281%29%3Bout%3B',
      contentType: 'application/x-www-form-urlencoded',
    });
  });

  it('starts a fresh cache when the service moves', () => {
    const request = { service: TripGeoService.BRouter, query: { profile: 'trekking' } };
    const moved = resolveTripGeoConfig({ TRIPS_BROUTER_URL: 'https://brouter.lan/brouter' });
    expect(buildTripGeoRequest(request, moved).key).not.toBe(buildTripGeoRequest(request, config).key);
  });
});
