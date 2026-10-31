import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import type { ArgOf } from 'src/repositories/event.repository.js';
import type { JobOf } from 'src/types.js';
import { OnEvent, OnJob } from 'src/decorators.js';
import { JobName, JobStatus, Permission, QueueName } from 'src/enum.js';
import { AccessRepository } from 'src/repositories/access.repository.js';
import { JobRepository } from 'src/repositories/job.repository.js';
import {
  TripCreateDto,
  TripEndDto,
  TripImportDto,
  TripLikeDto,
  TripResponseDto,
  TripStopUpdateDto,
} from 'src/trips/dtos/trip.dto.js';
import { TripKind, TripPointSource, TripStopRole } from 'src/trips/enum.js';
import { TripCreateResult, TripEditResult, TripLiker, TripRepository } from 'src/trips/repositories/trip.repository.js';
import { layOutTrip, routeLegs } from 'src/trips/utils/lay-out.js';
import { checkAccess } from 'src/utils/access.js';
import { asDateTimeString } from 'src/utils/date.js';

type Trip = NonNullable<Awaited<ReturnType<TripRepository['get']>>>;

// Not a BaseService: it needs two repositories, and BaseService's constructor is upstream's (trips DECISIONS-LOG).
@Injectable()
export class TripService {
  constructor(
    private accessRepository: AccessRepository,
    private jobRepository: JobRepository,
    private tripRepository: TripRepository,
  ) {}

  // Assets added to a trip's album, by anyone and from any client, are filed into stops (trips PLAN D12).
  @OnEvent({ name: 'AlbumUpdate' })
  async onAlbumUpdate({ id }: ArgOf<'AlbumUpdate'>) {
    if (await this.tripRepository.hasTrip(id)) {
      await this.jobRepository.queue({ name: JobName.TripFile, data: { id } });
    }
  }

  // An asset added before its metadata was read waits for it: its time and GPS decide its stop.
  @OnEvent({ name: 'AssetMetadataExtracted' })
  async onAssetMetadataExtracted({ assetId }: ArgOf<'AssetMetadataExtracted'>) {
    const albumIds = await this.tripRepository.getTripAlbumIds(assetId);
    await this.jobRepository.queueAll(albumIds.map((id) => ({ name: JobName.TripFile, data: { id } })));
  }

  @OnJob({ name: JobName.TripFile, queue: QueueName.BackgroundTask })
  async handleFile({ id }: JobOf<JobName.TripFile>): Promise<JobStatus> {
    await this.tripRepository.fileNewAssets(id);
    return JobStatus.Success;
  }

  // Nightly: files what no event reached, such as assets added while the worker was down.
  @OnJob({ name: JobName.TripFileSweep, queue: QueueName.BackgroundTask })
  async handleFileSweep(): Promise<JobStatus> {
    const albumIds = await this.tripRepository.getAlbumIdsToFile();
    await this.jobRepository.queueAll(albumIds.map((id) => ({ name: JobName.TripFile, data: { id } })));
    return JobStatus.Success;
  }

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
    await this.requireOwner(auth, albumId, 'Only the album owner can import a trip');
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
    return this.created(auth, albumId, result);
  }

  /**
   * Makes a trip of the album and lays every asset out into new stops by its kind, the rest Unplaced (trips PLAN
   * §2.5). A route also gets its start and finish and pending legs between consecutive stops. Owner only.
   */
  async create(auth: AuthDto, dto: TripCreateDto): Promise<TripResponseDto> {
    const { albumId, kind, start, finish, isFinishAtStart } = dto;
    await this.requireOwner(auth, albumId, 'Only the album owner can make a trip');
    const assets = await this.tripRepository.getLayoutAssets(albumId);
    const layout = layOutTrip(kind, assets, start);

    const startStop = start && endStop(albumId, TripStopRole.Start, start);
    const finishEnd = isFinishAtStart ? start : finish;
    const finishStop = finishEnd && { ...endStop(albumId, TripStopRole.Finish, finishEnd), isFinishAtStart };
    const stops = layout.stops.map(({ latitude, longitude, start, end }) => ({
      id: randomUUID(),
      albumId,
      latitude,
      longitude,
      localStart: start,
      localEnd: end,
    }));
    const route = [startStop, ...stops, finishStop].filter((stop) => !!stop);
    const result = await this.tripRepository.create(auth.user.id, {
      trip: { albumId, kind, contentVersion: 1 },
      places: [],
      stops: route,
      assets: layout.assets.map(({ assetId, stopIndex, point }) => ({
        albumId,
        assetId,
        stopId: stopIndex === null ? null : stops[stopIndex].id,
        latitude: point?.latitude ?? null,
        longitude: point?.longitude ?? null,
        pointSource: point && TripPointSource.Inferred,
      })),
      legs:
        kind === TripKind.Route
          ? routeLegs(route).map(({ from, to, mode }) => ({ albumId, fromStopId: from.id, toStopId: to.id, mode }))
          : [],
      overlays: [],
      likes: [],
      generatedCaptions: [],
    });
    return this.created(auth, albumId, result);
  }

  /** Sets a stop's title, story or place. The album's owner and editors edit (trips PLAN D7). */
  async updateStop(auth: AuthDto, albumId: string, stopId: string, dto: TripStopUpdateDto): Promise<TripResponseDto> {
    await this.requireEdit(auth, albumId);
    switch (await this.tripRepository.updateStop(albumId, stopId, dto)) {
      case TripEditResult.TripMissing: {
        throw new NotFoundException('Trip not found');
      }
      case TripEditResult.StopMissing: {
        throw new NotFoundException('Stop not found in the trip');
      }
      case TripEditResult.PlaceForeign: {
        throw new BadRequestException('The place is not in the trip');
      }
      case TripEditResult.Updated: {
        return this.read(auth, albumId);
      }
    }
  }

  private async created(auth: AuthDto, albumId: string, result: TripCreateResult): Promise<TripResponseDto> {
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

  // A reader who is not the album owner gets 403; anyone else 404, as for a missing album.
  private async requireOwner(auth: AuthDto, albumId: string, refusal: string) {
    await this.requireRead(auth, albumId);
    const isOwner = await this.accessRepository.album.checkOwnerAccess(auth.user.id, new Set([albumId]));
    if (auth.sharedLink || !isOwner.has(albumId)) {
      throw new ForbiddenException(refusal);
    }
  }

  // A reader who cannot edit (a viewer, a shared link) gets 403; anyone else 404, as for a missing album.
  private async requireEdit(auth: AuthDto, albumId: string) {
    await this.requireRead(auth, albumId);
    const allowed = await checkAccess(this.accessRepository, {
      auth,
      permission: Permission.AlbumUpdate,
      ids: [albumId],
    });
    if (!allowed.has(albumId)) {
      throw new ForbiddenException('Only the album owner and editors edit the trip');
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

// A start or finish of a route: a stop without assets, named by its coordinates until the owner names it.
const endStop = (albumId: string, role: TripStopRole, { latitude, longitude, title }: TripEndDto) => ({
  id: randomUUID(),
  albumId,
  role,
  latitude,
  longitude,
  title: title ?? `${latitude.toFixed(5)}, ${longitude.toFixed(5)}`,
  titleSource: 'manual',
  isAddedByHand: true,
});

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
