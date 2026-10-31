import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { Kysely } from 'kysely';
import { beforeAll, describe, expect, it } from 'vitest';
import { AlbumUserRole, JobName } from 'src/enum.js';
import { AccessRepository } from 'src/repositories/access.repository.js';
import { JobRepository } from 'src/repositories/job.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { DB } from 'src/schema/index.js';
import { BaseService } from 'src/services/base.service.js';
import {
  TripAssetsMoveDto,
  TripCreateDto,
  TripEndDto,
  TripFinishUpdateDto,
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
import { TripGeoRepository } from 'src/trips/repositories/trip-geo.repository.js';
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

const setup = async (shots: Shot[] = SHOTS, kind = 'route') => {
  const { ctx } = newMediumService(BaseService, { database: db, real: [], mock: [LoggingRepository, JobRepository] });
  const job = ctx.getMock(JobRepository);
  job.queue.mockResolvedValue();
  job.queueAll.mockResolvedValue();
  const sut = new TripService(
    new AccessRepository(db),
    job,
    new TripRepository(db),
    new TripGeoRepository(db, LoggingRepository.create()),
    new TripEditorRepository(db),
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
      TripCreateDto.schema.parse({ albumId: album.id, kind, ...(kind === 'route' && { start: HOME }) }),
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
