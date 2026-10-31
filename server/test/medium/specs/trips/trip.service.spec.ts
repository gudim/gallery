import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { Kysely } from 'kysely';
import { beforeAll, describe, expect, it } from 'vitest';
import { AlbumUserRole, JobName, SharedLinkType } from 'src/enum.js';
import { AccessRepository } from 'src/repositories/access.repository.js';
import { AlbumRepository } from 'src/repositories/album.repository.js';
import { JobRepository } from 'src/repositories/job.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { DB } from 'src/schema/index.js';
import { BaseService } from 'src/services/base.service.js';
import { TripCreateDto, TripImportDto, TripResponseDto, TripStopUpdateDto } from 'src/trips/dtos/trip.dto.js';
import { TripLegMode, TripLegStatus } from 'src/trips/enum.js';
import { TripGeoRepository } from 'src/trips/repositories/trip-geo.repository.js';
import { TripRepository } from 'src/trips/repositories/trip.repository.js';
import { TripService } from 'src/trips/services/trip.service.js';
import { newMediumService } from 'test/medium.factory.js';
import { factory } from 'test/small.factory.js';
import { getKyselyDB } from 'test/utils.js';

let db: Kysely<DB>;

beforeAll(async () => {
  db = await getKyselyDB();
});

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

const leg = (fromStopKey: string, toStopKey: string, overrides: Record<string, unknown> = {}) => ({
  fromStopKey,
  toStopKey,
  mode: 'driving',
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
  ...overrides,
});

// A small Route trip with every part of the document: start, two stops, finish, a place, filed and unplaced assets,
// legs, an overlay and imported likes. Stops are listed in trip order, which the round trip relies on.
const fixture = ([a1, a2, a3]: string[]) => ({
  kind: 'route',
  isFavorites: false,
  isShowcased: true,
  places: [{ key: 'vilnius', title: 'Vilnius', article: 'An article.', articleSource: 'llm' }],
  stops: [
    stop('home', { role: 'start', latitude: 54.68, longitude: 25.27 }),
    stop('old-town', {
      placeKey: 'vilnius',
      latitude: 54.68,
      longitude: 25.28,
      localStart: '2026-05-01T10:00:00.000Z',
      localEnd: '2026-05-01T12:30:00.000Z',
      title: 'Old Town',
      titleSource: 'nominatim',
      story: 'We walked.',
      storySource: 'owner',
      region: 'Vilnius County',
      country: 'Lithuania',
    }),
    stop('road', {
      latitude: 55.1,
      longitude: 24.9,
      localStart: '2026-05-01T14:00:00.000Z',
      localEnd: '2026-05-01T14:05:00.000Z',
      isTransit: true,
      isPositionManual: true,
    }),
    stop('back', { role: 'finish', isFinishAtStart: true }),
  ],
  assets: [
    {
      assetId: a1,
      stopKey: 'old-town',
      latitude: null,
      longitude: null,
      pointSource: null,
      generatedCaption: 'The town hall at dusk.',
    },
    {
      assetId: a2,
      stopKey: 'road',
      latitude: 55.1,
      longitude: 24.9,
      pointSource: 'inferred',
      generatedCaption: null,
    },
    { assetId: a3, stopKey: null, latitude: 54.9, longitude: 25, pointSource: 'manual', generatedCaption: null },
  ],
  legs: [
    leg('home', 'old-town', { mode: 'foot', distance: 1200, duration: 900 }),
    leg('old-town', 'road', { polyline: '_p~iF~ps|U', status: 'attention', isModeManual: true }),
    leg('road', 'back', {
      mode: 'train',
      departureName: 'Kaunas',
      departureLatitude: 54.88,
      departureLongitude: 23.9,
      arrivalName: 'Vilnius',
      arrivalLatitude: 54.67,
      arrivalLongitude: 25.28,
    }),
  ],
  overlays: [
    {
      kind: 'trail',
      color: '#ff0000',
      geometry: {
        type: 'LineString',
        coordinates: [
          [25, 54],
          [25.1, 54.1],
        ],
      },
    },
  ],
  likes: [{ assetId: a1, count: 2 }],
});

