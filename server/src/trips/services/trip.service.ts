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
import { TripImportDto, TripResponseDto } from 'src/trips/dtos/trip.dto.js';
import { TripRepository } from 'src/trips/repositories/trip.repository.js';
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

  async get(auth: AuthDto, albumId: string): Promise<TripResponseDto> {
    await this.requireRead(auth, albumId);
    const trip = await this.tripRepository.get(albumId);
    if (!trip) {
      throw new NotFoundException('Trip not found');
    }
    return mapTrip(trip);
  }

  /** Creates the album's trip from one document (trips PLAN §2.1). Owner only; an album has at most one trip. */
  async import(auth: AuthDto, albumId: string, dto: TripImportDto): Promise<TripResponseDto> {
    await this.requireRead(auth, albumId);
    const isOwner = await this.accessRepository.album.checkOwnerAccess(auth.user.id, new Set([albumId]));
    if (auth.sharedLink || !isOwner.has(albumId)) {
      throw new ForbiddenException('Only the album owner can import a trip');
    }
    if (await this.tripRepository.exists(albumId)) {
      throw new ConflictException('The album already has a trip');
    }
    if (dto.isFavorites && (await this.tripRepository.hasFavoritesTrip(auth.user.id))) {
      throw new ConflictException('The owner already has a Favorites trip');
    }
    const assetIds = [...new Set([...dto.assets, ...dto.likes].map(({ assetId }) => assetId))];
    const inAlbum = await this.tripRepository.getAlbumAssetIds(albumId, assetIds);
    const missing = assetIds.filter((id) => !inAlbum.has(id));
    if (missing.length > 0) {
      throw new BadRequestException(`Assets not in the album: ${missing.join(', ')}`);
    }

    const placeIds = new Map(dto.places.map(({ key }) => [key, randomUUID()]));
    const stopIds = new Map(dto.stops.map(({ key }) => [key, randomUUID()]));
    await this.tripRepository.create({
      trip: { albumId, kind: dto.kind, isFavorites: dto.isFavorites, isShowcased: dto.isShowcased, contentVersion: 1 },
      places: dto.places.map((place) => ({ ...place, id: placeIds.get(place.key)!, albumId })),
      stops: dto.stops.map(({ key, placeKey, ...stop }) => ({
        ...stop,
        id: stopIds.get(key)!,
        albumId,
        placeId: placeKey === null ? null : placeIds.get(placeKey)!,
      })),
      assets: dto.assets.map(({ stopKey, ...asset }) => ({
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
    });

    return this.get(auth, albumId);
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
}

const mapTrip = ({ trip, places, stops, assets, legs, overlays, likes }: Trip): TripResponseDto => {
  const stopOrder = new Map(stops.map(({ id }, index) => [id, index]));
  return {
    albumId: trip.albumId,
    kind: trip.kind,
    isFavorites: trip.isFavorites,
    isShowcased: trip.isShowcased,
    isFeatured: trip.isFeatured,
    contentVersion: trip.contentVersion,
    places: places.map(({ albumId: _, ...place }) => place),
    stops: stops.map(({ albumId: _, localStart, localEnd, ...stop }) => ({
      ...stop,
      localStart: asDateTimeString(localStart),
      localEnd: asDateTimeString(localEnd),
    })),
    assets,
    legs: legs
      .map(({ albumId: _, ...leg }) => leg)
      .toSorted((a, b) => stopOrder.get(a.fromStopId)! - stopOrder.get(b.fromStopId)! || a.id.localeCompare(b.id)),
    overlays: overlays.map(({ albumId: _, geometry, ...overlay }) => ({
      ...overlay,
      geometry: geometry as Record<string, unknown>,
    })),
    likes,
  };
};
