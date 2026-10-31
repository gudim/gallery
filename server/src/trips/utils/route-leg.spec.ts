import { describe, expect, it, vi } from 'vitest';
import type { RoutedLine } from 'src/trips/utils/routing.js';
import { TripGeoService, TripLegMode, TripLegStatus } from 'src/trips/enum.js';
import { TripGeoError } from 'src/trips/repositories/trip-geo.repository.js';
import { type LatLng, haversineM, pointOf } from 'src/trips/utils/geo.js';
import { decodePolyline } from 'src/trips/utils/polyline.js';
import { type LegRouter, type RoutingLeg, buildLeg } from 'src/trips/utils/route-leg.js';

const WARSAW = { latitude: 52.2297, longitude: 21.0122 };
const NEAR = { latitude: 52.2306, longitude: 21.0122 }; // ~100 m
const FAR = { latitude: 52.2747, longitude: 21.0122 }; // ~5 km
const KRAKOW = { latitude: 50.0647, longitude: 19.945 };
const WARSAW_STATION = { name: 'Warszawa Centralna', latitude: 52.2289, longitude: 21.0031 };
const KRAKOW_STATION = { name: 'Kraków Główny', latitude: 50.0683, longitude: 19.9475 };

const midpoint = (a: LatLng, b: LatLng) => ({
  latitude: (a.latitude + b.latitude) / 2,
  longitude: (a.longitude + b.longitude) / 2,
});
// A route 1.3 times the straight line through the midpoint, as travel-album's fakes answer.
const line = (a: LatLng, b: LatLng, factor = 1.3): RoutedLine => ({
  points: [a, midpoint(a, b), b],
  distance: factor * haversineM(a, b),
  duration: 600,
});
const noRoute = (service: TripGeoService) => Promise.reject(new TripGeoError(service, 'no route'));

const newRouter = () =>
  ({
    valhalla: vi.fn<LegRouter['valhalla']>((_costing, a, b) => Promise.resolve(line(a, b))),
    brouter: vi.fn<LegRouter['brouter']>((_profile, a, b) => Promise.resolve(line(a, b))),
    stations: vi.fn<LegRouter['stations']>(() => Promise.resolve([])),
  }) satisfies LegRouter;

const leg = (from: LatLng, to: LatLng, overrides: Partial<RoutingLeg> = {}): RoutingLeg => ({
  mode: TripLegMode.Driving,
  isModeManual: false,
  from,
  to,
  departure: null,
  arrival: null,
  ...overrides,
});
const manual = (from: LatLng, to: LatLng, mode: TripLegMode) => leg(from, to, { mode, isModeManual: true });

const pointsOf = (polyline: string) => decodePolyline(polyline);

