import { Kysely } from 'kysely';
import { beforeAll, describe, expect, it } from 'vitest';
import { AssetVisibility, JobName, SharedSpaceRole } from 'src/enum.js';
import { AccessRepository } from 'src/repositories/access.repository.js';
import { AssetFavoriteRepository } from 'src/repositories/asset-favorite.repository.js';
import { JobRepository } from 'src/repositories/job.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { SharedSpaceRepository } from 'src/repositories/shared-space.repository.js';
import { DB } from 'src/schema/index.js';
import { BaseService } from 'src/services/base.service.js';
import { TripCreateDto, TripImportDto } from 'src/trips/dtos/trip.dto.js';
import { TripKind } from 'src/trips/enum.js';
import { TripEditorRepository } from 'src/trips/repositories/trip-editor.repository.js';
import { TripFavoritesRepository } from 'src/trips/repositories/trip-favorites.repository.js';
import { TripFilingRepository } from 'src/trips/repositories/trip-filing.repository.js';
import { TripGeoRepository } from 'src/trips/repositories/trip-geo.repository.js';
import { TripNameRepository } from 'src/trips/repositories/trip-name.repository.js';
import { TripRouteRepository } from 'src/trips/repositories/trip-route.repository.js';
import { TripRepository } from 'src/trips/repositories/trip.repository.js';
import { TripFavoritesService } from 'src/trips/services/trip-favorites.service.js';
import { TripService } from 'src/trips/services/trip.service.js';
import { newMediumService } from 'test/medium.factory.js';
import { factory } from 'test/small.factory.js';
import { getKyselyDB } from 'test/utils.js';

let db: Kysely<DB>;

beforeAll(async () => {
  db = await getKyselyDB();
});

const VILNIUS = { latitude: 54.68, longitude: 25.28 };
const NEAR_VILNIUS = { latitude: 54.681, longitude: 25.281 };
const KAUNAS = { latitude: 54.9, longitude: 23.9 };

const setup = async () => {
  const { ctx } = newMediumService(BaseService, { database: db, real: [], mock: [LoggingRepository, JobRepository] });
  const job = ctx.getMock(JobRepository);
  job.queue.mockResolvedValue();
  job.queueAll.mockResolvedValue();
  job.searchJobs.mockResolvedValue([]);
  const sut = new TripFavoritesService(job, new TripFavoritesRepository(db), new AssetFavoriteRepository(db));
  const trips = new TripService(
    new AccessRepository(db),
    job,
    new TripRepository(db),
    new TripFilingRepository(db),
    new TripRouteRepository(db),
    new TripNameRepository(db),
    new TripGeoRepository(db, LoggingRepository.create()),
    new TripEditorRepository(db),
    new AssetFavoriteRepository(db),
  );
  const { user } = await ctx.newUser();
  // An asset of `ownerId` with its GPS or none, its metadata read.
  const newAsset = async (
    ownerId: string,
    point: typeof VILNIUS | null,
    dto: { visibility?: AssetVisibility } = {},
  ) => {
    const { asset } = await ctx.newAsset({ ownerId, localDateTime: new Date('2026-05-01T10:00:00.000Z'), ...dto });
    if (point) {
      await ctx.newExif({ assetId: asset.id, ...point });
    }
    await ctx.newJobStatus({ assetId: asset.id, metadataExtractedAt: new Date() });
    return asset.id;
  };
  const star = (userId: string, ...assetIds: string[]) =>
    db
      .insertInto('asset_favorite')
      .values(assetIds.map((assetId) => ({ userId, assetId })))
      .execute();
  const unstar = (userId: string, ...assetIds: string[]) =>
    db.deleteFrom('asset_favorite').where('userId', '=', userId).where('assetId', 'in', assetIds).execute();
  const favoritesTrip = () =>
    db
      .selectFrom('trip')
      .innerJoin('album', 'album.id', 'trip.albumId')
      .innerJoin('album_user', 'album_user.albumId', 'album.id')
      .select(['trip.albumId', 'trip.kind', 'trip.language', 'album.albumName', 'album.albumThumbnailAssetId'])
      .where('trip.isFavorites', '=', true)
      .where('album_user.userId', '=', user.id)
      .execute();
  const albumAssetIds = async (albumId: string) => {
    const rows = await db.selectFrom('album_asset').select('assetId').where('albumId', '=', albumId).execute();
    return rows.map(({ assetId }) => assetId).toSorted();
  };
  const filing = (albumId: string) =>
    db
      .selectFrom('trip_asset')
      .leftJoin('trip_stop', 'trip_stop.id', 'trip_asset.stopId')
      .select([
        'trip_asset.assetId',
        'trip_asset.stopId',
        'trip_stop.latitude',
        'trip_stop.longitude',
        'trip_asset.latitude as pointLatitude',
        'trip_asset.longitude as pointLongitude',
        'trip_asset.pointSource',
      ])
      .where('trip_asset.albumId', '=', albumId)
      .execute();
  const mirror = (canCreate = false) => sut.handleMirror({ userId: user.id, canCreate });
  return { ctx, job, sut, trips, user, newAsset, star, unstar, favoritesTrip, albumAssetIds, filing, mirror };
};