// The read response written back as an import document: server ids replaced by the document's keys, and the
// generated captions, which the read does not return, taken from their table.
const asDocument = async (trip: TripResponseDto, stopKeys: string[]) => {
  const captions = await db.selectFrom('trip_generated_caption').selectAll().execute();
  const captionOf = new Map(captions.map(({ assetId, text }) => [assetId, text]));
  const keyOf = new Map(trip.stops.map(({ id }, index) => [id, stopKeys[index]]));
  const placeKeyOf = new Map(trip.places.map(({ id, key }) => [id, key]));
  return {
    kind: trip.kind,
    isFavorites: trip.isFavorites,
    isShowcased: trip.isShowcased,
    places: trip.places.map(({ id: _, ...place }) => place),
    stops: trip.stops.map(({ id, placeId, ...rest }) => ({
      key: keyOf.get(id),
      placeKey: placeId === null ? null : placeKeyOf.get(placeId),
      ...rest,
    })),
    assets: trip.assets.map(({ stopId, ...asset }) => ({
      ...asset,
      stopKey: stopId === null ? null : keyOf.get(stopId),
      generatedCaption: captionOf.get(asset.assetId) ?? null,
    })),
    legs: trip.legs.map(({ id: _, fromStopId, toStopId, ...rest }) => ({
      fromStopKey: keyOf.get(fromStopId),
      toStopKey: keyOf.get(toStopId),
      ...rest,
    })),
    overlays: trip.overlays.map(({ id: _, ...overlay }) => overlay),
    likes: trip.likes.map(({ isLiked: _, ...like }) => like),
  };
};

// A guest through a shared link: the auth carries the link's owner as its user.
const guest = (sharedLinkId: string, user: { id: string }) => factory.auth({ user, sharedLink: { id: sharedLinkId } });

const setup = async () => {
  const { ctx } = newMediumService(BaseService, { database: db, real: [], mock: [LoggingRepository, JobRepository] });
  const job = ctx.getMock(JobRepository);
  job.queue.mockResolvedValue();
  job.queueAll.mockResolvedValue();
  const sut = new TripService(
    new AccessRepository(db),
    job,
    new TripRepository(db),
    new TripGeoRepository(db, LoggingRepository.create()),
  );
  const { user: owner } = await ctx.newUser();
  const assets = [];
  for (const [index, time] of [
    '2026-05-01T10:15:00.000Z',
    '2026-05-01T14:02:00.000Z',
    '2026-05-01T16:00:00.000Z',
  ].entries()) {
    const { asset } = await ctx.newAsset({
      ownerId: owner.id,
      localDateTime: new Date(time),
      originalFileName: `${index}.jpg`,
    });
    assets.push(asset);
  }
  const assetIds = assets.map(({ id }) => id);
  const { album } = await ctx.newAlbum({ ownerId: owner.id }, assetIds);
  const document = fixture(assetIds);
  const importTrip = () => sut.import(factory.auth({ user: owner }), album.id, TripImportDto.schema.parse(document));
  return { ctx, job, sut, owner, album, assetIds, document, importTrip };
};

type Shot = [time: string, point: { latitude: number; longitude: number } | null];

// An album of the owner's assets at local times on 2026-05-01, each with its GPS or none.
const newAlbumOf = async (ctx: Awaited<ReturnType<typeof setup>>['ctx'], ownerId: string, shots: Shot[]) => {
  const assetIds = [];
  for (const [time, point] of shots) {
    const { asset } = await ctx.newAsset({ ownerId, localDateTime: new Date(`2026-05-01T${time}:00.000Z`) });
    if (point) {
      await ctx.newExif({ assetId: asset.id, ...point });
    }
    assetIds.push(asset.id);
  }
  const { album } = await ctx.newAlbum({ ownerId }, assetIds);
  return { album, assetIds };
};

const changes = (dto: Record<string, unknown>) => TripStopUpdateDto.schema.parse(dto);