describe('buildLeg', () => {
  it('walks a short leg and drives a long one by Valhalla when the mode is not the owner’s', async () => {
    const router = newRouter();

    const foot = await buildLeg(leg(WARSAW, NEAR), router);
    const drive = await buildLeg(leg(NEAR, FAR, { mode: TripLegMode.Foot }), router);

    expect(router.valhalla.mock.calls.map(([costing]) => costing)).toEqual(['pedestrian', 'auto']);
    expect(foot).toMatchObject({ mode: 'foot', status: 'ok', duration: 600 });
    expect(drive).toMatchObject({ mode: 'driving', status: 'ok' });
    expect(pointsOf(foot.polyline)).toHaveLength(3);
    expect(foot.distance).toBeCloseTo(1.3 * haversineM(WARSAW, NEAR));
  });

  it('keeps the owner’s mode, and routes a bicycle and a bus by their own costing', async () => {
    const router = newRouter();

    await expect(buildLeg(manual(WARSAW, FAR, TripLegMode.Foot), router)).resolves.toMatchObject({ mode: 'foot' });
    await buildLeg(manual(WARSAW, FAR, TripLegMode.Bicycle), router);
    await buildLeg(manual(WARSAW, FAR, TripLegMode.Bus), router);

    expect(router.valhalla.mock.calls.map(([costing]) => costing)).toEqual(['pedestrian', 'bicycle', 'bus']);
  });

  it('takes a bus along car roads when Valhalla has no bus route', async () => {
    const router = newRouter();
    router.valhalla.mockImplementationOnce(() => noRoute(TripGeoService.Valhalla));

    const built = await buildLeg(manual(WARSAW, FAR, TripLegMode.Bus), router);

    expect(router.valhalla.mock.calls.map(([costing]) => costing)).toEqual(['bus', 'auto']);
    expect(built).toMatchObject({ mode: 'bus', status: 'ok' });
  });

  it('draws a straight line needing attention when the service fails or the route is implausible', async () => {
    const router = newRouter();
    router.valhalla.mockImplementationOnce(() => noRoute(TripGeoService.Valhalla));
    const failed = await buildLeg(leg(WARSAW, FAR), router);

    // Three times longer than believable, as travel-album's test answers.
    router.valhalla.mockImplementationOnce((_costing, a, b) => {
      const straight = haversineM(a, b);
      return Promise.resolve({ ...line(a, b), distance: 3 * Math.max(4 * straight, straight + 2000) });
    });
    const implausible = await buildLeg(leg(WARSAW, NEAR), router);

    expect(failed).toEqual({
      mode: 'driving',
      status: 'attention',
      polyline: expect.any(String),
      distance: haversineM(WARSAW, FAR),
      duration: null,
    });
    expect(pointsOf(failed.polyline)).toEqual([WARSAW, FAR]);
    expect(implausible).toMatchObject({ mode: 'foot', status: 'attention', distance: haversineM(WARSAW, NEAR) });
  });

  it('throws on a failure that is not the service’s', async () => {
    const router = newRouter();
    router.valhalla.mockRejectedValueOnce(new Error('database is down'));

    await expect(buildLeg(leg(WARSAW, FAR), router)).rejects.toThrow('database is down');
  });

  it('draws a direct leg straight and a flight as an arc, both without a request', async () => {
    const router = newRouter();

    const direct = await buildLeg(manual(WARSAW, NEAR, TripLegMode.Direct), router);
    const flight = await buildLeg(manual(WARSAW, KRAKOW, TripLegMode.Flight), router);

    expect(router.valhalla).not.toHaveBeenCalled();
    expect(direct).toMatchObject({ mode: 'direct', status: 'ok', duration: null });
    expect(pointsOf(direct.polyline)).toEqual([WARSAW, NEAR]);
    expect(flight).toMatchObject({ mode: 'flight', status: 'ok', distance: haversineM(WARSAW, KRAKOW) });
    const arc = pointsOf(flight.polyline);
    expect(arc).toHaveLength(33);
    const middle = arc[16];
    expect(haversineM(middle, midpoint(WARSAW, KRAKOW))).toBeGreaterThan(0.05 * flight.distance);
  });

  describe('train', () => {
    it('goes stop → nearest station → rails → station → stop', async () => {
      const router = newRouter();
      router.stations.mockResolvedValueOnce([{ ...WARSAW_STATION, distance: 650 }]);
      router.stations.mockResolvedValueOnce([{ ...KRAKOW_STATION, distance: 450 }]);

      const built = await buildLeg(manual(WARSAW, KRAKOW, TripLegMode.Train), router);

      expect(router.valhalla).not.toHaveBeenCalled();
      expect(router.brouter).toHaveBeenCalledExactlyOnceWith('rail', WARSAW_STATION, KRAKOW_STATION);
      const walk = haversineM(WARSAW, WARSAW_STATION) + haversineM(KRAKOW_STATION, KRAKOW);
      expect(built).toEqual({
        mode: 'train',
        status: 'ok',
        polyline: expect.any(String),
        distance: 1.3 * haversineM(WARSAW_STATION, KRAKOW_STATION) + walk,
        duration: 600,
        departure: WARSAW_STATION,
        arrival: KRAKOW_STATION,
      });
      const points = pointsOf(built.polyline);
      expect(points.slice(0, 2)).toEqual([WARSAW, pointOf(WARSAW_STATION)]);
      expect(points.slice(-2)).toEqual([pointOf(KRAKOW_STATION), KRAKOW]);
    });

    it('keeps the stations the leg has without asking for them', async () => {
      const router = newRouter();
      const other = { name: 'Warszawa Wschodnia', latitude: 52.2516, longitude: 21.0525 };

      const built = await buildLeg(
        { ...manual(WARSAW, KRAKOW, TripLegMode.Train), departure: other, arrival: KRAKOW_STATION },
        router,
      );

      expect(router.stations).not.toHaveBeenCalled();
      expect(router.brouter).toHaveBeenCalledExactlyOnceWith('rail', other, KRAKOW_STATION);
      expect(built).toMatchObject({ status: 'ok', departure: other });
    });

    it('needs attention without a station, and still keeps the one found', async () => {
      const router = newRouter();
      router.stations.mockResolvedValueOnce([{ ...WARSAW_STATION, distance: 650 }]);

      const built = await buildLeg(manual(WARSAW, KRAKOW, TripLegMode.Train), router);

      expect(router.brouter).not.toHaveBeenCalled();
      expect(built).toMatchObject({ status: 'attention', departure: WARSAW_STATION });
      expect(built.arrival).toBeUndefined();
      expect(pointsOf(built.polyline)).toEqual([WARSAW, KRAKOW]);
    });

    it('needs attention without rails or when the station search fails', async () => {
      const router = newRouter();
      router.stations.mockResolvedValue([{ ...WARSAW_STATION, distance: 650 }]);
      router.brouter.mockImplementationOnce(() => noRoute(TripGeoService.BRouter));
      const noRails = await buildLeg(manual(WARSAW, KRAKOW, TripLegMode.Train), router);

      router.stations.mockImplementationOnce(() => Promise.reject(new TripGeoError(TripGeoService.Overpass, 'down')));
      const noSearch = await buildLeg(manual(WARSAW, KRAKOW, TripLegMode.Train), router);

      expect(noRails).toMatchObject({ status: 'attention', departure: WARSAW_STATION, arrival: WARSAW_STATION });
      expect(noSearch).toEqual({
        mode: 'train',
        status: 'attention',
        polyline: expect.any(String),
        distance: haversineM(WARSAW, KRAKOW),
        duration: null,
      });
    });
  });

  describe('boat', () => {
    it('follows a river BRouter knows, drawn on to the stops', async () => {
      const router = newRouter();

      const built = await buildLeg(manual(WARSAW, FAR, TripLegMode.Boat), router);

      expect(router.brouter).toHaveBeenCalledExactlyOnceWith('river', WARSAW, FAR);
      expect(built).toMatchObject({ mode: 'boat', status: 'ok', duration: 600 });
      expect(pointsOf(built.polyline)).toHaveLength(5);
    });

    it('draws a gentle arc, still ok, when the river is far from the stops, implausible or unknown', async () => {
      const router = newRouter();
      const off = { latitude: 0.01, longitude: 0 };
      const shifted = (p: LatLng) => ({ latitude: p.latitude + off.latitude, longitude: p.longitude });
      router.brouter.mockResolvedValueOnce({ ...line(shifted(WARSAW), shifted(FAR)) });
      router.brouter.mockResolvedValueOnce({ ...line(WARSAW, FAR), distance: 3 * 4 * haversineM(WARSAW, FAR) });
      router.brouter.mockImplementationOnce(() => noRoute(TripGeoService.BRouter));

      for (let i = 0; i < 3; i++) {
        const built = await buildLeg(manual(WARSAW, FAR, TripLegMode.Boat), router);
        expect(built).toMatchObject({ status: 'ok', duration: null, distance: haversineM(WARSAW, FAR) });
        const arc = pointsOf(built.polyline);
        expect(arc).toHaveLength(33);
        const bend = haversineM(arc[16], midpoint(WARSAW, FAR)) / built.distance;
        expect(bend).toBeGreaterThan(0.03);
        expect(bend).toBeLessThan(0.07);
      }
    });
  });

  it('gives a pending status nowhere: every build ends ok or needing attention', async () => {
    const router = newRouter();
    for (const mode of Object.values(TripLegMode)) {
      const built = await buildLeg(manual(WARSAW, FAR, mode), router);
      expect([TripLegStatus.Ok, TripLegStatus.Attention]).toContain(built.status);
    }
  });
});
