import { ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { Kysely } from 'kysely';
import { beforeAll, describe, expect, it } from 'vitest';
import { AlbumUserRole, SharedLinkType } from 'src/enum.js';
import { AccessRepository } from 'src/repositories/access.repository.js';
import { AlbumRepository } from 'src/repositories/album.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { DB } from 'src/schema/index.js';
import { BaseService } from 'src/services/base.service.js';
import { TripImportDto, TripResponseDto } from 'src/trips/dtos/trip.dto.js';
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
  isManualPoint: false,
  role: null,
  isSameAsOrigin: false,
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
    stop('home', { role: 'origin', latitude: 54.68, longitude: 25.27 }),
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
    stop('back', { role: 'finish', isSameAsOrigin: true }),
  ],
  assets: [
    { assetId: a1, stopKey: 'old-town', latitude: null, longitude: null, pointSource: null },
    { assetId: a2, stopKey: 'road', latitude: 55.1, longitude: 24.9, pointSource: 'inferred' },
    { assetId: a3, stopKey: null, latitude: 54.9, longitude: 25, pointSource: 'manual' },
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

// The read response written back as an import document: server ids replaced by the document's keys.
const asDocument = (trip: TripResponseDto, stopKeys: string[]) => {
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
    })),
    legs: trip.legs.map(({ id: _, fromStopId, toStopId, ...rest }) => ({
      fromStopKey: keyOf.get(fromStopId),
      toStopKey: keyOf.get(toStopId),
      ...rest,
    })),
    overlays: trip.overlays.map(({ id: _, ...overlay }) => overlay),
    likes: trip.likes,
  };
};

const setup = async () => {
  const { ctx } = newMediumService(BaseService, { database: db, real: [], mock: [LoggingRepository] });
  const sut = new TripService(new AccessRepository(db), new TripRepository(db));
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
  return { ctx, sut, owner, album, assetIds, document, importTrip };
};

describe(TripService.name, () => {
  describe('import', () => {
    it('round-trips a trip document through the read API', async () => {
      const { sut, owner, album, document, importTrip } = await setup();

      await importTrip();

      const trip = await sut.get(factory.auth({ user: owner }), album.id);
      expect(trip).toMatchObject({ albumId: album.id, isFeatured: false, contentVersion: 1 });
      expect(
        asDocument(
          trip,
          document.stops.map(({ key }) => key),
        ),
      ).toEqual(document);
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

    it('answers 404 for an album without a trip', async () => {
      const { sut, owner, album } = await setup();

      await expect(sut.get(factory.auth({ user: owner }), album.id)).rejects.toBeInstanceOf(NotFoundException);
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