describe(TripService.name, () => {
  describe('import', () => {
    it('round-trips a trip document through the read API', async () => {
      const { sut, owner, album, document, importTrip } = await setup();

      await importTrip();

      const trip = await sut.get(factory.auth({ user: owner }), album.id);
      expect(trip).toMatchObject({ albumId: album.id, isFeatured: false, contentVersion: 1 });
      await expect(
        asDocument(
          trip,
          document.stops.map(({ key }) => key),
        ),
      ).resolves.toEqual(document);
    });

    it('creates one trip when two imports of the album race', async () => {
      const { importTrip } = await setup();

      const results = await Promise.allSettled([importTrip(), importTrip()]);

      expect(results.map(({ status }) => status).toSorted()).toEqual(['fulfilled', 'rejected']);
      expect(results.find((result) => result.status === 'rejected')?.reason).toBeInstanceOf(ConflictException);
    });

    it('refuses an album that already has a trip', async () => {
      const { importTrip } = await setup();
      await importTrip();

      await expect(importTrip()).rejects.toBeInstanceOf(ConflictException);
    });

    it('refuses an editor of the album', async () => {
      const { ctx, sut, album, document } = await setup();
      const { user: editor } = await ctx.newUser();
      await ctx.newAlbumUser({ albumId: album.id, userId: editor.id, role: AlbumUserRole.Editor });

      await expect(
        sut.import(factory.auth({ user: editor }), album.id, TripImportDto.schema.parse(document)),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('refuses an asset outside the album', async () => {
      const { ctx, sut, owner, album, document } = await setup();
      const { asset: outside } = await ctx.newAsset({ ownerId: owner.id });
      document.assets[0].assetId = outside.id;

      await expect(
        sut.import(factory.auth({ user: owner }), album.id, TripImportDto.schema.parse(document)),
      ).rejects.toThrow(`Assets not in the album: ${outside.id}`);
    });

    it('allows one Favorites trip per owner', async () => {
      const { ctx, sut, owner, album } = await setup();
      const { album: second } = await ctx.newAlbum({ ownerId: owner.id });
      const favorites = TripImportDto.schema.parse({ kind: 'places', isFavorites: true });
      await sut.import(factory.auth({ user: owner }), album.id, favorites);

      await expect(sut.import(factory.auth({ user: owner }), second.id, favorites)).rejects.toBeInstanceOf(
        ConflictException,
      );
    });
  });

  describe('create', () => {
    const P = { latitude: 54.68, longitude: 25.28 };

    it('lays a route out into stops between its start and finish, with pending legs', async () => {
      const { ctx, sut, owner } = await setup();
      const { album, assetIds } = await newAlbumOf(ctx, owner.id, [
        ['10:00', P],
        ['10:30', null],
        ['11:00', P],
        ['18:00', { latitude: 55, longitude: 25 }],
      ]);

      const trip = await sut.create(
        factory.auth({ user: owner }),
        TripCreateDto.schema.parse({
          albumId: album.id,
          kind: 'route',
          start: { latitude: 54.685, longitude: 25.28, title: 'Home' },
          isFinishAtStart: true,
        }),
      );

      expect(trip).toMatchObject({ albumId: album.id, kind: 'route', contentVersion: 1 });
      const [start, first, second, finish] = trip.stops;
      expect(trip.stops).toHaveLength(4);
      expect(start).toMatchObject({ role: 'start', title: 'Home', titleSource: 'manual', isAddedByHand: true });
      expect(finish).toMatchObject({ role: 'finish', title: 'Home', latitude: 54.685, isFinishAtStart: true });
      expect(first).toMatchObject({
        ...P,
        role: null,
        localStart: '2026-05-01T10:00:00.000Z',
        localEnd: '2026-05-01T11:00:00.000Z',
      });
      expect(second).toMatchObject({ latitude: 55, longitude: 25, localStart: '2026-05-01T18:00:00.000Z' });
      expect(trip.assets).toEqual([
        { assetId: assetIds[0], stopId: first.id, latitude: null, longitude: null, pointSource: null },
        { assetId: assetIds[1], stopId: first.id, ...P, pointSource: 'inferred' },
        { assetId: assetIds[2], stopId: first.id, latitude: null, longitude: null, pointSource: null },
        { assetId: assetIds[3], stopId: second.id, latitude: null, longitude: null, pointSource: null },
      ]);
      expect(trip.legs.map(({ fromStopId, toStopId, mode, status }) => [fromStopId, toStopId, mode, status])).toEqual([
        [start.id, first.id, 'foot', 'pending'],
        [first.id, second.id, 'driving', 'pending'],
        [second.id, finish.id, 'driving', 'pending'],
      ]);
    });

    it('sections a plain trip by day, without legs, and leaves trashed assets out', async () => {
      const { ctx, sut, owner } = await setup();
      const { album, assetIds } = await newAlbumOf(ctx, owner.id, [
        ['10:00', P],
        ['12:00', null],
        ['13:00', null],
      ]);
      await db.updateTable('asset').set({ deletedAt: new Date() }).where('id', '=', assetIds[2]).execute();

      const trip = await sut.create(
        factory.auth({ user: owner }),
        TripCreateDto.schema.parse({ albumId: album.id, kind: 'plain' }),
      );

      expect(trip.stops).toEqual([
        expect.objectContaining({ latitude: null, longitude: null, localEnd: '2026-05-01T12:00:00.000Z' }),
      ]);
      expect(trip.assets.map(({ stopId, pointSource }) => [stopId, pointSource])).toEqual([
        [trip.stops[0].id, null],
        [trip.stops[0].id, null],
      ]);
      expect(trip.legs).toEqual([]);
    });

    it('lets only the owner make a trip, once', async () => {
      const { ctx, sut, owner, album, importTrip } = await setup();
      const { user: editor } = await ctx.newUser();
      const { user: stranger } = await ctx.newUser();
      await ctx.newAlbumUser({ albumId: album.id, userId: editor.id, role: AlbumUserRole.Editor });
      const dto = TripCreateDto.schema.parse({ albumId: album.id, kind: 'places' });

      await expect(sut.create(factory.auth({ user: editor }), dto)).rejects.toBeInstanceOf(ForbiddenException);
      await expect(sut.create(factory.auth({ user: stranger }), dto)).rejects.toBeInstanceOf(NotFoundException);
      await importTrip();
      await expect(sut.create(factory.auth({ user: owner }), dto)).rejects.toBeInstanceOf(ConflictException);
    });
  });

  describe('file new assets', () => {
    const P = { latitude: 54.68, longitude: 25.28 };
    const FAR = { latitude: 55, longitude: 25 };

    // A trip of two stops, 10:00 at P and 18:00 at FAR; on a route, the owner set the leg to the train.
    const routeTrip = async (kind = 'route') => {
      const context = await setup();
      const { ctx, sut, owner } = context;
      const { album } = await newAlbumOf(ctx, owner.id, [
        ['10:00', P],
        ['18:00', FAR],
      ]);
      const auth = factory.auth({ user: owner });
      const trip = await sut.create(auth, TripCreateDto.schema.parse({ albumId: album.id, kind }));
      await sut.updateStop(auth, album.id, trip.stops[0].id, changes({ title: 'Old Town', story: 'We walked.' }));
      await db
        .updateTable('trip_leg')
        .set({ mode: TripLegMode.Train, isModeManual: true, status: TripLegStatus.Ok })
        .execute();
      // An asset added later, its metadata read unless `isExtracted` is false.
      const add = async (time: string, point: typeof P | null, isExtracted = true) => {
        const { asset } = await ctx.newAsset({
          ownerId: owner.id,
          localDateTime: new Date(`2026-05-01T${time}:00.000Z`),
        });
        if (point) {
          await ctx.newExif({ assetId: asset.id, ...point });
        }
        await db
          .insertInto('asset_job_status')
          .values({ assetId: asset.id, metadataExtractedAt: isExtracted ? new Date() : null })
          .onConflict((oc) =>
            oc.column('assetId').doUpdateSet({ metadataExtractedAt: isExtracted ? new Date() : null }),
          )
          .execute();
        await ctx.newAlbumAsset({ albumId: album.id, assetId: asset.id });
        return asset.id;
      };
      return { ...context, auth, album, stops: trip.stops, add };
    };

    it('files into existing stops without touching their texts, and opens new ones between them', async () => {
      const { sut, auth, album, stops, add } = await routeTrip();
      const near = await add('10:20', { latitude: 54.6805, longitude: 25.28 });
      const between = await add('14:00', { latitude: 54.8, longitude: 25.1 });

      await sut.handleFile({ id: album.id });

      const trip = await sut.get(auth, album.id);
      expect(trip.contentVersion).toBe(3);
      expect(trip.stops).toHaveLength(3);
      const [first, middle, last] = trip.stops;
      expect(first).toMatchObject({
        id: stops[0].id,
        title: 'Old Town',
        story: 'We walked.',
        localEnd: '2026-05-01T10:20:00.000Z',
      });
      expect(last.id).toBe(stops[1].id);
      expect(trip.assets.find(({ assetId }) => assetId === near)?.stopId).toBe(first.id);
      expect(trip.assets.find(({ assetId }) => assetId === between)?.stopId).toBe(middle.id);
      // the owner's train runs on through the new stop
      expect(
        trip.legs.map(({ fromStopId, toStopId, mode, isModeManual, status }) => [
          fromStopId,
          toStopId,
          mode,
          isModeManual,
          status,
        ]),
      ).toEqual([
        [first.id, middle.id, 'train', true, 'pending'],
        [middle.id, last.id, 'train', true, 'pending'],
      ]);
    });

    it('waits for metadata, files once, and leaves the trip alone when there is nothing new', async () => {
      const { sut, auth, album, add } = await routeTrip();
      const waiting = await add('10:10', P, false);

      await sut.handleFile({ id: album.id });
      const before = await sut.get(auth, album.id);
      expect(before.contentVersion).toBe(2);
      expect(before.assets.find(({ assetId }) => assetId === waiting)?.stopId).toBeNull();

      await db
        .updateTable('asset_job_status')
        .set({ metadataExtractedAt: new Date() })
        .where('assetId', '=', waiting)
        .execute();
      await sut.handleFile({ id: album.id });
      await sut.handleFile({ id: album.id });

      const trip = await sut.get(auth, album.id);
      expect(trip.contentVersion).toBe(3);
      expect(trip.assets.find(({ assetId }) => assetId === waiting)?.stopId).toBe(trip.stops[0].id);
    });

    it('leaves an asset that fits no stop Unplaced, and does not file it again', async () => {
      const { sut, auth, album, add } = await routeTrip('places');
      // a Places trip never interpolates: two hours from any anchor, the asset has no point
      const nowhere = await add('12:00', null);

      await sut.handleFile({ id: album.id });
      await sut.handleFile({ id: album.id });

      const trip = await sut.get(auth, album.id);
      expect(trip.contentVersion).toBe(3);
      expect(trip.stops).toHaveLength(2);
      expect(trip.assets.find(({ assetId }) => assetId === nowhere)).toMatchObject({ stopId: null, pointSource: null });
    });

    it('queues filing for trip albums only, on album updates, extracted metadata and the nightly sweep', async () => {
      const { ctx, job, sut, owner, album: tripAlbum, add } = await routeTrip();
      const { album: plainAlbum } = await newAlbumOf(ctx, owner.id, [['10:00', null]]);
      const waiting = await add('11:00', P);
      await ctx.newAlbumAsset({ albumId: plainAlbum.id, assetId: waiting });
      job.queue.mockClear();

      await sut.onAlbumUpdate({ id: tripAlbum.id, userIds: [], recipientIds: [] });
      await sut.onAlbumUpdate({ id: plainAlbum.id, userIds: [], recipientIds: [] });
      expect(job.queue.mock.calls).toEqual([[{ name: JobName.TripFile, data: { id: tripAlbum.id } }]]);

      await sut.onAssetMetadataExtracted({ assetId: waiting, userId: owner.id });
      await sut.handleFileSweep();
      expect(job.queueAll.mock.calls.map(([items]) => items)).toEqual([
        [{ name: JobName.TripFile, data: { id: tripAlbum.id } }],
        expect.arrayContaining([{ name: JobName.TripFile, data: { id: tripAlbum.id } }]),
      ]);
      expect(job.queueAll.mock.calls[1][0]).not.toContainEqual({ name: JobName.TripFile, data: { id: plainAlbum.id } });
    });
  });

  describe('edit a stop', () => {
    it('lets the owner and an editor set texts and the place, written as manual', async () => {
      const { ctx, sut, owner, album, importTrip } = await setup();
      const trip = await importTrip();
      const { user: editor } = await ctx.newUser();
      await ctx.newAlbumUser({ albumId: album.id, userId: editor.id, role: AlbumUserRole.Editor });
      const [, oldTown, road] = trip.stops;

      await sut.updateStop(factory.auth({ user: owner }), album.id, road.id, changes({ title: ' Road ' }));
      const edited = await sut.updateStop(
        factory.auth({ user: editor }),
        album.id,
        road.id,
        changes({ story: 'Rain.', placeId: trip.places[0].id }),
      );

      expect(edited.contentVersion).toBe(3);
      expect(edited.stops[2]).toMatchObject({
        title: 'Road',
        titleSource: 'manual',
        story: 'Rain.',
        storySource: 'manual',
        placeId: trip.places[0].id,
      });
      expect(edited.stops[1]).toEqual(oldTown);
    });

    it('clears a blank text with its source, and the place with null', async () => {
      const { sut, owner, album, importTrip } = await setup();
      const trip = await importTrip();
      const oldTown = trip.stops[1];

      const edited = await sut.updateStop(
        factory.auth({ user: owner }),
        album.id,
        oldTown.id,
        changes({ title: '  ', story: null, placeId: null }),
      );

      expect(edited.stops[1]).toMatchObject({
        title: null,
        titleSource: null,
        story: null,
        storySource: null,
        placeId: null,
      });
    });

    it('gives the start’s title to a finish at the start', async () => {
      const { sut, owner, album, importTrip } = await setup();
      const trip = await importTrip();

      const edited = await sut.updateStop(
        factory.auth({ user: owner }),
        album.id,
        trip.stops[0].id,
        changes({ title: 'Home' }),
      );

      expect(edited.stops.at(-1)).toMatchObject({ role: 'finish', title: 'Home', titleSource: 'manual' });
    });

    it('answers 403 to a viewer and the album shared link, 404 to anyone else', async () => {
      const { ctx, sut, owner, album, importTrip } = await setup();
      const trip = await importTrip();
      const { user: viewer } = await ctx.newUser();
      const { user: stranger } = await ctx.newUser();
      await ctx.newAlbumUser({ albumId: album.id, userId: viewer.id, role: AlbumUserRole.Viewer });
      const { sharedLink } = await ctx.newSharedLink({
        userId: owner.id,
        type: SharedLinkType.Album,
        albumId: album.id,
      });
      const update = (auth: ReturnType<typeof factory.auth>) =>
        sut.updateStop(auth, album.id, trip.stops[1].id, changes({ title: 'X' }));

      await expect(update(factory.auth({ user: viewer }))).rejects.toBeInstanceOf(ForbiddenException);
      await expect(update(guest(sharedLink.id, owner))).rejects.toBeInstanceOf(ForbiddenException);
      await expect(update(factory.auth({ user: stranger }))).rejects.toBeInstanceOf(NotFoundException);
      await expect(sut.get(factory.auth({ user: owner }), album.id)).resolves.toMatchObject({ contentVersion: 1 });
    });

    it('refuses a stop or a place of another trip', async () => {
      const { ctx, sut, owner, album, assetIds, document, importTrip } = await setup();
      const trip = await importTrip();
      const { album: other } = await ctx.newAlbum({ ownerId: owner.id }, assetIds);
      const otherTrip = await sut.import(factory.auth({ user: owner }), other.id, TripImportDto.schema.parse(document));
      const auth = factory.auth({ user: owner });

      await expect(
        sut.updateStop(auth, album.id, otherTrip.stops[1].id, changes({ title: 'X' })),
      ).rejects.toBeInstanceOf(NotFoundException);
      await expect(
        sut.updateStop(auth, album.id, trip.stops[1].id, changes({ placeId: otherTrip.places[0].id })),
      ).rejects.toBeInstanceOf(BadRequestException);
      await expect(sut.get(auth, album.id)).resolves.toEqual(trip);
    });

    it('answers 404 for a trip whose album is in the trash', async () => {
      const { sut, owner, album, importTrip } = await setup();
      const trip = await importTrip();
      await db.updateTable('album').set({ deletedAt: new Date() }).where('id', '=', album.id).execute();

      await expect(
        sut.updateStop(factory.auth({ user: owner }), album.id, trip.stops[1].id, changes({ title: 'X' })),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('refuses an update with nothing to change', () => {
      expect(TripStopUpdateDto.schema.safeParse({}).success).toBe(false);
    });
  });

  describe('read access', () => {
    it('lets the owner, an editor, a viewer and the album shared link read the trip', async () => {
      const { ctx, sut, owner, album, importTrip } = await setup();
      await importTrip();
      const { user: editor } = await ctx.newUser();
      const { user: viewer } = await ctx.newUser();
      await ctx.newAlbumUser({ albumId: album.id, userId: editor.id, role: AlbumUserRole.Editor });
      await ctx.newAlbumUser({ albumId: album.id, userId: viewer.id, role: AlbumUserRole.Viewer });
      const { sharedLink } = await ctx.newSharedLink({
        userId: owner.id,
        type: SharedLinkType.Album,
        albumId: album.id,
      });

      for (const auth of [
        factory.auth({ user: owner }),
        factory.auth({ user: editor }),
        factory.auth({ user: viewer }),
        factory.auth({ user: owner, sharedLink: { id: sharedLink.id } }),
      ]) {
        await expect(sut.get(auth, album.id)).resolves.toMatchObject({ albumId: album.id });
      }
    });

    it('answers 404 to anyone else, and to a shared link of another album', async () => {
      const { ctx, sut, owner, album, importTrip } = await setup();
      await importTrip();
      const { user: stranger } = await ctx.newUser();
      const { album: other } = await ctx.newAlbum({ ownerId: owner.id });
      const { sharedLink } = await ctx.newSharedLink({
        userId: owner.id,
        type: SharedLinkType.Album,
        albumId: other.id,
      });

      await expect(sut.get(factory.auth({ user: stranger }), album.id)).rejects.toBeInstanceOf(NotFoundException);
      await expect(
        sut.get(factory.auth({ user: owner, sharedLink: { id: sharedLink.id } }), album.id),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('answers 404 for a trip whose album is in the trash, shared link included', async () => {
      const { ctx, sut, owner, album, importTrip } = await setup();
      await importTrip();
      const { sharedLink } = await ctx.newSharedLink({
        userId: owner.id,
        type: SharedLinkType.Album,
        albumId: album.id,
      });

      await ctx.softDeleteAlbum(album.id);

      await expect(sut.get(factory.auth({ user: owner }), album.id)).rejects.toBeInstanceOf(NotFoundException);
      await expect(
        sut.get(factory.auth({ user: owner, sharedLink: { id: sharedLink.id } }), album.id),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('hides asset points, not stops, from a shared link that hides metadata', async () => {
      const { ctx, sut, owner, album, importTrip } = await setup();
      const imported = await importTrip();
      const { sharedLink } = await ctx.newSharedLink({
        userId: owner.id,
        type: SharedLinkType.Album,
        albumId: album.id,
      });

      const trip = await sut.get(
        factory.auth({ user: owner, sharedLink: { id: sharedLink.id, showExif: false } }),
        album.id,
      );

      expect(trip.stops).toEqual(imported.stops);
      expect(trip.legs).toEqual(imported.legs);
      expect(trip.assets).toEqual(
        imported.assets.map((asset) => ({ ...asset, latitude: null, longitude: null, pointSource: null })),
      );
    });

    it('answers 404 for an album without a trip', async () => {
      const { sut, owner, album } = await setup();

      await expect(sut.get(factory.auth({ user: owner }), album.id)).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('likes', () => {
    it('counts one like per user and per guest key, and tells each liker their own', async () => {
      const { ctx, sut, owner, album, assetIds, importTrip } = await setup();
      await importTrip();
      const { user: viewer } = await ctx.newUser();
      await ctx.newAlbumUser({ albumId: album.id, userId: viewer.id, role: AlbumUserRole.Viewer });
      const { sharedLink } = await ctx.newSharedLink({
        userId: owner.id,
        type: SharedLinkType.Album,
        albumId: album.id,
      });
      const [a1, a2] = assetIds;

      await sut.like(factory.auth({ user: viewer }), album.id, a1);
      await sut.like(factory.auth({ user: viewer }), album.id, a1);
      await sut.like(guest(sharedLink.id, owner), album.id, a1, 'k'.repeat(32));
      await expect(sut.like(guest(sharedLink.id, owner), album.id, a2, 'g'.repeat(32))).resolves.toEqual({
        assetId: a2,
        count: 1,
        isLiked: true,
      });

      // Two imported likes, the viewer and one guest; the link's owner is not the guest.
      const asGuest = await sut.get(guest(sharedLink.id, owner), album.id, 'k'.repeat(32));
      expect(asGuest.likes).toEqual(
        [
          { assetId: a1, count: 4, isLiked: true },
          { assetId: a2, count: 1, isLiked: false },
        ].sort((a, b) => a.assetId.localeCompare(b.assetId)),
      );
      const asOwner = await sut.get(factory.auth({ user: owner }), album.id);
      expect(asOwner.likes.every(({ isLiked }) => !isLiked)).toBe(true);
      const asKeylessGuest = await sut.get(guest(sharedLink.id, owner), album.id);
      expect(asKeylessGuest.likes.every(({ isLiked }) => !isLiked)).toBe(true);
    });

    it('takes back only the caller’s like', async () => {
      const { ctx, sut, owner, album, assetIds, importTrip } = await setup();
      await importTrip();
      const { sharedLink } = await ctx.newSharedLink({
        userId: owner.id,
        type: SharedLinkType.Album,
        albumId: album.id,
      });
      const [a1] = assetIds;
      await sut.like(factory.auth({ user: owner }), album.id, a1);

      await expect(sut.unlike(guest(sharedLink.id, owner), album.id, a1)).resolves.toEqual({
        assetId: a1,
        count: 3,
        isLiked: false,
      });
      await expect(sut.unlike(guest(sharedLink.id, owner), album.id, a1, 'k'.repeat(32))).resolves.toMatchObject({
        count: 3,
      });
      await expect(sut.unlike(factory.auth({ user: owner }), album.id, a1)).resolves.toEqual({
        assetId: a1,
        count: 2,
        isLiked: false,
      });
    });

    it('answers 404 for an asset outside the trip, a trashed asset, a stranger and another album’s link', async () => {
      const { ctx, sut, owner, album, assetIds, importTrip } = await setup();
      await importTrip();
      const { asset: outside } = await ctx.newAsset({ ownerId: owner.id });
      const { user: stranger } = await ctx.newUser();
      const { album: other } = await ctx.newAlbum({ ownerId: owner.id });
      const { sharedLink } = await ctx.newSharedLink({
        userId: owner.id,
        type: SharedLinkType.Album,
        albumId: other.id,
      });
      await ctx.softDeleteAsset(assetIds[1]);

      for (const like of [
        () => sut.like(factory.auth({ user: owner }), album.id, outside.id),
        () => sut.like(factory.auth({ user: owner }), album.id, assetIds[1]),
        () => sut.like(factory.auth({ user: stranger }), album.id, assetIds[0]),
        () => sut.like(guest(sharedLink.id, owner), album.id, assetIds[0], 'k'.repeat(32)),
        () => sut.like(factory.auth({ user: owner }), other.id, assetIds[0]),
      ]) {
        await expect(like()).rejects.toBeInstanceOf(NotFoundException);
      }
    });
  });

  describe('cascades', () => {
    it('drops the filing and likes of an asset removed from the album', async () => {
      const { ctx, sut, owner, album, assetIds, importTrip } = await setup();
      await importTrip();

      await ctx.get(AlbumRepository).removeAssetIds(album.id, [assetIds[0]]);

      const trip = await sut.get(factory.auth({ user: owner }), album.id);
      expect(trip.assets.map(({ assetId }) => assetId)).toEqual(assetIds.slice(1));
      expect(trip.likes).toEqual([]);
      await expect(
        db.selectFrom('trip_asset').select('assetId').where('assetId', '=', assetIds[0]).execute(),
      ).resolves.toEqual([]);
    });

    it('drops the filing of an asset deleted for good', async () => {
      const { sut, owner, album, assetIds, importTrip } = await setup();
      await importTrip();

      await db.deleteFrom('asset').where('id', '=', assetIds[1]).execute();

      const trip = await sut.get(factory.auth({ user: owner }), album.id);
      expect(trip.assets.map(({ assetId }) => assetId)).toEqual([assetIds[0], assetIds[2]]);
    });

    it('hides a trashed asset and puts it back in its stop when restored', async () => {
      const { ctx, sut, owner, album, assetIds, importTrip } = await setup();
      const before = await importTrip();

      await ctx.softDeleteAsset(assetIds[0]);
      const trashed = await sut.get(factory.auth({ user: owner }), album.id);
      await db.updateTable('asset').set({ deletedAt: null }).where('id', '=', assetIds[0]).execute();
      const restored = await sut.get(factory.auth({ user: owner }), album.id);

      expect(trashed.assets.map(({ assetId }) => assetId)).toEqual(assetIds.slice(1));
      expect(trashed.likes).toEqual([]);
      expect(restored.assets).toEqual(before.assets);
      expect(restored.likes).toEqual(before.likes);
    });

    it('deletes the trip with its album', async () => {
      const { ctx, album, importTrip } = await setup();
      await importTrip();

      await ctx.get(AlbumRepository).delete(album.id);

      for (const table of [
        'trip',
        'trip_place',
        'trip_stop',
        'trip_asset',
        'trip_leg',
        'trip_overlay',
        'trip_like',
      ] as const) {
        await expect(
          db.selectFrom(table).select('albumId').where('albumId', '=', album.id).execute(),
          table,
        ).resolves.toEqual([]);
      }
    });
  });
});
