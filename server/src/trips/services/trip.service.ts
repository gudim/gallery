import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import { Permission } from 'src/enum.js';
import { AccessRepository } from 'src/repositories/access.repository.js';
import { TripImportDto, TripLikeDto, TripResponseDto } from 'src/trips/dtos/trip.dto.js';
import { TripCreateResult, TripLiker, TripRepository } from 'src/trips/repositories/trip.repository.js';
import { checkAccess } from 'src/utils/access.js';
import { asDateTimeString } from 'src/utils/date.js';

type Trip = NonNullable<Awaited<ReturnType<TripRepository['get']>>>;

// Not a BaseService: it needs two repositories, and BaseService's constructor is upstream's (trips DECISIONS-LOG).
@Injectable()
export class TripService {
  constructor(
    private accessRepository: AccessRepository,
    private tripRepository: TripRepository,
  ) {}

  /** `viewerKey` is a guest's browser key, which tells whether they liked each asset. */
  async get(auth: AuthDto, albumId: string, viewerKey?: string): Promise<TripResponseDto> {
    await this.requireRead(auth, albumId);
    return this.read(auth, albumId, likerOf(auth, viewerKey));
  }

  /**
   * Anyone who can read the trip likes its assets (travel-album PLAN §5.17): a user as themselves, a guest by their
   * browser key. A second like changes nothing. Likes do not bump `contentVersion`.
   */
  async like(auth: AuthDto, albumId: string, assetId: string, viewerKey?: string): Promise<TripLikeDto> {
    await this.requireAsset(auth, albumId, assetId);
    const liker = likerOf(auth, viewerKey);
    if (!liker) {
      throw new BadRequestException('A guest likes with a browser key');
    }
    await this.tripRepository.like(albumId, assetId, liker);
    return { assetId, ...(await this.tripRepository.getLike(albumId, assetId, liker)) };
  }

  async unlike(auth: AuthDto, albumId: string, assetId: string, viewerKey?: string): Promise<TripLikeDto> {
    await this.requireAsset(auth, albumId, assetId);
    const liker = likerOf(auth, viewerKey);
    if (liker) {
      await this.tripRepository.unlike(albumId, assetId, liker);
    }
    return { assetId, ...(await this.tripRepository.getLike(albumId, assetId, liker)) };
  }

  /** Creates the album's trip from one document (trips PLAN §2.1). Owner only; an album has at most one trip. */
  async import(auth: AuthDto, albumId: string, dto: TripImportDto): Promise<TripResponseDto> {
    await this.requireRead(auth, albumId);
    const isOwner = await this.accessRepository.album.checkOwnerAccess(auth.user.id, new Set([albumId]));
    if (auth.sharedLink || !isOwner.has(albumId)) {
      throw new ForbiddenException('Only the album owner can import a trip');
    }
    const assetIds = [...new Set([...dto.assets, ...dto.likes].map(({ assetId }) => assetId))];
    const inAlbum = await this.tripRepository.getAlbumAssetIds(albumId, assetIds);
    const missing = assetIds.filter((id) => !inAlbum.has(id));
    if (missing.length > 0) {
      throw new BadRequestException(`Assets not in the album: ${missing.join(', ')}`);
    }

    const placeIds = new Map(dto.places.map(({ key }) => [key, randomUUID()]));
    const stopIds = new Map(dto.stops.map(({ key }) => [key, randomUUID()]));
    const result = await this.tripRepository.create(auth.user.id, {
      trip: { albumId, kind: dto.kind, isFavorites: dto.isFavorites, isShowcased: dto.isShowcased, contentVersion: 1 },
      places: dto.places.map((place) => ({ ...place, id: placeIds.get(place.key)!, albumId })),
      stops: dto.stops.map(({ key, placeKey, ...stop }) => ({
        ...stop,
        id: stopIds.get(key)!,
        albumId,
        placeId: placeKey === null ? null : placeIds.get(placeKey)!,
      })),
      assets: dto.assets.map(({ stopKey, generatedCaption: _, ...asset }) => ({
        ...asset,
        albumId,
        stopId: stopKey === null ? null : stopIds.get(stopKey)!,
      })),
      legs: dto.legs.map(({ fromStopKey, toStopKey, ...leg }) => ({
        ...leg,
        albumId,
        fromStopId: stopIds.get(fromStopKey)!,
        toStopId: stopIds.get(toStopKey)!,
      })),
      overlays: dto.overlays.map((overlay) => ({ ...overlay, albumId })),
      // An imported count becomes that many likes by unknown browsers (trips DECISIONS-LOG 2026-10-31).
      likes: dto.likes.flatMap(({ assetId, count }) =>
        Array.from({ length: count }, () => ({ albumId, assetId, viewerKey: `import:${randomUUID()}` })),
      ),
      generatedCaptions: dto.assets.flatMap(({ assetId, generatedCaption }) =>
        generatedCaption === null ? [] : [{ assetId, text: generatedCaption }],
      ),
    });

    switch (result) {
      case TripCreateResult.AlbumMissing: {
        throw new NotFoundException('Trip not found');
      }
      case TripCreateResult.TripExists: {
        throw new ConflictException('The album already has a trip');
      }
      case TripCreateResult.FavoritesExists: {
        throw new ConflictException('The owner already has a Favorites trip');
      }
      case TripCreateResult.Created: {
        return this.read(auth, albumId);
      }
    }
  }

