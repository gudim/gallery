import { BadGatewayException, BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { Kysely } from 'kysely';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { AlbumUserRole, JobName } from 'src/enum.js';
import { AccessRepository } from 'src/repositories/access.repository.js';
import { AssetFavoriteRepository } from 'src/repositories/asset-favorite.repository.js';
import { JobRepository } from 'src/repositories/job.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { DB } from 'src/schema/index.js';
import { BaseService } from 'src/services/base.service.js';
import {
  TripAssetPointDto,
  TripAssetsCenterDto,
  TripAssetsMoveDto,
  TripCreateDto,
  TripEndDto,
  TripFinishUpdateDto,
  TripGeoReverseQueryDto,
  TripGeoSearchDto,
  TripPointCreateDto,
  TripPointOrderDto,
  TripResponseDto,
  TripStopCreateDto,
  TripStopSplitDto,
  TripStopUpdateDto,
  TripTransitUpdateDto,
} from 'src/trips/dtos/trip.dto.js';
import { TripLegMode, TripLegStatus } from 'src/trips/enum.js';
import { TripEditorRepository } from 'src/trips/repositories/trip-editor.repository.js';
import { TripFilingRepository } from 'src/trips/repositories/trip-filing.repository.js';
import { TripGeoRepository } from 'src/trips/repositories/trip-geo.repository.js';
import { TripNameRepository } from 'src/trips/repositories/trip-name.repository.js';
import { TripRouteRepository } from 'src/trips/repositories/trip-route.repository.js';
import { TripRepository } from 'src/trips/repositories/trip.repository.js';
import { TripService } from 'src/trips/services/trip.service.js';
import { newMediumService } from 'test/medium.factory.js';
import { factory } from 'test/small.factory.js';
import { getKyselyDB } from 'test/utils.js';

// The stop editor against Postgres (trips PLAN §2.5, travel-album tests/integration/test_editor.py). Every trip is
// made by `create` from an album of the owner's assets, so stops and legs are what the layout gives.
let db: Kysely<DB>;

beforeAll(async () => {
  db = await getKyselyDB();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const HOME = { latitude: 54.6, longitude: 25.2 };
const A = { latitude: 54.68, longitude: 25.28 };
const B = { latitude: 54.9, longitude: 25.3 };
const C = { latitude: 55.1, longitude: 25.5 };

type Shot = [time: string, point: { latitude: number; longitude: number } | null];

// Three stops of a route from home: A (two assets), B (three), C (one).
const SHOTS: Shot[] = [
  ['10:00', A],
  ['10:10', A],
  ['12:00', B],
  ['12:10', B],
  ['12:20', B],
  ['15:00', C],
];

const setup = async (shots: Shot[] = SHOTS, kind = 'route', { withStart = true } = {}) => {
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
    new TripFilingRepository(db),
    new TripRouteRepository(db),
    new TripNameRepository(db),
    geo,
    new TripEditorRepository(db),
    new AssetFavoriteRepository(db),
  );
  const { user: owner } = await ctx.newUser();
  const newAlbum = async () => {
    const assetIds = [];
    for (const [time, point] of shots) {
      const { asset } = await ctx.newAsset({
        ownerId: owner.id,
        localDateTime: new Date(`2026-05-01T${time}:00.000Z`),
      });
      if (point) {
        await ctx.newExif({ assetId: asset.id, ...point });
      }
      assetIds.push(asset.id);
    }
    const { album } = await ctx.newAlbum({ ownerId: owner.id }, assetIds);
    return { album, assetIds };
  };
  const auth = factory.auth({ user: owner });
  const newTrip = async () => {
    const { album, assetIds } = await newAlbum();
    const trip = await sut.create(
      auth,
      TripCreateDto.schema.parse({ albumId: album.id, kind, ...(kind === 'route' && withStart && { start: HOME }) }),
    );
    return { album, assetIds, trip };
  };
  const { album, assetIds, trip } = await newTrip();
  // Every leg built, a train with its stations, so an edit that routes one again shows.
  await db
    .updateTable('trip_leg')
    .set({ status: TripLegStatus.Ok, polyline: 'built', departureName: 'Old station', departureLatitude: 1 })
    .where('albumId', '=', album.id)
    .execute();
  job.queue.mockClear();
  return { ctx, job, sut, owner, auth, album, assetIds, trip, newTrip };
};

const read = (sut: TripService, auth: ReturnType<typeof factory.auth>, albumId: string) => sut.get(auth, albumId);
const stopChanges = (dto: Record<string, unknown>) => TripStopUpdateDto.schema.parse(dto);
const routeJob = (id: string) => ({ name: JobName.TripRouteLegs, data: { id } });
const nameJob = (id: string) => ({ name: JobName.TripName, data: { id } });
const filed = (trip: TripResponseDto, stopId: string) =>
  trip.assets.filter((asset) => asset.stopId === stopId).map(({ assetId }) => assetId);
const legPairs = (trip: TripResponseDto) =>
  trip.legs.map(({ fromStopId, toStopId, status }) => [fromStopId, toStopId, status]);

// A Nominatim answer of one place in Vilnius.
const nominatimPlace = (name: string) => ({
  name,
  lat: '54.68',
  lon: '25.28',
  address: { city: 'Vilnius', country: 'Lithuania' },
});

// A unit CLIP embedding along axis `i`, turned towards axis `j` so that `cos` is its similarity to axis `i`.
const embedding = (i: number, cos = 1, j = 511) =>
  JSON.stringify(Array.from({ length: 512 }, (_, k) => (k === i ? cos : k === j ? Math.sqrt(1 - cos ** 2) : 0)));

// An asset's local time as metadata extraction writes it after a date edit.
const shiftTime = (assetId: string, time: string) =>
  db
    .updateTable('asset')
    .set({ localDateTime: new Date(`2026-05-01T${time}:00.000Z`) })
    .where('id', '=', assetId)
    .execute();

const fakeNominatim = (respond: (url: URL) => Response) => {
  const urls: URL[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn<typeof fetch>((input) => {
      const url = new URL(String(input));
      urls.push(url);
      return Promise.resolve(respond(url));
    }),
  );
  return urls;
};

describe('stop editor', () => {
  describe('pin', () => {
    it('moves a pin by hand: its legs are routed again without stations, the others keep their line', async () => {
      const { job, sut, auth, album, trip } = await setup();
      const [start, a, b, c] = trip.stops;
      const P = { latitude: 54.95, longitude: 25.35 };

      const edited = await sut.updateStop(auth, album.id, b.id, stopChanges(P));

      expect(edited.stops[2]).toMatchObject({ ...P, isPositionManual: true });
      expect(legPairs(edited)).toEqual([
        [start.id, a.id, 'ok'],
        [a.id, b.id, 'pending'],
        [b.id, c.id, 'pending'],
      ]);
      expect(edited.legs[1]).toMatchObject({ polyline: null, departureName: null, departureLatitude: null });
      expect(edited.legs[0]).toMatchObject({ polyline: 'built', departureName: 'Old station' });
      expect(edited.contentVersion).toBe(trip.contentVersion + 1);
      expect(job.queue).toHaveBeenCalledWith(routeJob(album.id));
    });

    it('gives a pin back to the mean of its assets', async () => {
      const { sut, auth, album, trip } = await setup();
      const b = trip.stops[2];
      await sut.updateStop(auth, album.id, b.id, stopChanges({ latitude: 54.95, longitude: 25.35 }));

      const edited = await sut.updateStop(auth, album.id, b.id, stopChanges({ isPositionManual: false }));

      expect(edited.stops[2]).toMatchObject({ ...B, isPositionManual: false });
    });

    it('leaves the times and centres of stops a text edit does not touch', async () => {
      const { job, sut, auth, album, trip } = await setup();
      await db.updateTable('trip_stop').set({ latitude: 54.7 }).where('id', '=', trip.stops[1].id).execute();

      const edited = await sut.updateStop(auth, album.id, trip.stops[2].id, stopChanges({ story: 'Rain.' }));

      expect(edited.stops[1].latitude).toBe(54.7);
      expect(edited.legs.every(({ status }) => status === 'ok')).toBe(true);
      expect(job.queue).not.toHaveBeenCalledWith(routeJob(album.id));
    });

    it('names a stop again when its title is cleared', async () => {
      const { job, sut, auth, album, trip } = await setup();

      await sut.updateStop(auth, album.id, trip.stops[1].id, stopChanges({ title: ' ' }));

      expect(job.queue).toHaveBeenCalledWith(nameJob(album.id));
    });

    it('refuses to move the start, or a pin of a Plain trip', async () => {
      const { sut, auth, album, trip } = await setup();
      const plain = await setup(SHOTS, 'plain');

      await expect(
        sut.updateStop(auth, album.id, trip.stops[0].id, stopChanges({ latitude: 1, longitude: 1 })),
      ).rejects.toBeInstanceOf(BadRequestException);
      await expect(
        sut.updateStop(auth, album.id, trip.stops[0].id, stopChanges({ isPositionManual: false })),
      ).rejects.toBeInstanceOf(BadRequestException);
      await expect(
        plain.sut.updateStop(
          plain.auth,
          plain.album.id,
          plain.trip.stops[0].id,
          stopChanges({ latitude: 1, longitude: 1 }),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
      await expect(read(sut, auth, album.id)).resolves.toMatchObject({ contentVersion: trip.contentVersion });
    });

    it('takes a pin with both coordinates, and not with its giving back', () => {
      expect(TripStopUpdateDto.schema.safeParse({ latitude: 1 }).success).toBe(false);
      expect(TripStopUpdateDto.schema.safeParse({ latitude: 1, longitude: 1, isPositionManual: false }).success).toBe(
        false,
      );
      expect(TripStopUpdateDto.schema.safeParse({ isPositionManual: true }).success).toBe(false);
    });
  });

  describe('merge with the next', () => {
    it('moves the assets to the first stop, which takes the texts it lacks, and joins the legs', async () => {
      const { job, sut, auth, album, assetIds, trip } = await setup();
      const [start, a, b, c] = trip.stops;
      await sut.updateStop(auth, album.id, a.id, stopChanges({ title: 'A' }));
      await sut.updateStop(auth, album.id, b.id, stopChanges({ title: 'B', story: 'Lunch.' }));
      job.queue.mockClear();

      const edited = await sut.mergeNextStop(auth, album.id, a.id);

      expect(edited.stops.map(({ id }) => id)).toEqual([start.id, a.id, c.id]);
      expect(edited.stops[1]).toMatchObject({
        title: 'A',
        story: 'Lunch.',
        storySource: 'manual',
        localStart: '2026-05-01T10:00:00.000Z',
        localEnd: '2026-05-01T12:20:00.000Z',
      });
      expect(filed(edited, a.id)).toEqual(assetIds.slice(0, 5));
      expect(legPairs(edited)).toEqual([
        [start.id, a.id, 'pending'],
        [a.id, c.id, 'pending'],
      ]);
      expect(job.queue).toHaveBeenCalledWith(routeJob(album.id));
    });

    it('refuses the start, and the last stop', async () => {
      const { sut, auth, album, trip } = await setup();

      await expect(sut.mergeNextStop(auth, album.id, trip.stops[0].id)).rejects.toBeInstanceOf(BadRequestException);
      await expect(sut.mergeNextStop(auth, album.id, trip.stops[3].id)).rejects.toBeInstanceOf(BadRequestException);
      await expect(read(sut, auth, album.id)).resolves.toMatchObject({ contentVersion: trip.contentVersion });
    });
  });

  describe('split', () => {
    it('moves the asset and the later ones into a new stop after it', async () => {
      const { sut, auth, album, assetIds, trip } = await setup();
      const [start, a, b, c] = trip.stops;

      const edited = await sut.splitStop(auth, album.id, b.id, TripStopSplitDto.schema.parse({ assetId: assetIds[3] }));

      expect(edited.stops).toHaveLength(5);
      const added = edited.stops[3];
      expect(edited.stops[2]).toMatchObject({ id: b.id, localEnd: '2026-05-01T12:00:00.000Z' });
      expect(added).toMatchObject({
        ...B,
        localStart: '2026-05-01T12:10:00.000Z',
        localEnd: '2026-05-01T12:20:00.000Z',
      });
      expect(filed(edited, added.id)).toEqual(assetIds.slice(3, 5));
      expect(legPairs(edited)).toEqual([
        [start.id, a.id, 'ok'],
        [a.id, b.id, 'ok'],
        [b.id, added.id, 'pending'],
        [added.id, c.id, 'pending'],
      ]);
    });

    it('refuses the first asset, and an asset of another stop', async () => {
      const { sut, auth, album, assetIds, trip } = await setup();
      const b = trip.stops[2];
      const split = (assetId: string) =>
        sut.splitStop(auth, album.id, b.id, TripStopSplitDto.schema.parse({ assetId }));

      await expect(split(assetIds[2])).rejects.toBeInstanceOf(BadRequestException);
      await expect(split(assetIds[0])).rejects.toBeInstanceOf(BadRequestException);
      await expect(read(sut, auth, album.id)).resolves.toMatchObject({ contentVersion: trip.contentVersion });
    });
  });

  describe('assets', () => {
    it('moves assets to another stop, whose times and centre follow them', async () => {
      const { sut, auth, album, assetIds, trip } = await setup();
      const [, a, b, c] = trip.stops;

      const edited = await sut.moveAssets(
        auth,
        album.id,
        TripAssetsMoveDto.schema.parse({ assetIds: [assetIds[4]], stopId: c.id }),
      );

      expect(filed(edited, c.id)).toEqual([assetIds[4], assetIds[5]]);
      expect(edited.stops[3]).toMatchObject({
        latitude: expect.closeTo((B.latitude + C.latitude) / 2, 6),
        longitude: expect.closeTo((B.longitude + C.longitude) / 2, 6),
        localStart: '2026-05-01T12:20:00.000Z',
      });
      expect(edited.stops[2]).toMatchObject({ ...B, localEnd: '2026-05-01T12:10:00.000Z' });
      expect(legPairs(edited).slice(2)).toEqual([[b.id, c.id, 'pending']]);
      expect(edited.legs[1]).toMatchObject({ fromStopId: a.id, status: 'ok' });
    });

    it('refuses a move that empties a stop, or goes to the start', async () => {
      const { sut, auth, album, assetIds, trip } = await setup();
      const [start, , b, c] = trip.stops;
      const move = (ids: string[], stopId: string) =>
        sut.moveAssets(auth, album.id, TripAssetsMoveDto.schema.parse({ assetIds: ids, stopId }));

      await expect(move([assetIds[5]], b.id)).rejects.toBeInstanceOf(BadRequestException);
      await expect(move([assetIds[2]], start.id)).rejects.toBeInstanceOf(BadRequestException);
      await expect(move([assetIds[2], assetIds[5]], c.id)).resolves.toBeDefined();
    });

    it('makes a new stop of the chosen assets, in its place by their times', async () => {
      const { sut, auth, album, assetIds, trip } = await setup();
      const [start, a, b, c] = trip.stops;

      const edited = await sut.createStop(auth, album.id, TripStopCreateDto.schema.parse({ assetIds: [assetIds[1]] }));

      const added = edited.stops[2];
      expect(edited.stops.map(({ id }) => id)).toEqual([start.id, a.id, added.id, b.id, c.id]);
      expect(added).toMatchObject({ ...A, localStart: '2026-05-01T10:10:00.000Z', isAddedByHand: false });
      expect(filed(edited, added.id)).toEqual([assetIds[1]]);
    });

    it('refuses an asset in the trash', async () => {
      const { sut, auth, album, assetIds, trip } = await setup();
      await db.updateTable('asset').set({ deletedAt: new Date() }).where('id', '=', assetIds[2]).execute();

      await expect(
        sut.moveAssets(
          auth,
          album.id,
          TripAssetsMoveDto.schema.parse({ assetIds: [assetIds[2]], stopId: trip.stops[3].id }),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('delete', () => {
    it('deletes a stop without assets; its neighbours get one leg', async () => {
      const { sut, auth, album, trip } = await setup();
      const [start, a, b, c] = trip.stops;
      // An empty stop is only left behind by hand: a move refuses to empty one.
      await db.updateTable('trip_asset').set({ stopId: b.id }).where('stopId', '=', c.id).execute();

      const edited = await sut.deleteStop(auth, album.id, c.id);

      expect(edited.stops.map(({ id }) => id)).toEqual([start.id, a.id, b.id]);
      expect(legPairs(edited).map(([from, to]) => [from, to])).toEqual([
        [start.id, a.id],
        [a.id, b.id],
      ]);
    });

    it('refuses a stop with assets, an asset in the trash among them, and the start', async () => {
      const { sut, auth, album, assetIds, trip } = await setup();
      await db.updateTable('asset').set({ deletedAt: new Date() }).where('id', '=', assetIds[5]).execute();

      await expect(sut.deleteStop(auth, album.id, trip.stops[3].id)).rejects.toBeInstanceOf(BadRequestException);
      await expect(sut.deleteStop(auth, album.id, trip.stops[0].id)).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('points', () => {
    const P = { latitude: 54.8, longitude: 25.29 };

    it('adds a point right after a stop, at its end time, and routes and names it', async () => {
      const { job, sut, auth, album, trip } = await setup();
      const [start, a, b, c] = trip.stops;

      const edited = await sut.addPoint(auth, album.id, TripPointCreateDto.schema.parse({ ...P, afterStopId: a.id }));

      const point = edited.stops[2];
      expect(edited.stops.map(({ id }) => id)).toEqual([start.id, a.id, point.id, b.id, c.id]);
      expect(point).toMatchObject({
        ...P,
        isAddedByHand: true,
        isPositionManual: true,
        title: null,
        localStart: '2026-05-01T10:10:00.000Z',
      });
      expect(legPairs(edited)).toEqual([
        [start.id, a.id, 'ok'],
        [a.id, point.id, 'pending'],
        [point.id, b.id, 'pending'],
        [b.id, c.id, 'ok'],
      ]);
      expect(job.queue).toHaveBeenCalledWith(routeJob(album.id));
      expect(job.queue).toHaveBeenCalledWith(nameJob(album.id));
    });

    it('puts a point right after the start, and moves it after another stop', async () => {
      const { sut, auth, album, trip } = await setup();
      const [start, a, b, c] = trip.stops;

      const added = await sut.addPoint(
        auth,
        album.id,
        TripPointCreateDto.schema.parse({ ...P, title: 'Lake', afterStopId: null }),
      );
      const point = added.stops[1];
      expect(added.stops.map(({ id }) => id)).toEqual([start.id, point.id, a.id, b.id, c.id]);
      expect(point).toMatchObject({ title: 'Lake', titleSource: 'manual', localStart: null });

      const moved = await sut.movePoint(
        auth,
        album.id,
        point.id,
        TripPointOrderDto.schema.parse({ afterStopId: b.id }),
      );

      expect(moved.stops.map(({ id }) => id)).toEqual([start.id, a.id, b.id, point.id, c.id]);
      expect(moved.stops[3].localStart).toBe('2026-05-01T12:20:00.000Z');
    });

    it('refuses a point after the finish, a stop of assets in the order, and a trip that is not a route', async () => {
      const { sut, auth, album, trip } = await setup();
      const places = await setup(SHOTS, 'places');
      const withFinish = await sut.setFinish(auth, album.id, TripFinishUpdateDto.schema.parse(P));
      const finish = withFinish.stops.at(-1)!;

      await expect(
        sut.addPoint(auth, album.id, TripPointCreateDto.schema.parse({ ...P, afterStopId: finish.id })),
      ).rejects.toBeInstanceOf(BadRequestException);
      await expect(
        sut.movePoint(auth, album.id, trip.stops[1].id, TripPointOrderDto.schema.parse({ afterStopId: null })),
      ).rejects.toBeInstanceOf(BadRequestException);
      await expect(
        places.sut.addPoint(places.auth, places.album.id, TripPointCreateDto.schema.parse(P)),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('start and finish', () => {
    const P = { latitude: 54.65, longitude: 25.25 };

    it('moves the start: its leg is routed again and the cleared title named', async () => {
      const { job, sut, auth, album, trip } = await setup();

      const edited = await sut.setStart(auth, album.id, TripEndDto.schema.parse(P));

      expect(edited.stops[0]).toMatchObject({ ...P, role: 'start', title: null, id: trip.stops[0].id });
      expect(edited.legs.map(({ status }) => status)).toEqual(['pending', 'ok', 'ok']);
      expect(job.queue).toHaveBeenCalledWith(nameJob(album.id));
    });

    it('puts the finish at the start, which it follows and goes with', async () => {
      const { sut, auth, album, trip } = await setup();
      const c = trip.stops[3];

      const withFinish = await sut.setFinish(
        auth,
        album.id,
        TripFinishUpdateDto.schema.parse({ isFinishAtStart: true }),
      );
      expect(withFinish.stops[4]).toMatchObject({ ...HOME, role: 'finish', isFinishAtStart: true });
      expect(withFinish.legs.at(-1)).toMatchObject({ fromStopId: c.id, toStopId: withFinish.stops[4].id });

      const moved = await sut.setStart(auth, album.id, TripEndDto.schema.parse({ ...P, title: 'Home' }));
      expect(moved.stops[4]).toMatchObject({ ...P, title: 'Home', role: 'finish', isFinishAtStart: true });

      const removed = await sut.setStart(auth, album.id, null);
      expect(removed.stops.map(({ role }) => role)).toEqual([null, null, null]);
      expect(removed.legs).toHaveLength(2);
    });

    it('sets and removes a finish of its own, and refuses a finish at a start that is not there', async () => {
      const { sut, auth, album } = await setup();

      const withFinish = await sut.setFinish(auth, album.id, TripFinishUpdateDto.schema.parse(P));
      expect(withFinish.stops.at(-1)).toMatchObject({ ...P, role: 'finish', isFinishAtStart: false });
      const removed = await sut.setFinish(auth, album.id, null);
      expect(removed.stops.at(-1)?.role).toBeNull();

      await sut.setStart(auth, album.id, null);
      await expect(
        sut.setFinish(auth, album.id, TripFinishUpdateDto.schema.parse({ isFinishAtStart: true })),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('takes a finish with either a point or isFinishAtStart', () => {
      expect(TripFinishUpdateDto.schema.safeParse({}).success).toBe(false);
      expect(TripFinishUpdateDto.schema.safeParse({ ...P, isFinishAtStart: true }).success).toBe(false);
    });

    it('refuses a start on a trip that is not a route', async () => {
      const plain = await setup(SHOTS, 'plain');

      await expect(plain.sut.setStart(plain.auth, plain.album.id, TripEndDto.schema.parse(P))).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });
  });

  describe('transit', () => {
    it('lays a transit stop on the leg between the stops around it', async () => {
      const { sut, auth, album, trip } = await setup();
      const [start, a, b, c] = trip.stops;

      const edited = await sut.setTransit(
        auth,
        album.id,
        TripTransitUpdateDto.schema.parse({ stopIds: [b.id], isTransit: true }),
      );

      expect(edited.stops[2]).toMatchObject({ id: b.id, isTransit: true });
      expect(edited.legs.map(({ fromStopId, toStopId, mode }) => [fromStopId, toStopId, mode])).toEqual([
        [start.id, a.id, 'driving'],
        [a.id, c.id, 'driving'],
      ]);

      const back = await sut.setTransit(
        auth,
        album.id,
        TripTransitUpdateDto.schema.parse({ stopIds: [b.id], isTransit: false }),
      );
      expect(back.stops[2].isTransit).toBe(false);
      expect(back.legs).toHaveLength(3);
    });

    it('makes the leg a flight when a leg it replaces was one', async () => {
      const { sut, auth, album, trip } = await setup();
      const [, a, b, c] = trip.stops;
      await db.updateTable('trip_leg').set({ mode: TripLegMode.Flight }).where('fromStopId', '=', a.id).execute();

      const edited = await sut.setTransit(
        auth,
        album.id,
        TripTransitUpdateDto.schema.parse({ stopIds: [b.id], isTransit: true }),
      );

      expect(edited.legs[1]).toMatchObject({
        fromStopId: a.id,
        toStopId: c.id,
        mode: 'flight',
        isModeManual: true,
        status: 'pending',
      });
    });

    it('refuses the start, a stop of another trip, and a trip that is not a route', async () => {
      const { sut, auth, album, trip, newTrip } = await setup();
      const other = await newTrip();
      const places = await setup(SHOTS, 'places');
      const transit = (stopIds: string[]) =>
        sut.setTransit(auth, album.id, TripTransitUpdateDto.schema.parse({ stopIds, isTransit: true }));

      await expect(transit([trip.stops[0].id])).rejects.toBeInstanceOf(BadRequestException);
      await expect(transit([trip.stops[2].id, other.trip.stops[2].id])).rejects.toBeInstanceOf(NotFoundException);
      await expect(
        places.sut.setTransit(
          places.auth,
          places.album.id,
          TripTransitUpdateDto.schema.parse({ stopIds: [places.trip.stops[0].id], isTransit: true }),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
      await expect(read(sut, auth, album.id)).resolves.toMatchObject({ contentVersion: trip.contentVersion });
    });
  });

  describe('asset point', () => {
    // A, an asset without GPS between, and B: the one between is placed on the way and makes a stop of its own.
    const BETWEEN: Shot[] = [
      ['10:00', A],
      ['10:10', A],
      ['11:05', null],
      ['12:00', B],
    ];
    const X = { latitude: 54.7, longitude: 25.4 };

    it('sets a point by hand: the stop centre follows, and assets without GPS are placed again', async () => {
      const { sut, auth, album, assetIds, trip } = await setup(BETWEEN);
      const [, a, middle] = trip.stops;
      const before = trip.assets[2];

      const edited = await sut.setAssetPoint(auth, album.id, assetIds[1], TripAssetPointDto.schema.parse(X));

      expect(edited.assets[1]).toMatchObject({ ...X, pointSource: 'manual', stopId: a.id });
      expect(edited.stops[1].latitude).toBeCloseTo((A.latitude + X.latitude) / 2, 6);
      expect(edited.assets[2].pointSource).toBe('inferred');
      expect(edited.assets[2].longitude).not.toBeCloseTo(before.longitude!, 6);
      expect(edited.stops[2]).toMatchObject({ id: middle.id, longitude: edited.assets[2].longitude });
      expect(edited.legs.map(({ status }) => status)).toEqual(['pending', 'pending', 'pending']);

      const back = await sut.setAssetPoint(auth, album.id, assetIds[1], null);
      expect(back.assets[1]).toMatchObject({ latitude: null, longitude: null, pointSource: null });
      expect(back.assets[2]).toEqual(before);
      expect(back.stops[1]).toMatchObject(A);
    });

    it('refuses an asset of another trip or in the trash, and a Plain trip', async () => {
      const { sut, auth, album, assetIds, newTrip } = await setup(BETWEEN);
      const other = await newTrip();
      const plain = await setup(BETWEEN, 'plain');
      await db.updateTable('asset').set({ deletedAt: new Date() }).where('id', '=', assetIds[0]).execute();
      const point = TripAssetPointDto.schema.parse(X);

      await expect(sut.setAssetPoint(auth, album.id, other.assetIds[1], point)).rejects.toBeInstanceOf(
        NotFoundException,
      );
      await expect(sut.setAssetPoint(auth, album.id, assetIds[0], point)).rejects.toBeInstanceOf(NotFoundException);
      await expect(
        plain.sut.setAssetPoint(plain.auth, plain.album.id, plain.assetIds[1], point),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('places assets without GPS at a new start and files the Unplaced ones', async () => {
      const blind: Shot[] = [
        ['10:00', null],
        ['10:30', null],
      ];
      const { sut, auth, album, trip } = await setup(blind, 'route', { withStart: false });
      expect(trip.stops).toEqual([]);

      const edited = await sut.setStart(auth, album.id, TripEndDto.schema.parse(HOME));

      const [start, stop] = edited.stops;
      expect(stop).toMatchObject({ ...HOME, role: null, localStart: '2026-05-01T10:00:00.000Z' });
      expect(edited.assets.map(({ stopId, pointSource }) => [stopId, pointSource])).toEqual([
        [stop.id, 'inferred'],
        [stop.id, 'inferred'],
      ]);
      expect(legPairs(edited)).toEqual([[start.id, stop.id, 'pending']]);
    });
  });

  describe('to the centre', () => {
    // A, then two assets without GPS in walks of their own: a Places trip leaves them Unplaced.
    const LOOSE: Shot[] = [
      ['10:00', A],
      ['15:00', null],
      ['20:00', null],
    ];
    const CENTER = { latitude: 54.69, longitude: 25.27, title: 'Vilnius, no exact place' };

    it('makes the centre stop at the point given, and files later assets into it', async () => {
      const { sut, auth, album, assetIds, trip } = await setup(LOOSE, 'places');
      expect(trip.assets.map(({ stopId }) => stopId)).toEqual([trip.stops[0].id, null, null]);

      const first = await sut.toCenter(
        auth,
        album.id,
        TripAssetsCenterDto.schema.parse({ assetIds: [assetIds[1]], center: CENTER }),
      );
      const center = first.stops.find(({ isAtCenter }) => isAtCenter)!;
      expect(center).toMatchObject({ ...CENTER, titleSource: 'manual', isPositionManual: true });

      const second = await sut.toCenter(auth, album.id, TripAssetsCenterDto.schema.parse({ assetIds: [assetIds[2]] }));
      expect(filed(second, center.id)).toEqual([assetIds[1], assetIds[2]]);
      expect(second.stops.find(({ id }) => id === center.id)).toMatchObject({
        ...CENTER,
        localStart: '2026-05-01T15:00:00.000Z',
        localEnd: '2026-05-01T20:00:00.000Z',
      });
    });

    it('refuses a filed asset, a first call without a centre, and a trip that is not Places', async () => {
      const { sut, auth, album, assetIds } = await setup(LOOSE, 'places');
      const route = await setup(LOOSE);
      const fileToCenter = (ids: string[], center: typeof CENTER | null = CENTER) =>
        sut.toCenter(auth, album.id, TripAssetsCenterDto.schema.parse({ assetIds: ids, center }));

      await expect(fileToCenter([assetIds[0]])).rejects.toBeInstanceOf(BadRequestException);
      await expect(fileToCenter([assetIds[1]], null)).rejects.toBeInstanceOf(BadRequestException);
      await expect(
        route.sut.toCenter(
          route.auth,
          route.album.id,
          TripAssetsCenterDto.schema.parse({ assetIds: [route.assetIds[1]], center: CENTER }),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('clock', () => {
    it('follows a time changed since filing: the stop’s times move, and the route’s legs follow the new order', async () => {
      const { sut, auth, album, assetIds, trip } = await setup();
      const stopC = trip.assets[5].stopId!;
      // The camera of C was 6 h fast: C was shot before A, as metadata extraction now reads it.
      await shiftTime(assetIds[5], '09:00');

      await sut.handleFile({ id: album.id });
      const after = await read(sut, auth, album.id);
      expect(after.stops.find(({ id }) => id === stopC)).toMatchObject({
        localStart: '2026-05-01T09:00:00.000Z',
        localEnd: '2026-05-01T09:00:00.000Z',
      });
      expect(after.stops.map(({ id }) => id).indexOf(stopC)).toBe(1); // right after the start
      expect(after.contentVersion).toBe(trip.contentVersion + 1);

      await sut.handleFile({ id: album.id });
      const { contentVersion } = await read(sut, auth, album.id);
      expect(contentVersion).toBe(after.contentVersion);
    });

    it('lists the cameras with a suggested shift and the caller’s own assets, and answers 403 to a viewer', async () => {
      // A phone with GPS at A and B; a camera without GPS, 39 min fast, shot ten assets at the same stops.
      const shots: Shot[] = [
        ['10:00', A],
        ['10:10', A],
        ['12:00', B],
        ['12:10', B],
        ...['10:42', '10:44', '10:46', '10:48', '12:39', '12:41', '12:43', '12:45', '12:47', '12:49'].map(
          (time): Shot => [time, null],
        ),
      ];
      const { ctx, sut, auth, album, assetIds } = await setup(shots);
      for (const [index, assetId] of assetIds.entries()) {
        await ctx.newExif({
          assetId,
          ...(index < 4 ? { make: 'Google', model: 'Pixel' } : { make: 'Canon', model: 'EOS' }),
        });
      }
      const { user: viewer } = await ctx.newUser();
      await ctx.newAlbumUser({ albumId: album.id, userId: viewer.id, role: AlbumUserRole.Viewer });

      const { cameras } = await sut.getCameras(auth, album.id);
      expect(
        cameras.map(({ make, assetCount, gpsCount, isReference }) => [make, assetCount, gpsCount, isReference]),
      ).toEqual([
        ['Canon', 10, 0, false],
        ['Google', 4, 4, true],
      ]);
      expect(cameras[0].ownAssetIds).toEqual(assetIds.slice(4));
      expect(Math.abs(cameras[0].suggestion!.offsetMinutes + 39)).toBeLessThanOrEqual(1);
      await expect(sut.getCameras(factory.auth({ user: viewer }), album.id)).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  describe('place hints', () => {
    // Places A (two assets) and C (one), then three assets without GPS that a Places trip leaves Unplaced.
    const LOOSE: Shot[] = [
      ['10:00', A],
      ['10:10', A],
      ['12:00', C],
      ['15:00', null],
      ['18:00', null],
      ['21:00', null],
    ];
    const CENTER = { latitude: 54.69, longitude: 25.27, title: 'Vilnius, no exact place' };

    const setupHints = async () => {
      const found = await setup(LOOSE, 'places');
      const vectors = [
        embedding(0),
        embedding(0),
        embedding(1),
        embedding(1, 0.95),
        embedding(0, 0.8),
        embedding(1, 0.92),
      ];
      await db
        .insertInto('smart_search')
        .values(found.assetIds.map((assetId, index) => ({ assetId, embedding: vectors[index] })))
        .execute();
      return found;
    };

    it('offers an Unplaced asset the place of the anchor most like it, and the centre once there is one', async () => {
      const { sut, auth, album, assetIds, trip } = await setupHints();
      const placeOf = (index: number) => trip.assets.find(({ assetId }) => assetId === assetIds[index])!.stopId;

      expect(await sut.getPlaceHints(auth, album.id)).toEqual({
        places: [{ stopId: placeOf(2), assetIds: [assetIds[3], assetIds[5]] }],
        center: [],
      });

      await sut.toCenter(auth, album.id, TripAssetsCenterDto.schema.parse({ assetIds: [assetIds[5]], center: CENTER }));
      expect(await sut.getPlaceHints(auth, album.id)).toEqual({
        places: [{ stopId: placeOf(2), assetIds: [assetIds[3]] }],
        center: [assetIds[4]],
      });
    });

    it('gives a route no hints, and answers 403 to a viewer', async () => {
      const { ctx, sut, album } = await setupHints();
      const route = await setup(LOOSE);
      const { user: viewer } = await ctx.newUser();
      await ctx.newAlbumUser({ albumId: album.id, userId: viewer.id, role: AlbumUserRole.Viewer });

      await expect(route.sut.getPlaceHints(route.auth, route.album.id)).resolves.toEqual({ places: [], center: [] });
      await expect(sut.getPlaceHints(factory.auth({ user: viewer }), album.id)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });
  });

  describe('geo search', () => {
    it('searches and names places in the trip’s language', async () => {
      const { sut, auth, album } = await setup();
      await db.updateTable('trip').set({ language: 'de' }).where('albumId', '=', album.id).execute();
      const urls = fakeNominatim((url) =>
        url.pathname === '/search'
          ? Response.json([nominatimPlace('Rathaus')])
          : Response.json(nominatimPlace('Markt')),
      );

      const found = await sut.searchPlaces(
        auth,
        album.id,
        TripGeoSearchDto.schema.parse({ query: `Rathaus ${album.id}` }),
      );
      const named = await sut.reversePlace(
        auth,
        album.id,
        TripGeoReverseQueryDto.schema.parse({ latitude: '54.123', longitude: '25.456' }),
      );

      expect(found.places).toEqual([
        {
          label: 'Rathaus',
          region: 'Vilnius',
          district: null,
          country: 'Lithuania',
          latitude: 54.68,
          longitude: 25.28,
        },
      ]);
      expect(named.places).toEqual([expect.objectContaining({ label: 'Markt' })]);
      expect(urls.map((url) => url.searchParams.get('accept-language'))).toEqual(['de', 'de']);
    });

    it('answers 502 when Nominatim does not, and 403 to a viewer', async () => {
      const { ctx, sut, auth, album } = await setup();
      const { user: viewer } = await ctx.newUser();
      await ctx.newAlbumUser({ albumId: album.id, userId: viewer.id, role: AlbumUserRole.Viewer });
      fakeNominatim(() => new Response('busy', { status: 503 }));
      const dto = TripGeoSearchDto.schema.parse({ query: `nowhere ${album.id}` });

      await expect(sut.searchPlaces(auth, album.id, dto)).rejects.toBeInstanceOf(BadGatewayException);
      await expect(sut.searchPlaces(factory.auth({ user: viewer }), album.id, dto)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });
  });

  describe('same trip', () => {
    it('refuses a stop or an asset of another trip, and changes nothing', async () => {
      const { sut, auth, album, assetIds, trip, newTrip } = await setup();
      const other = await newTrip();
      const [b, c] = trip.stops.slice(2);
      const otherStop = other.trip.stops[2];
      const before = await read(sut, auth, album.id);

      for (const edit of [
        () => sut.updateStop(auth, album.id, otherStop.id, stopChanges({ title: 'X' })),
        () => sut.addPoint(auth, album.id, TripPointCreateDto.schema.parse({ ...A, afterStopId: otherStop.id })),
        () => sut.movePoint(auth, album.id, otherStop.id, TripPointOrderDto.schema.parse({ afterStopId: null })),
        () => sut.mergeNextStop(auth, album.id, otherStop.id),
        () =>
          sut.splitStop(auth, album.id, otherStop.id, TripStopSplitDto.schema.parse({ assetId: other.assetIds[3] })),
        () => sut.deleteStop(auth, album.id, otherStop.id),
        () =>
          sut.moveAssets(
            auth,
            album.id,
            TripAssetsMoveDto.schema.parse({ assetIds: [assetIds[2]], stopId: otherStop.id }),
          ),
      ]) {
        await expect(edit()).rejects.toBeInstanceOf(NotFoundException);
      }
      for (const edit of [
        () => sut.splitStop(auth, album.id, b.id, TripStopSplitDto.schema.parse({ assetId: other.assetIds[3] })),
        () =>
          sut.moveAssets(
            auth,
            album.id,
            TripAssetsMoveDto.schema.parse({ assetIds: [other.assetIds[2]], stopId: c.id }),
          ),
        () => sut.createStop(auth, album.id, TripStopCreateDto.schema.parse({ assetIds: [other.assetIds[2]] })),
      ]) {
        await expect(edit()).rejects.toBeInstanceOf(BadRequestException);
      }
      await expect(read(sut, auth, album.id)).resolves.toEqual(before);
      await expect(read(sut, auth, other.album.id)).resolves.toEqual(other.trip);
    });
  });

  describe('access', () => {
    it('lets an editor edit, and answers 403 to a viewer', async () => {
      const { ctx, sut, album, assetIds, trip } = await setup();
      const { user: editor } = await ctx.newUser();
      const { user: viewer } = await ctx.newUser();
      await ctx.newAlbumUser({ albumId: album.id, userId: editor.id, role: AlbumUserRole.Editor });
      await ctx.newAlbumUser({ albumId: album.id, userId: viewer.id, role: AlbumUserRole.Viewer });
      const dto = TripStopCreateDto.schema.parse({ assetIds: [assetIds[1]] });

      await expect(sut.createStop(factory.auth({ user: viewer }), album.id, dto)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      await expect(
        sut.mergeNextStop(factory.auth({ user: viewer }), album.id, trip.stops[1].id),
      ).rejects.toBeInstanceOf(ForbiddenException);
      await expect(sut.createStop(factory.auth({ user: editor }), album.id, dto)).resolves.toBeDefined();
    });
  });
});
