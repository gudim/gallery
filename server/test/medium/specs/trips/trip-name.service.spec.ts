import { Kysely } from 'kysely';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { JobName, JobStatus } from 'src/enum.js';
import { AccessRepository } from 'src/repositories/access.repository.js';
import { JobRepository } from 'src/repositories/job.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { DB } from 'src/schema/index.js';
import { BaseService } from 'src/services/base.service.js';
import { TripCreateDto, TripImportDto, TripStopUpdateDto } from 'src/trips/dtos/trip.dto.js';
import { TripGeoService } from 'src/trips/enum.js';
import { TripGeoRepository } from 'src/trips/repositories/trip-geo.repository.js';
import { TripRepository } from 'src/trips/repositories/trip.repository.js';
import { TripNameService } from 'src/trips/services/trip-name.service.js';
import { TripService } from 'src/trips/services/trip.service.js';
import { newMediumService } from 'test/medium.factory.js';
import { factory } from 'test/small.factory.js';
import { getKyselyDB } from 'test/utils.js';

// Naming stops through Nominatim (trips PLAN D13) with fetch stubbed: no test reaches the network.
let db: Kysely<DB>;

beforeAll(async () => {
  db = await getKyselyDB();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

type Point = { latitude: number; longitude: number };
type Place = { city: string; suburb?: string; country: string };

// Points of their own for each test, so no test is served another one's cached answer.
const newPoints = (count: number): Point[] => {
  const latitude = 40 + Math.round(Math.random() * 1e6) / 1e5;
  return Array.from({ length: count }, (_, index) => ({ latitude: latitude + index, longitude: 25.28 }));
};

// A Nominatim that knows the given points in the given languages and nothing elsewhere, and is down at `down`.
const stubNominatim = (
  places: Array<[Point, Record<string, Place>]>,
  { onRequest, down }: { onRequest?: () => Promise<void>; down?: Point } = {},
) => {
  const known = new Map(places.map(([point, names]) => [point.latitude.toFixed(6), names]));
  const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (input) => {
    await onRequest?.();
    const url = new URL(String(input));
    if (url.searchParams.get('lat') === down?.latitude.toFixed(6)) {
      return new Response('busy', { status: 503 });
    }
    const names = known.get(url.searchParams.get('lat')!);
    const place = names?.[url.searchParams.get('accept-language')!];
    if (!place) {
      return Response.json({ error: 'Unable to geocode' });
    }
    const { city, suburb, country } = place;
    return Response.json({ name: 'Point', display_name: `Point, ${country}`, address: { city, suburb, country } });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
};

const languageOf = (call: Parameters<typeof fetch>) => new URL(String(call[0])).searchParams.get('accept-language');

const VILNIUS = {
  ru: { city: 'Вильнюс', suburb: 'Старый город', country: 'Литва' },
  en: { city: 'Vilnius', suburb: 'Old Town', country: 'Lithuania' },
};
const KAUNAS = {
  ru: { city: 'Каунас', suburb: 'Аламяда', country: 'Литва' },
  en: { city: 'Kaunas', suburb: 'Aleksotas', country: 'Lithuania' },
};

const setup = async () => {
  const { ctx } = newMediumService(BaseService, { database: db, real: [], mock: [LoggingRepository, JobRepository] });
  const job = ctx.getMock(JobRepository);
  job.queue.mockResolvedValue();
  job.queueAll.mockResolvedValue();
  const tripRepository = new TripRepository(db);
  const geo = new TripGeoRepository(db, LoggingRepository.create());
  // The rate limit has its own test; here every request goes at once.
  vi.spyOn(geo, 'reserveTurn').mockResolvedValue(0);
  const trips = new TripService(new AccessRepository(db), job, tripRepository, geo);
  const sut = new TripNameService(LoggingRepository.create(), tripRepository, geo);
  const { user: owner } = await ctx.newUser();
  const auth = factory.auth({ user: owner });

  // An album with one asset at each point, an hour apart, laid out as a trip of `kind`.
  const newTrip = async (kind: string, points: Point[], extra: Record<string, unknown> = {}) => {
    const assetIds = [];
    for (const [index, point] of points.entries()) {
      const { asset } = await ctx.newAsset({
        ownerId: owner.id,
        localDateTime: new Date(`2026-05-01T${10 + index}:00:00.000Z`),
      });
      await ctx.newExif({ assetId: asset.id, ...point });
      assetIds.push(asset.id);
    }
    const { album } = await ctx.newAlbum({ ownerId: owner.id }, assetIds);
    await trips.create(auth, TripCreateDto.schema.parse({ albumId: album.id, kind, ...extra }));
    return album.id;
  };

  return { ctx, job, geo, trips, sut, owner, auth, newTrip };
};

describe(TripNameService.name, () => {
  it('names new stops with a title, region and country, and keeps the second language in the cache', async () => {
    const { sut, trips, auth, newTrip } = await setup();
    const [home, a, b] = newPoints(3);
    const fetchMock = stubNominatim([
      [home, VILNIUS],
      [a, KAUNAS],
      [b, { ru: { city: 'Биржай', country: 'Литва' }, en: { city: 'Biržai', country: 'Lithuania' } }],
    ]);
    const albumId = await newTrip('route', [a, b], { start: home, isFinishAtStart: true });

    await expect(sut.handleName({ id: albumId })).resolves.toBe(JobStatus.Success);

    const trip = await trips.get(auth, albumId);
    expect(trip.contentVersion).toBe(2);
    expect(
      trip.stops.map(({ role, title, titleSource, region, country }) => [role, title, titleSource, region, country]),
    ).toEqual([
      ['start', 'Вильнюс', 'geocoded', 'Вильнюс', 'Литва'],
      [null, 'Каунас', 'geocoded', 'Каунас', 'Литва'],
      [null, 'Биржай', 'geocoded', 'Биржай', 'Литва'],
      ['finish', 'Вильнюс', 'geocoded', 'Вильнюс', 'Литва'],
    ]);
    // each point once in each language; the finish at the start is not asked for
    expect(fetchMock.mock.calls.map((call) => languageOf(call))).toEqual(['ru', 'en', 'ru', 'en', 'ru', 'en']);
    const english = await db
      .selectFrom('trip_geo_cache')
      .select('response')
      .where('service', '=', TripGeoService.Nominatim)
      .where('request', 'like', `%accept-language=en%lat=${a.latitude.toFixed(6)}%`)
      .executeTakeFirstOrThrow();
    expect(english.response).toMatchObject({ address: { city: 'Kaunas', country: 'Lithuania' } });
  });

  it('names a trip made in German in German, and a trip without a language in the instance default', async () => {
    const { sut, trips, auth, newTrip } = await setup();
    const [a, b] = newPoints(2);
    const MUNICH = {
      de: { city: 'München', country: 'Deutschland' },
      ru: { city: 'Мюнхен', country: 'Германия' },
      en: { city: 'Munich', country: 'Germany' },
    };
    const fetchMock = stubNominatim([
      [a, MUNICH],
      [b, MUNICH],
    ]);
    const germanId = await newTrip('route', [a], { language: 'de' });
    const defaultId = await newTrip('route', [b]);

    await sut.handleName({ id: germanId });
    await sut.handleName({ id: defaultId });

    const german = await trips.get(auth, germanId);
    expect(german).toMatchObject({ language: 'de' });
    expect(german.stops[0]).toMatchObject({ title: 'München', region: 'München', country: 'Deutschland' });
    const byDefault = await trips.get(auth, defaultId);
    expect(byDefault).toMatchObject({ language: null });
    expect(byDefault.stops[0]).toMatchObject({ title: 'Мюнхен', country: 'Германия' });
    // every instance language but the trip's own, for search
    expect(fetchMock.mock.calls.map((call) => languageOf(call))).toEqual(['de', 'ru', 'en', 'ru', 'en']);
  });

  it('names a place by city and district', async () => {
    const { sut, trips, auth, newTrip } = await setup();
    const [a] = newPoints(1);
    stubNominatim([[a, VILNIUS]]);
    const albumId = await newTrip('places', [a]);

    await sut.handleName({ id: albumId });

    const trip = await trips.get(auth, albumId);
    expect(trip.stops).toEqual([expect.objectContaining({ title: 'Вильнюс — Старый город', region: 'Вильнюс' })]);
  });

  it('never replaces a title the owner wrote, and serves a cleared one from the cache', async () => {
    const { job, sut, trips, auth, newTrip } = await setup();
    const [a, b] = newPoints(2);
    const fetchMock = stubNominatim([
      [a, VILNIUS],
      [b, KAUNAS],
    ]);
    const albumId = await newTrip('route', [a, b]);
    const { stops } = await trips.get(auth, albumId);
    const [first, second] = stops;
    await trips.updateStop(auth, albumId, first.id, TripStopUpdateDto.schema.parse({ title: 'Old Town' }));

    await sut.handleName({ id: albumId });

    const named = await trips.get(auth, albumId);
    expect(named.stops.map(({ title, titleSource }) => [title, titleSource])).toEqual([
      ['Old Town', 'manual'],
      ['Каунас', 'geocoded'],
    ]);

    job.queue.mockClear();
    fetchMock.mockClear();
    await trips.updateStop(auth, albumId, second.id, TripStopUpdateDto.schema.parse({ title: ' ' }));
    expect(job.queue).toHaveBeenCalledWith({ name: JobName.TripName, data: { id: albumId } });
    await sut.handleName({ id: albumId });

    expect(fetchMock).not.toHaveBeenCalled();
    const renamed = await trips.get(auth, albumId);
    expect(renamed.stops.map(({ title }) => title)).toEqual(['Old Town', 'Каунас']);
  });

  it('leaves a stop moved while Nominatim was asked to the next run', async () => {
    const { sut, trips, auth, newTrip } = await setup();
    const [a, moved] = newPoints(2);
    const albumId = await newTrip('route', [a]);
    const {
      stops: [stop],
    } = await trips.get(auth, albumId);
    let isMoved = false;
    stubNominatim(
      [
        [a, VILNIUS],
        [moved, KAUNAS],
      ],
      {
        onRequest: async () => {
          if (isMoved) {
            return;
          }

          isMoved = true;
          await db.updateTable('trip_stop').set(moved).where('id', '=', stop.id).execute();
        },
      },
    );

    await sut.handleName({ id: albumId });

    const pending = await trips.get(auth, albumId);
    expect(pending.contentVersion).toBe(1);
    expect(pending.stops[0]).toMatchObject({ title: null, titleSource: null, region: null });

    await sut.handleName({ id: albumId });

    const named = await trips.get(auth, albumId);
    expect(named.stops[0]).toMatchObject({ title: 'Каунас', region: 'Каунас' });
  });

  it('keeps what it found when Nominatim fails, caches nothing of the failure, and fails the job', async () => {
    const { sut, trips, auth, newTrip } = await setup();
    const [a, b] = newPoints(2);
    const albumId = await newTrip('route', [a, b]);
    stubNominatim([[a, VILNIUS]], { down: b });

    await expect(sut.handleName({ id: albumId })).resolves.toBe(JobStatus.Failed);

    const trip = await trips.get(auth, albumId);
    expect(trip.stops.map(({ title }) => title)).toEqual(['Вильнюс', null]);
    const cached = await db
      .selectFrom('trip_geo_cache')
      .select('key')
      .where('request', 'like', `%lat=${b.latitude.toFixed(6)}%`)
      .execute();
    expect(cached).toEqual([]);
  });

  it('leaves a Plain trip, and a stop Nominatim does not know, without a title', async () => {
    const { sut, trips, auth, newTrip } = await setup();
    const [a, nowhere] = newPoints(2);
    const fetchMock = stubNominatim([[a, VILNIUS]]);
    const plainId = await newTrip('plain', [a]);
    const routeId = await newTrip('route', [nowhere]);

    await expect(sut.handleName({ id: plainId })).resolves.toBe(JobStatus.Skipped);
    await expect(sut.handleName({ id: routeId })).resolves.toBe(JobStatus.Success);

    expect(fetchMock.mock.calls.map((call) => languageOf(call))).toEqual(['ru']);
    const trip = await trips.get(auth, routeId);
    expect(trip).toMatchObject({ contentVersion: 1, stops: [expect.objectContaining({ title: null })] });
  });

  it('asks for the second language of names an imported trip brought', async () => {
    const { job, sut, trips, auth, owner, ctx } = await setup();
    const [a] = newPoints(1);
    const fetchMock = stubNominatim([[a, VILNIUS]]);
    const { album } = await ctx.newAlbum({ ownerId: owner.id }, []);
    const stop = {
      key: 'old-town',
      placeKey: null,
      ...a,
      isPositionManual: false,
      localStart: null,
      localEnd: null,
      sequence: 0,
      title: 'Old Town',
      titleSource: 'geocoded',
      story: null,
      storySource: null,
      region: 'Вильнюс',
      country: 'Литва',
      isAddedByHand: false,
      role: null,
      isFinishAtStart: false,
      isTransit: null,
      isAtCenter: false,
    };
    await trips.import(
      auth,
      album.id,
      TripImportDto.schema.parse({
        kind: 'route',
        isFavorites: false,
        isShowcased: false,
        places: [],
        stops: [stop],
        assets: [],
        legs: [],
        overlays: [],
        likes: [],
      }),
    );
    expect(job.queue).toHaveBeenCalledWith({ name: JobName.TripName, data: { id: album.id } });

    await sut.handleName({ id: album.id });

    expect(fetchMock.mock.calls.map((call) => languageOf(call))).toEqual(['ru', 'en']);
    const trip = await trips.get(auth, album.id);
    expect(trip).toMatchObject({ contentVersion: 1, stops: [expect.objectContaining({ title: 'Old Town' })] });
  });

  it('is queued where stops appear: a new trip with a map, filing that opened stops, and the nightly sweep', async () => {
    const { ctx, job, sut, trips, owner, newTrip } = await setup();
    // A route also queues routing; this test is about naming.
    const naming = () => job.queue.mock.calls.filter(([item]) => item.name === JobName.TripName);
    const [a, b, far] = newPoints(3);
    stubNominatim([
      [a, VILNIUS],
      [b, KAUNAS],
    ]);
    const plainId = await newTrip('plain', [a]);
    const routeId = await newTrip('route', [a, b]);
    expect(naming()).toEqual([[{ name: JobName.TripName, data: { id: routeId } }]]);
    await sut.handleName({ id: routeId });

    job.queue.mockClear();
    await trips.handleFile({ id: routeId });
    const { asset } = await ctx.newAsset({ ownerId: owner.id, localDateTime: new Date('2026-05-01T20:00:00.000Z') });
    await ctx.newExif({ assetId: asset.id, ...far });
    await db
      .insertInto('asset_job_status')
      .values({ assetId: asset.id, metadataExtractedAt: new Date() })
      .onConflict((oc) => oc.column('assetId').doUpdateSet({ metadataExtractedAt: new Date() }))
      .execute();
    await ctx.newAlbumAsset({ albumId: routeId, assetId: asset.id });
    await trips.handleFile({ id: routeId });
    expect(naming()).toEqual([[{ name: JobName.TripName, data: { id: routeId } }]]);

    await trips.handleFileSweep();
    const swept = job.queueAll.mock.calls.at(-1)![0];
    expect(swept).toContainEqual({ name: JobName.TripName, data: { id: routeId } });
    expect(swept).not.toContainEqual({ name: JobName.TripName, data: { id: plainId } });
  });
});