  // Owner, editor, viewer or the album's shared link (trips PLAN D7). Anyone else gets 404, as for a missing album.
  private async requireRead(auth: AuthDto, albumId: string) {
    const allowed = await checkAccess(this.accessRepository, {
      auth,
      permission: Permission.AlbumRead,
      ids: [albumId],
    });
    if (!allowed.has(albumId)) {
      throw new NotFoundException('Trip not found');
    }
  }

  // An asset of a trip the caller can read, outside the trash; anything else is 404.
  private async requireAsset(auth: AuthDto, albumId: string, assetId: string) {
    await this.requireRead(auth, albumId);
    if (!(await this.tripRepository.hasAsset(albumId, assetId))) {
      throw new NotFoundException('Asset not found in the trip');
    }
  }

  private async read(auth: AuthDto, albumId: string, liker?: TripLiker): Promise<TripResponseDto> {
    const trip = await this.tripRepository.get(albumId, liker);
    if (!trip) {
      throw new NotFoundException('Trip not found');
    }
    // A shared link that hides metadata hides where each asset was; stops and legs stay (DECISIONS-LOG 2026-10-31).
    return mapTrip(trip, { showAssetPoints: auth.sharedLink?.showExif ?? true });
  }
}

// Through a shared link the caller is a guest, whatever user the link belongs to.
const likerOf = (auth: AuthDto, viewerKey?: string): TripLiker | undefined => {
  if (!auth.sharedLink) {
    return { userId: auth.user.id };
  }
  return viewerKey ? { viewerKey } : undefined;
};

const withoutAlbumId = <T extends { albumId: string }>({ albumId: _, ...rest }: T) => rest;

const mapTrip = (
  { trip, places, stops, assets, legs, overlays, likes }: Trip,
  { showAssetPoints }: { showAssetPoints: boolean },
): TripResponseDto => ({
  albumId: trip.albumId,
  kind: trip.kind,
  isFavorites: trip.isFavorites,
  isShowcased: trip.isShowcased,
  isFeatured: trip.isFeatured,
  contentVersion: trip.contentVersion,
  places: places.map((row) => withoutAlbumId(row)),
  stops: stops
    .map((row) => withoutAlbumId(row))
    .map(({ localStart, localEnd, ...stop }) => ({
      ...stop,
      localStart: asDateTimeString(localStart),
      localEnd: asDateTimeString(localEnd),
    })),
  assets: showAssetPoints
    ? assets
    : assets.map((asset) => ({ ...asset, latitude: null, longitude: null, pointSource: null })),
  legs: legs.map((row) => withoutAlbumId(row)),
  overlays: overlays
    .map((row) => withoutAlbumId(row))
    .map(({ geometry, ...overlay }) => ({
      ...overlay,
      geometry: geometry as Record<string, unknown>,
    })),
  likes,
});
