import { BadGatewayException, BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { Kysely } from 'kysely';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { AlbumUserRole, JobName, SharedLinkType } from 'src/enum.js';
import { AccessRepository } from 'src/repositories/access.repository.js';
import { AssetFavoriteRepository } from 'src/repositories/asset-favorite.repository.js';
import { JobRepository } from 'src/repositories/job.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { DB } from 'src/schema/index.js';
import { BaseService } from 'src/services/base.service.js';
import {
  TripCreateDto,
  TripImportDto,
  TripLegModeUpdateDto,
  TripLegStationUpdateDto,
  TripResponseDto,
} from 'src/trips/dtos/trip.dto.js';
import { TripGeoService, TripLegMode, TripLegStatus } from 'src/trips/enum.js';
import { TripEditorRepository } from 'src/trips/repositories/trip-editor.repository.js';
import { TripGeoRepository } from 'src/trips/repositories/trip-geo.repository.js';
import { TripRepository } from 'src/trips/repositories/trip.repository.js';
import { TripService } from 'src/trips/services/trip.service.js';
import { type LatLng, haversineM } from 'src/trips/utils/geo.js';
import { decodePolyline, encodePolyline } from 'src/trips/utils/polyline.js';
import { newMediumService } from 'test/medium.factory.js';
import { factory } from 'test/small.factory.js';
import { getKyselyDB } from 'test/utils.js';

// Leg routing against Postgres with Valhalla, BRouter and Overpass faked behind a stubbed fetch: no test reaches the
// network (travel-album tests/integration/test_route_legs.py). The geo cache is shared by the whole file, so each
// trip lies at its own longitude.
let db: Kysely<DB>;

beforeAll(async () => {
  db = await getKyselyDB();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

type Station = { name: string; latitude: number; longitude: number; names?: Record<string, string> };

// The fake services, as travel-album's fixtures answer: a route is 1.3 times the straight line through its middle,
// 600 s by road and 900 s by rail; a station is any of `stations` within 3 km of the point asked about.
type FakeOptions = {
  status?: number;
  lengthOf?: (straight: number) => number;
  failCostings?: string[];
  failProfiles?: string[];
  stations?: Station[];
  overpassDown?: boolean;
  onRequest?: () => Promise<void>;
};

const middle = (a: LatLng, b: LatLng) => ({
  latitude: (a.latitude + b.latitude) / 2,
  longitude: (a.longitude + b.longitude) / 2,
});

const fakeServices = (options: FakeOptions = {}) => {
  const requests = {
    valhalla: [] as Array<{ costing: string; userAgent: string }>,
    brouter: [] as Array<{ profile: string; lonlats: string }>,
    overpass: [] as string[],
  };
  const lengthOf = (straight: number) => options.lengthOf?.(straight) ?? 1.3 * straight;
  const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(String(input));
    await options.onRequest?.();
    if (url.host === 'valhalla1.openstreetmap.de') {
      const body = JSON.parse(String(init?.body));
      const headers = init?.headers as Record<string, string>;
      requests.valhalla.push({ costing: body.costing, userAgent: headers['User-Agent'] });
      if (options.status) {
        return new Response('down', { status: options.status });
      }
      if (options.failCostings?.includes(body.costing)) {
        return Response.json({ error: 'No path could be found for input' }, { status: 400 });
      }
      const [a, b] = body.locations.map(({ lat, lon }: { lat: number; lon: number }) => ({
        latitude: lat,
        longitude: lon,
      }));
      const shape = encodePolyline([a, middle(a, b), b]);
      return Response.json({
        trip: { legs: [{ shape }], summary: { length: lengthOf(haversineM(a, b)) / 1000, time: 600 } },
      });
    }
    if (url.host === 'brouter.de') {
      const profile = url.searchParams.get('profile')!;
      const lonlats = url.searchParams.get('lonlats')!;
      requests.brouter.push({ profile, lonlats });
      if (options.failProfiles?.includes(profile)) {
        return new Response('target island detected', { status: 400 });
      }
      const [a, b] = lonlats.split('|').map((pair) => {
        const [longitude, latitude] = pair.split(',').map(Number);
        return { latitude, longitude };
      });
      return Response.json({
        type: 'FeatureCollection',
        features: [
          {
            geometry: {
              type: 'LineString',
              coordinates: [a, middle(a, b), b].map(({ latitude, longitude }) => [longitude, latitude, 100]),
            },
            properties: { 'track-length': String(Math.round(lengthOf(haversineM(a, b)))), 'total-time': '900' },
          },
        ],
      });
    }
    if (url.host === 'overpass-api.de') {
      const query = new URLSearchParams(String(init?.body)).get('data')!;
      requests.overpass.push(query);
      if (options.overpassDown) {
        return new Response('too many requests', { status: 429 });
      }
      const [, latitude, longitude] = /around:\d+,([\d.-]+),([\d.-]+)/.exec(query)!.map(Number);
      const elements = (options.stations ?? [])
        .filter((station) => haversineM({ latitude, longitude }, station) <= 3000)
        .map((station, id) => ({
          type: 'node',
          id,
          lat: station.latitude,
          lon: station.longitude,
          tags: { railway: 'station', name: station.name, ...station.names },
        }));
      return Response.json({ elements });
    }
    throw new Error(`Unexpected request to ${url.href}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  return requests;
};

// A test's own longitude, so the cached answers of one test never answer another.
let nextShift = 0;

const setup = async () => {
  const shift = (nextShift += 0.37);
  const at = (latitude: number, longitude: number) => ({ latitude, longitude: longitude + shift });
  const places = {
    WARSAW: at(52.2297, 21.0122),
    NEAR: at(52.2306, 21.0122), // ~100 m
    FAR: at(52.2747, 21.0122), // ~5 km
    KRAKOW: at(50.0647, 19.945),
    WARSAW_STATION: { name: 'Warszawa Centralna', ...at(52.2289, 21.0031) }, // ~650 m
    OTHER_STATION: { name: 'Warszawa Ochota', ...at(52.2246, 20.9898) }, // ~1.6 km
    KRAKOW_STATION: { name: 'Kraków Główny', ...at(50.0683, 19.9475) }, // ~450 m
  };

  const { ctx } = newMediumService(BaseService, { database: db, real: [], mock: [LoggingRepository, JobRepository] });
  const job = ctx.getMock(JobRepository);
  job.queue.mockResolvedValue();
  job.queueAll.mockResolvedValue();
  const geo = new TripGeoRepository(db, LoggingRepository.create());
  vi.spyOn(geo, 'reserveTurn').mockResolvedValue(0);
  const sut = new TripService(
    new AccessRepository(db),
    job,
    new TripRepository(db),
    geo,
    new TripEditorRepository(db),
    new AssetFavoriteRepository(db),
  );
  const { user: owner } = await ctx.newUser();
  const { album } = await ctx.newAlbum({ ownerId: owner.id });
  const auth = factory.auth({ user: owner });

  // A route through `points`, one stop each, with pending legs of `modes` between them (by car unless set).
  const importRoute = (points: LatLng[], modes: Array<TripLegMode | undefined> = []) =>
    sut.import(
      auth,
      album.id,
      TripImportDto.schema.parse({
        kind: 'route',
        stops: points.map((point, index) => ({
          key: `s${index}`,
          placeKey: null,
          ...point,
          isPositionManual: false,
          localStart: `2026-05-01T1${index}:00:00.000Z`,
          localEnd: `2026-05-01T1${index}:00:00.000Z`,
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
        })),
        legs: points.slice(1).map((_, index) => ({
          fromStopKey: `s${index}`,
          toStopKey: `s${index + 1}`,
          mode: modes[index] ?? TripLegMode.Driving,
          isModeManual: modes[index] !== undefined,
          status: TripLegStatus.Pending,
          polyline: null,
          distance: null,
          duration: null,
          departureName: null,
          departureLatitude: null,
          departureLongitude: null,
          arrivalName: null,
          arrivalLatitude: null,
          arrivalLongitude: null,
        })),
      }),
    );

  const route = async () => {
    await sut.handleRouteLegs({ id: album.id });
    return sut.get(auth, album.id);
  };

  const routeLegs = async () => {
    const trip = await route();
    return trip.legs;
  };

  return { ctx, job, sut, owner, album, auth, places, importRoute, route, routeLegs };
};

const routeJob = (id: string) => ({ name: JobName.TripRouteLegs, data: { id } });
const pointsOf = (leg: TripResponseDto['legs'][number]) => decodePolyline(leg.polyline!);
const asPoint = ({ latitude, longitude }: LatLng) => ({ latitude, longitude });
const pending = (albumId: string) =>
  db
    .updateTable('trip_leg')
    .set({ status: TripLegStatus.Pending, polyline: null, distance: null })
    .where('albumId', '=', albumId)
    .execute();

const modeDto = (mode: TripLegMode | null) => TripLegModeUpdateDto.schema.parse({ mode });
const stationDto = (side: string, station: Station) => TripLegStationUpdateDto.schema.parse({ side, ...station });

describe('leg routing', () => {
  it('builds lines by Valhalla, writes them once, and serves them again from the cache', async () => {
    const { sut, album, places, importRoute, route } = await setup();
    const requests = fakeServices();
    const { WARSAW, NEAR, FAR } = places;
    await importRoute([WARSAW, NEAR, FAR]);

    const trip = await route();

    expect(requests.valhalla.map(({ costing }) => costing)).toEqual(['pedestrian', 'auto']);
    expect(requests.valhalla.every(({ userAgent }) => userAgent.startsWith('gallery-server/'))).toBe(true);
    const [foot, drive] = trip.legs;
    expect(foot).toMatchObject({ mode: 'foot', status: 'ok', duration: 600, isModeManual: false });
    expect(drive).toMatchObject({ mode: 'driving', status: 'ok', duration: 600 });
    expect(pointsOf(foot)).toHaveLength(3);
    expect(foot.distance).toBeCloseTo(1.3 * haversineM(WARSAW, NEAR), 0);
    expect(trip.contentVersion).toBe(2);

    await pending(album.id);
    const again = await route();
    expect(again.legs.map(({ status }) => status)).toEqual(['ok', 'ok']);
    expect(requests.valhalla).toHaveLength(2);
    await expect(sut.handleRouteLegs({ id: album.id })).resolves.toBe('skipped');
  });

  it('draws a straight line needing attention when the service fails, and asks again on retry', async () => {
    const { sut, auth, album, job, places, importRoute, routeLegs } = await setup();
    const { WARSAW, FAR } = places;
    fakeServices({ status: 500 });
    await importRoute([WARSAW, FAR]);

    const [failed] = await routeLegs();
    expect(failed).toMatchObject({ mode: 'driving', status: 'attention', duration: null });
    expect(pointsOf(failed)).toEqual([asPoint(WARSAW), asPoint(FAR)]);
    expect(failed.distance).toBeCloseTo(haversineM(WARSAW, FAR));

    const requests = fakeServices();
    job.queue.mockClear();
    const retried = await sut.retryLeg(auth, album.id, failed.id);
    expect(retried.legs[0]).toMatchObject({ status: 'pending', polyline: null, distance: null, mode: 'driving' });
    expect(job.queue).toHaveBeenCalledWith({ name: JobName.TripRouteLegs, data: { id: album.id } });

    expect(await routeLegs()).toMatchObject([{ status: 'ok' }]);
    expect(requests.valhalla).toHaveLength(1);
  });

  it('needs attention for a route too long to believe', async () => {
    const { places, importRoute, routeLegs } = await setup();
    const { WARSAW, NEAR } = places;
    fakeServices({ lengthOf: (straight) => 3 * Math.max(4 * straight, straight + 2000) });
    await importRoute([WARSAW, NEAR]);

    const [leg] = await routeLegs();

    expect(leg).toMatchObject({ mode: 'foot', status: 'attention' });
    expect(pointsOf(leg)).toEqual([asPoint(WARSAW), asPoint(NEAR)]);
  });

  it('does not route a direct leg or a flight, and recomputes a mode the owner did not set', async () => {
    const { places, importRoute, routeLegs } = await setup();
    const { WARSAW, NEAR, FAR, KRAKOW } = places;
    const requests = fakeServices();
    await importRoute([WARSAW, NEAR, KRAKOW, FAR], [TripLegMode.Direct, TripLegMode.Flight]);
    await db.updateTable('trip_leg').set({ mode: TripLegMode.Foot }).where('isModeManual', '=', false).execute();

    const [direct, flight, auto] = await routeLegs();

    expect(requests.valhalla.map(({ costing }) => costing)).toEqual(['auto']);
    expect(direct).toMatchObject({ mode: 'direct', status: 'ok', isModeManual: true });
    expect(pointsOf(direct)).toEqual([asPoint(WARSAW), asPoint(NEAR)]);
    expect(flight).toMatchObject({ mode: 'flight', status: 'ok', duration: null });
    expect(flight.distance).toBeCloseTo(haversineM(NEAR, KRAKOW));
    expect(pointsOf(flight)).toHaveLength(33);
    expect(auto).toMatchObject({ mode: 'driving', status: 'ok', isModeManual: false });
  });

  it('leaves a leg pending when its stop moved while the line was being built', async () => {
    const { sut, auth, album, places, importRoute, routeLegs } = await setup();
    const { WARSAW, FAR } = places;
    await importRoute([WARSAW, FAR]);
    fakeServices({
      onRequest: async () => {
        await db
          .updateTable('trip_stop')
          .set((eb) => ({ latitude: eb('latitude', '+', 0.001) }))
          .where('albumId', '=', album.id)
          .where('latitude', '>', FAR.latitude - 0.0001)
          .execute();
      },
    });

    const [leg] = await routeLegs();

    expect(leg).toMatchObject({ status: 'pending', polyline: null });
    await expect(sut.get(auth, album.id)).resolves.toMatchObject({ contentVersion: 1 });
  });

  it('leaves a leg pending when its mode changed while the line was being built', async () => {
    const { album, places, importRoute, routeLegs } = await setup();
    const { WARSAW, FAR } = places;
    await importRoute([WARSAW, FAR]);
    fakeServices({
      onRequest: async () => {
        await db
          .updateTable('trip_leg')
          .set({ mode: TripLegMode.Bicycle, isModeManual: true })
          .where('albumId', '=', album.id)
          .execute();
      },
    });

    const [leg] = await routeLegs();

    expect(leg).toMatchObject({ mode: 'bicycle', status: 'pending', polyline: null });
  });

  it('takes a train from the nearest station on rails to the station at the other end', async () => {
    const { places, importRoute, album, routeLegs } = await setup();
    const { WARSAW, KRAKOW, WARSAW_STATION, KRAKOW_STATION, OTHER_STATION } = places;
    const requests = fakeServices({ stations: [OTHER_STATION, WARSAW_STATION, KRAKOW_STATION] });
    await importRoute([WARSAW, KRAKOW], [TripLegMode.Train]);

    const [leg] = await routeLegs();

    expect(requests.valhalla).toEqual([]);
    expect(requests.brouter).toEqual([
      {
        profile: 'rail',
        lonlats: `${WARSAW_STATION.longitude.toFixed(6)},${WARSAW_STATION.latitude.toFixed(6)}|${KRAKOW_STATION.longitude.toFixed(6)},${KRAKOW_STATION.latitude.toFixed(6)}`,
      },
    ]);
    expect(leg).toMatchObject({
      mode: 'train',
      status: 'ok',
      duration: 900,
      departureName: 'Warszawa Centralna',
      departureLatitude: WARSAW_STATION.latitude,
      arrivalName: 'Kraków Główny',
      arrivalLongitude: KRAKOW_STATION.longitude,
    });
    const line = pointsOf(leg);
    expect(line[0]).toEqual(asPoint(WARSAW));
    expect(line[1].latitude).toBeCloseTo(WARSAW_STATION.latitude, 6);
    expect(line.at(-1)).toEqual(asPoint(KRAKOW));
    const walk = haversineM(WARSAW, WARSAW_STATION) + haversineM(KRAKOW_STATION, KRAKOW);
    expect(leg.distance).toBeCloseTo(Math.round(1.3 * haversineM(WARSAW_STATION, KRAKOW_STATION)) + walk, 0);

    // Again: the stations come from the leg, the rails from the cache.
    await pending(album.id);
    expect(await routeLegs()).toMatchObject([{ status: 'ok' }]);
    expect([requests.overpass.length, requests.brouter.length]).toEqual([2, 1]);
  });

  it('needs attention for a train without a station at one end, keeping the one it found', async () => {
    const { places, importRoute, routeLegs } = await setup();
    const { WARSAW, KRAKOW, WARSAW_STATION } = places;
    const requests = fakeServices({ stations: [WARSAW_STATION] });
    await importRoute([WARSAW, KRAKOW], [TripLegMode.Train]);

    const [leg] = await routeLegs();

    expect(leg).toMatchObject({ status: 'attention', departureName: 'Warszawa Centralna', arrivalName: null });
    expect(pointsOf(leg)).toEqual([asPoint(WARSAW), asPoint(KRAKOW)]);
    expect(requests.brouter).toEqual([]);
  });

  it('takes a boat along a river BRouter knows, else draws a gentle arc that is ok', async () => {
    const { album, places, importRoute, routeLegs } = await setup();
    const { WARSAW, FAR } = places;
    let requests = fakeServices();
    await importRoute([WARSAW, FAR], [TripLegMode.Boat]);

    const [river] = await routeLegs();
    expect(requests.brouter.map(({ profile }) => profile)).toEqual(['river']);
    expect(river).toMatchObject({ mode: 'boat', status: 'ok', duration: 900 });
    expect(pointsOf(river)).toHaveLength(5);

    await db.deleteFrom('trip_geo_cache').where('service', '=', TripGeoService.BRouter).execute();
    await pending(album.id);
    requests = fakeServices({ failProfiles: ['river'] });
    const [open] = await routeLegs();
    expect(requests.brouter).toHaveLength(1);
    expect(open).toMatchObject({ mode: 'boat', status: 'ok', duration: null });
    expect(open.distance).toBeCloseTo(haversineM(WARSAW, FAR));
    expect(pointsOf(open)).toHaveLength(33);
  });

  it('is queued when a route is made, imported with pending legs, or split by filing', async () => {
    const { ctx, job, sut, owner, auth, importRoute, album, places } = await setup();
    // Making a trip queues naming too; this test is about routing.
    const routing = () => job.queue.mock.calls.filter(([item]) => item.name === JobName.TripRouteLegs);
    await importRoute([places.WARSAW, places.FAR]);
    expect(routing()).toEqual([[routeJob(album.id)]]);

    const { asset } = await ctx.newAsset({ ownerId: owner.id, localDateTime: new Date('2026-05-01T10:00:00.000Z') });
    await ctx.newExif({ assetId: asset.id, ...places.WARSAW });
    const { album: other } = await ctx.newAlbum({ ownerId: owner.id }, [asset.id]);
    job.queue.mockClear();
    await sut.create(auth, TripCreateDto.schema.parse({ albumId: other.id, kind: 'route', start: places.FAR }));
    expect(routing()).toEqual([[routeJob(other.id)]]);

    const { album: placesAlbum } = await ctx.newAlbum({ ownerId: owner.id }, [asset.id]);
    job.queue.mockClear();
    await sut.create(auth, TripCreateDto.schema.parse({ albumId: placesAlbum.id, kind: 'places' }));
    expect(routing()).toEqual([]);

    // A later asset far from both stops opens a stop between them, which splits the leg.
    await db.updateTable('trip_leg').set({ status: TripLegStatus.Ok }).where('albumId', '=', other.id).execute();
    const { asset: later } = await ctx.newAsset({
      ownerId: owner.id,
      localDateTime: new Date('2026-05-01T15:00:00.000Z'),
    });
    await ctx.newExif({ assetId: later.id, ...places.KRAKOW });
    await db.insertInto('asset_job_status').values({ assetId: later.id, metadataExtractedAt: new Date() }).execute();
    await ctx.newAlbumAsset({ albumId: other.id, assetId: later.id });
    await sut.handleFile({ id: other.id });
    expect(routing()).toEqual([[routeJob(other.id)]]);
  });
});

describe('leg editing', () => {
  it('lets the owner and an editor set a mode, kept from then on, and give it back to the default', async () => {
    const { ctx, sut, auth, album, job, places, importRoute, route, routeLegs } = await setup();
    const { user: editor } = await ctx.newUser();
    await ctx.newAlbumUser({ albumId: album.id, userId: editor.id, role: AlbumUserRole.Editor });
    const requests = fakeServices();
    const trip = await importRoute([places.WARSAW, places.FAR]);
    const legId = trip.legs[0].id;
    await route();
    job.queue.mockClear();

    const set = await sut.setLegMode(factory.auth({ user: editor }), album.id, legId, modeDto(TripLegMode.Bicycle));
    expect(set.legs[0]).toMatchObject({ mode: 'bicycle', isModeManual: true, status: 'pending', polyline: null });
    expect(set.contentVersion).toBe(3);
    expect(job.queue).toHaveBeenCalledWith({ name: JobName.TripRouteLegs, data: { id: album.id } });
    expect(await routeLegs()).toMatchObject([{ mode: 'bicycle', isModeManual: true, status: 'ok' }]);
    expect(requests.valhalla.map(({ costing }) => costing)).toEqual(['auto', 'bicycle']);

    const automatic = await sut.setLegMode(auth, album.id, legId, modeDto(null));
    expect(automatic.legs[0]).toMatchObject({ mode: 'driving', isModeManual: false, status: 'pending' });
  });

  it('refuses a trail, which only an import makes', () => {
    expect(() => modeDto(TripLegMode.Trail)).toThrow();
  });

  it('names stations in the trip’s language, else in the instance default, else by their own name', async () => {
    const { sut, auth, album, places, importRoute } = await setup();
    const { WARSAW, KRAKOW, WARSAW_STATION, KRAKOW_STATION } = places;
    fakeServices({
      stations: [
        { ...WARSAW_STATION, names: { 'name:de': 'Warschau Hauptbahnhof', 'name:ru': 'Варшава-Центральная' } },
        KRAKOW_STATION,
      ],
    });
    const trip = await importRoute([WARSAW, KRAKOW], [TripLegMode.Train]);
    const legId = trip.legs[0].id;

    const byDefault = await sut.getLegStations(auth, album.id, legId);
    expect([byDefault.departure[0].name, byDefault.arrival[0].name]).toEqual(['Варшава-Центральная', 'Kraków Główny']);

    await db.updateTable('trip').set({ language: 'de' }).where('albumId', '=', album.id).execute();
    const german = await sut.getLegStations(auth, album.id, legId);
    expect([german.departure[0].name, german.arrival[0].name]).toEqual(['Warschau Hauptbahnhof', 'Kraków Główny']);
  });

  it('lists stations near both ends and takes only an offered one, kept until the mode changes', async () => {
    const { sut, auth, album, places, importRoute, routeLegs } = await setup();
    const { WARSAW, KRAKOW, WARSAW_STATION, OTHER_STATION, KRAKOW_STATION } = places;
    const requests = fakeServices({ stations: [OTHER_STATION, WARSAW_STATION, KRAKOW_STATION] });
    const trip = await importRoute([WARSAW, KRAKOW], [TripLegMode.Train]);
    const legId = trip.legs[0].id;

    const stations = await sut.getLegStations(auth, album.id, legId);
    expect(stations.departure.map(({ name }) => name)).toEqual(['Warszawa Centralna', 'Warszawa Ochota']);
    expect(stations.departure[0]).toEqual({ ...WARSAW_STATION, distance: expect.any(Number) });
    expect(stations.arrival.map(({ name }) => name)).toEqual(['Kraków Główny']);

    await expect(
      sut.setLegStation(auth, album.id, legId, stationDto('departure', { ...OTHER_STATION, name: 'Anywhere' })),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(sut.setLegStation(auth, album.id, legId, stationDto('arrival', OTHER_STATION))).rejects.toBeInstanceOf(
      BadRequestException,
    );

    const picked = await sut.setLegStation(auth, album.id, legId, stationDto('departure', OTHER_STATION));
    expect(picked.legs[0]).toMatchObject({
      status: 'pending',
      departureName: 'Warszawa Ochota',
      departureLatitude: OTHER_STATION.latitude,
      arrivalName: null,
    });
    const [leg] = await routeLegs();
    expect(leg).toMatchObject({ status: 'ok', departureName: 'Warszawa Ochota', arrivalName: 'Kraków Główny' });
    expect(requests.brouter[0].lonlats.startsWith(`${OTHER_STATION.longitude.toFixed(6)},`)).toBe(true);
    // The station lists came from the cache: two searches in all, one per end.
    expect(requests.overpass).toHaveLength(2);

    const driving = await sut.setLegMode(auth, album.id, legId, modeDto(TripLegMode.Driving));
    expect(driving.legs[0]).toMatchObject({
      departureName: null,
      departureLatitude: null,
      departureLongitude: null,
      arrivalName: null,
      arrivalLatitude: null,
      arrivalLongitude: null,
    });
    await expect(
      sut.setLegStation(auth, album.id, legId, stationDto('departure', OTHER_STATION)),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('answers 502 when the station search does not answer', async () => {
    const { sut, auth, album, places, importRoute } = await setup();
    fakeServices({ overpassDown: true });
    const trip = await importRoute([places.WARSAW, places.KRAKOW], [TripLegMode.Train]);

    await expect(sut.getLegStations(auth, album.id, trip.legs[0].id)).rejects.toBeInstanceOf(BadGatewayException);
  });

  it('retries only legs that need attention', async () => {
    const { sut, auth, album, places, importRoute, route } = await setup();
    fakeServices({ status: 503 });
    const trip = await importRoute([places.WARSAW, places.NEAR, places.FAR]);
    await route();
    const [first, second] = trip.legs;

    const all = await sut.retryLegs(auth, album.id);
    expect(all.legs.map(({ status }) => status)).toEqual(['pending', 'pending']);
    await expect(sut.retryLegs(auth, album.id)).rejects.toBeInstanceOf(BadRequestException);
    await expect(sut.retryLeg(auth, album.id, first.id)).rejects.toBeInstanceOf(BadRequestException);

    fakeServices();
    await route();
    await expect(sut.retryLeg(auth, album.id, second.id)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('answers 403 to a viewer and the album shared link, 404 to anyone else', async () => {
    const { ctx, sut, owner, album, places, importRoute } = await setup();
    fakeServices();
    const trip = await importRoute([places.WARSAW, places.FAR]);
    const legId = trip.legs[0].id;
    const { user: viewer } = await ctx.newUser();
    const { user: stranger } = await ctx.newUser();
    await ctx.newAlbumUser({ albumId: album.id, userId: viewer.id, role: AlbumUserRole.Viewer });
    const { sharedLink } = await ctx.newSharedLink({ userId: owner.id, type: SharedLinkType.Album, albumId: album.id });
    const callers = [
      [factory.auth({ user: viewer }), ForbiddenException],
      [factory.auth({ user: owner, sharedLink: { id: sharedLink.id } }), ForbiddenException],
      [factory.auth({ user: stranger }), NotFoundException],
    ] as const;

    for (const [auth, refusal] of callers) {
      await expect(sut.setLegMode(auth, album.id, legId, modeDto(TripLegMode.Foot))).rejects.toBeInstanceOf(refusal);
      await expect(sut.getLegStations(auth, album.id, legId)).rejects.toBeInstanceOf(refusal);
      await expect(
        sut.setLegStation(auth, album.id, legId, stationDto('departure', places.WARSAW_STATION)),
      ).rejects.toBeInstanceOf(refusal);
      await expect(sut.retryLeg(auth, album.id, legId)).rejects.toBeInstanceOf(refusal);
      await expect(sut.retryLegs(auth, album.id)).rejects.toBeInstanceOf(refusal);
    }
    await expect(sut.get(factory.auth({ user: owner }), album.id)).resolves.toMatchObject({ contentVersion: 1 });
  });

  it('refuses a leg of another trip', async () => {
    const { ctx, sut, owner, auth, album, places, importRoute } = await setup();
    fakeServices();
    const trip = await importRoute([places.WARSAW, places.FAR]);
    const { album: other } = await ctx.newAlbum({ ownerId: owner.id });
    const otherTrip = await sut.create(
      auth,
      TripCreateDto.schema.parse({ albumId: other.id, kind: 'route', start: places.WARSAW, finish: places.FAR }),
    );
    const foreign = otherTrip.legs[0].id;
    await db
      .updateTable('trip_leg')
      .set({ status: TripLegStatus.Attention })
      .where('albumId', 'in', [album.id, other.id])
      .execute();

    await expect(sut.setLegMode(auth, album.id, foreign, modeDto(TripLegMode.Foot))).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(sut.getLegStations(auth, album.id, foreign)).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      sut.setLegStation(auth, album.id, foreign, stationDto('departure', places.WARSAW_STATION)),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(sut.retryLeg(auth, album.id, foreign)).rejects.toBeInstanceOf(NotFoundException);
    const [mine, theirs] = await Promise.all([sut.get(auth, album.id), sut.get(auth, other.id)]);
    expect(mine.legs).toEqual(trip.legs.map((leg) => ({ ...leg, status: TripLegStatus.Attention })));
    expect(theirs.legs[0]).toMatchObject({ mode: 'driving', status: 'attention' });
  });
});