describe(TripFavoritesService.name, () => {
  it('queues mirroring on a star or an unstar by hand, and only a star may make the trip', async () => {
    const { job, sut, user } = await setup();

    await sut.onAssetFavoritesUpdate({ userId: user.id, ids: [], isFavorite: true });
    await sut.onAssetFavoritesUpdate({ userId: user.id, ids: [], isFavorite: false });

    expect(job.queue.mock.calls).toEqual([
      [{ name: JobName.TripFavorites, data: { userId: user.id, canCreate: true } }],
      [{ name: JobName.TripFavorites, data: { userId: user.id, canCreate: false } }],
    ]);
  });

  it('makes the Favorites trip on the first star, in the instance language, with every star the user could add to an album', async () => {
    const { ctx, job, user, newAsset, star, favoritesTrip, albumAssetIds, filing, mirror } = await setup();
    const { user: partner } = await ctx.newUser();
    const { user: stranger } = await ctx.newUser();
    await ctx.newPartner({ sharedById: partner.id, sharedWithId: user.id });
    const own = await newAsset(user.id, VILNIUS);
    const near = await newAsset(user.id, NEAR_VILNIUS);
    const partners = await newAsset(partner.id, KAUNAS);
    const strangers = await newAsset(stranger.id, KAUNAS);
    const locked = await newAsset(user.id, KAUNAS, { visibility: AssetVisibility.Locked });
    const trashed = await newAsset(user.id, KAUNAS);
    await db.updateTable('asset').set({ deletedAt: new Date() }).where('id', '=', trashed).execute();
    await star(user.id, own, near, partners, strangers, locked, trashed);

    await expect(mirror(false)).resolves.toBe('skipped');
    await expect(favoritesTrip()).resolves.toEqual([]);

    await mirror(true);
    const [trip] = await favoritesTrip();
    expect(trip).toMatchObject({ kind: TripKind.Places, language: 'ru', albumName: 'Избранное' });
    expect(trip.albumThumbnailAssetId).not.toBeNull();
    await expect(albumAssetIds(trip.albumId)).resolves.toEqual([own, near, partners].toSorted());
    const filed = await filing(trip.albumId);
    expect(new Set(filed.map(({ stopId }) => stopId)).size).toBe(2);
    expect(filed.find(({ assetId }) => assetId === own)!.stopId).toBe(
      filed.find(({ assetId }) => assetId === near)!.stopId,
    );
    expect(job.queue).toHaveBeenCalledWith({ name: JobName.TripName, data: { id: trip.albumId } });

    // One Favorites trip per owner: a later star files into it.
    await mirror(true);
    await expect(favoritesTrip()).resolves.toHaveLength(1);
  });

  it('removes an unstarred asset, drops the place it leaves empty and moves the centre of one it thins', async () => {
    const { user, newAsset, star, unstar, favoritesTrip, albumAssetIds, filing, mirror } = await setup();
    const own = await newAsset(user.id, VILNIUS);
    const near = await newAsset(user.id, NEAR_VILNIUS);
    const far = await newAsset(user.id, KAUNAS);
    await star(user.id, own, near, far);
    await mirror(true);
    const [{ albumId }] = await favoritesTrip();
    const filed = await filing(albumId);
    const kaunasStop = filed.find(({ assetId }) => assetId === far)!.stopId!;

    await unstar(user.id, near, far);
    await mirror();

    await expect(albumAssetIds(albumId)).resolves.toEqual([own]);
    const stops = await db.selectFrom('trip_stop').selectAll().where('albumId', '=', albumId).execute();
    expect(stops.map(({ id }) => id)).not.toContain(kaunasStop);
    expect(stops).toEqual([expect.objectContaining(VILNIUS)]);

    // The last unstar empties the album but keeps the trip, and a star fills it again.
    await unstar(user.id, own);
    await mirror();
    await expect(albumAssetIds(albumId)).resolves.toEqual([]);
    await star(user.id, far);
    await mirror();
    await expect(albumAssetIds(albumId)).resolves.toEqual([far]);
  });

  it("takes out a starred asset the owner can no longer add by hand: an ended partner's, another user's, not a trashed one", async () => {
    const { ctx, sut, user, newAsset, star, favoritesTrip, albumAssetIds, mirror } = await setup();
    const { user: partner } = await ctx.newUser();
    const { user: editor } = await ctx.newUser();
    await ctx.newPartner({ sharedById: partner.id, sharedWithId: user.id });
    const own = await newAsset(user.id, VILNIUS);
    const partners = await newAsset(partner.id, KAUNAS);
    await star(user.id, own, partners);
    await mirror(true);
    const [{ albumId }] = await favoritesTrip();
    await expect(albumAssetIds(albumId)).resolves.toEqual([own, partners].toSorted());

    // An editor adds their own asset: it is starred for the owner, but stays out of the album.
    const editors = await newAsset(editor.id, KAUNAS);
    await ctx.newAlbumAsset({ albumId, assetId: editors });
    await sut.onAlbumAssetsAdd({ albumId, assetIds: [editors] });
    await db.deleteFrom('partner').where('sharedById', '=', partner.id).execute();
    await db.updateTable('asset').set({ deletedAt: new Date() }).where('id', '=', own).execute();
    await mirror();

    await expect(albumAssetIds(albumId)).resolves.toEqual([own]);
  });

  it('places a starred asset without GPS at its stop in another trip of the owner, as an inferred point', async () => {
    const { ctx, trips, user, newAsset, star, favoritesTrip, filing, mirror } = await setup();
    const anchor = await newAsset(user.id, KAUNAS);
    const blind = await newAsset(user.id, null);
    const { album } = await ctx.newAlbum({ ownerId: user.id }, [anchor, blind]);
    await trips.create(factory.auth({ user }), TripCreateDto.schema.parse({ albumId: album.id, kind: 'places' }));
    const filed = await filing(album.id);
    const own = filed.find(({ assetId }) => assetId === anchor)!;
    await star(user.id, blind);

    await mirror(true);

    const [{ albumId }] = await favoritesTrip();
    expect(await filing(albumId)).toEqual([
      expect.objectContaining({
        assetId: blind,
        latitude: own.latitude,
        longitude: own.longitude,
        pointLatitude: own.latitude,
        pointLongitude: own.longitude,
        pointSource: 'inferred',
      }),
    ]);
  });

  it('stars an asset added to the Favorites album for its owner and unstars one removed, and leaves other albums alone', async () => {
    const { ctx, sut, user, newAsset, star, favoritesTrip, mirror } = await setup();
    const first = await newAsset(user.id, VILNIUS);
    await star(user.id, first);
    await mirror(true);
    const [{ albumId }] = await favoritesTrip();
    const added = await newAsset(user.id, KAUNAS);
    const other = await newAsset(user.id, KAUNAS);
    const { album } = await ctx.newAlbum({ ownerId: user.id }, [other]);
    const stars = async () => {
      const rows = await db.selectFrom('asset_favorite').select('assetId').where('userId', '=', user.id).execute();
      return rows.map(({ assetId }) => assetId).toSorted();
    };

    await sut.onAlbumAssetsAdd({ albumId, assetIds: [added] });
    await sut.onAlbumAssetsAdd({ albumId: album.id, assetIds: [other] });
    await expect(stars()).resolves.toEqual([first, added].toSorted());

    await sut.onAlbumAssetsRemove({ albumId, assetIds: [first] });
    await sut.onAlbumAssetsRemove({ albumId: album.id, assetIds: [added] });
    await expect(stars()).resolves.toEqual([added]);
  });

  it('drops the place an asset Gallery took out of the album leaves empty, and moves the centre of one it thins', async () => {
    const { job, sut, user, newAsset, star, favoritesTrip, filing, mirror } = await setup();
    const own = await newAsset(user.id, VILNIUS);
    const near = await newAsset(user.id, { latitude: 54.682, longitude: 25.282 });
    const far = await newAsset(user.id, KAUNAS);
    await star(user.id, own, near, far);
    await mirror(true);
    const [{ albumId }] = await favoritesTrip();
    const filed = await filing(albumId);
    const kaunasStop = filed.find(({ assetId }) => assetId === far)!.stopId!;
    job.queue.mockClear();

    // Gallery's "Remove from album": the album rows go first, then the event.
    await db.deleteFrom('album_asset').where('albumId', '=', albumId).where('assetId', 'in', [near, far]).execute();
    await sut.onAlbumAssetsRemove({ albumId, assetIds: [near, far] });
    expect(job.queue).toHaveBeenCalledWith({
      name: JobName.TripFavorites,
      data: { userId: user.id, canCreate: false },
    });
    const { contentVersion } = await db
      .selectFrom('trip')
      .select('contentVersion')
      .where('albumId', '=', albumId)
      .executeTakeFirstOrThrow();
    await mirror();

    const stops = await db.selectFrom('trip_stop').selectAll().where('albumId', '=', albumId).execute();
    expect(stops.map(({ id }) => id)).not.toContain(kaunasStop);
    expect(stops).toEqual([expect.objectContaining(VILNIUS)]);
    await expect(
      db.selectFrom('trip').select('contentVersion').where('albumId', '=', albumId).executeTakeFirstOrThrow(),
    ).resolves.toEqual({ contentVersion: contentVersion + 1 });
  });

  it('brings back an asset added to the album that a mirroring took out before its star was written', async () => {
    const { ctx, job, sut, user, newAsset, star, favoritesTrip, albumAssetIds, mirror } = await setup();
    const first = await newAsset(user.id, VILNIUS);
    await star(user.id, first);
    await mirror(true);
    const [{ albumId }] = await favoritesTrip();
    const added = await newAsset(user.id, KAUNAS);

    await ctx.newAlbumAsset({ albumId, assetId: added });
    await mirror();
    await expect(albumAssetIds(albumId)).resolves.toEqual([first]);
    await sut.onAlbumAssetsAdd({ albumId, assetIds: [added] });
    expect(job.queue).toHaveBeenCalledWith({
      name: JobName.TripFavorites,
      data: { userId: user.id, canCreate: false },
    });
    await mirror();

    await expect(albumAssetIds(albumId)).resolves.toEqual([first, added].toSorted());
  });

  it('lets a Space contribute nothing to the Favorites album', async () => {
    const { ctx, user, newAsset, star, favoritesTrip, mirror } = await setup();
    await star(user.id, await newAsset(user.id, VILNIUS));
    await mirror(true);
    const [{ albumId }] = await favoritesTrip();
    const { album } = await ctx.newAlbum({ ownerId: user.id });
    const { user: editor } = await ctx.newUser();
    const { user: other } = await ctx.newUser();
    const { space } = await ctx.newSharedSpace({ createdById: user.id });
    await ctx.newSharedSpaceMember({ spaceId: space.id, userId: editor.id, role: SharedSpaceRole.Editor });
    const pooled = await newAsset(other.id, KAUNAS);
    await ctx.newSharedSpaceAsset({ spaceId: space.id, assetId: pooled });
    await ctx.newSharedSpaceAlbum({ spaceId: space.id, albumId });
    await ctx.newSharedSpaceAlbum({ spaceId: space.id, albumId: album.id });
    const spaces = new SharedSpaceRepository(db);

    await expect(spaces.getContributableAssetSpaces(editor.id, albumId, [pooled])).resolves.toEqual([]);
    await expect(spaces.getContributableAssetSpaces(editor.id, album.id, [pooled])).resolves.toEqual([
      { assetId: pooled, spaceId: space.id },
    ]);
  });

  it('stars the album of an imported Favorites trip and queues its mirroring, and the nightly sweep mirrors every one', async () => {
    const { ctx, job, trips, user, newAsset, favoritesTrip } = await setup();
    const assetId = await newAsset(user.id, VILNIUS);
    const { album } = await ctx.newAlbum({ ownerId: user.id }, [assetId]);
    const document = { kind: 'places', isFavorites: true, assets: [], language: 'ru' };

    await trips.import(factory.auth({ user }), album.id, TripImportDto.schema.parse(document));

    await expect(
      db.selectFrom('asset_favorite').select('assetId').where('userId', '=', user.id).execute(),
    ).resolves.toEqual([{ assetId }]);
    expect(job.queue).toHaveBeenCalledWith({
      name: JobName.TripFavorites,
      data: { userId: user.id, canCreate: false },
    });
    await expect(favoritesTrip()).resolves.toHaveLength(1);

    job.queueAll.mockClear();
    await trips.handleFileSweep();
    expect(job.queueAll.mock.calls[0][0]).toContainEqual({
      name: JobName.TripFavorites,
      data: { userId: user.id, canCreate: false },
    });
  });
});
