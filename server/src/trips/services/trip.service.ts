import {
  BadGatewayException,
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
  TripAssetPointDto,
  TripAssetsCenterDto,
  TripAssetsMoveDto,
  TripCamerasDto,
  TripCreateDto,
  TripEndDto,
  TripFinishUpdateDto,
  TripGeoPlacesDto,
  TripGeoReverseQueryDto,
  TripGeoSearchDto,
  TripImportDto,
  TripLegModeUpdateDto,
  TripLegStationUpdateDto,
  TripLegStationsDto,
  TripLikeDto,
  TripPlaceHintsDto,
  TripPointCreateDto,
  TripPointOrderDto,
  TripResponseDto,
  TripStopCreateDto,
  TripStopSplitDto,
  TripStopUpdateDto,
  TripTransitUpdateDto,
} from 'src/trips/dtos/trip.dto.js';
import {
  TripKind,
  TripLegMode,
  TripLegStatus,
  TripPointSource,
  TripStationSide,
  TripStopRole,
} from 'src/trips/enum.js';
import { TripEdited, TripEditorRepository } from 'src/trips/repositories/trip-editor.repository.js';
import { TripGeoError, TripGeoRepository } from 'src/trips/repositories/trip-geo.repository.js';
import {
  RoutingLegRow,
  TripCreateResult,
  TripEditResult,
  TripLiker,
  TripRepository,
} from 'src/trips/repositories/trip.repository.js';
import { clockCameras } from 'src/trips/utils/clock.js';
import { type LatLng, pointOf } from 'src/trips/utils/geo.js';
import { layOutTrip, routeLegs } from 'src/trips/utils/lay-out.js';
import {
  nominatimReverseRequest,
  nominatimSearchRequest,
  parseNominatimPlace,
  parseNominatimSearch,
  resolveTripNamingLanguages,
  tripNamingLanguages,
} from 'src/trips/utils/naming.js';
import { placeHints } from 'src/trips/utils/place-hints.js';
import { type LegRouter, type RoutingLeg, buildLeg } from 'src/trips/utils/route-leg.js';
import {
  type StationCandidate,
  brouterRequest,
  isOffered,
  parseBRouter,
  parseStations,
  parseValhalla,
  stationsRequest,
  valhallaRequest,
} from 'src/trips/utils/routing.js';
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
    private tripGeoRepository: TripGeoRepository,
    private tripEditorRepository: TripEditorRepository,
  ) {}

  private readonly languages = resolveTripNamingLanguages();

  // Stations are named in the trip's language, as its stops are (trips DECISIONS-LOG 2026-10-31, owner).
  private routerFor(language: string): LegRouter {
    return {
      valhalla: (costing, a, b) => this.tripGeoRepository.fetchJson(valhallaRequest(costing, a, b), parseValhalla),
      brouter: (profile, a, b) => this.tripGeoRepository.fetchJson(brouterRequest(profile, a, b), parseBRouter),
      stations: (point) => this.tripGeoRepository.fetchJson(stationsRequest(point), parseStations(point, language)),
    };
  }

  // The trip's own language, else the instance's first.
  private async languageOf(albumId: string): Promise<string> {
    return tripNamingLanguages(await this.tripRepository.getLanguage(albumId), this.languages).language;
  }

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
    const filed = await this.tripRepository.fileNewAssets(id);
    // A new stop of a route splits a leg into pending ones.
    if (filed.assets > 0 && (await this.tripRepository.hasPendingLegs(id))) {
      await this.queueRouting(id);
    }
    if (filed.stops > 0) {
      await this.queueNaming(id);
    }
    // Times changed since filing, by the clock-offset wizard or a date edit, move their stops (trips PLAN D9).
    const retimed = await this.tripEditorRepository.retime(id);
    if (retimed.needsRouting) {
      await this.queueRouting(id);
    }
    return JobStatus.Success;
  }

  /**
   * Builds the line of every pending leg (trips PLAN §2.5, travel-album `route_legs`). The services are asked outside
   * any transaction, which may take minutes at one request per second per host; each line is then written only if
   * its leg did not change meanwhile.
   */
  @OnJob({ name: JobName.TripRouteLegs, queue: QueueName.BackgroundTask })
  async handleRouteLegs({ id }: JobOf<JobName.TripRouteLegs>): Promise<JobStatus> {
    const legs = await this.tripRepository.getRoutingLegs(id);
    if (legs.length === 0) {
      return JobStatus.Skipped;
    }
    const router = this.routerFor(await this.languageOf(id));
    const built = [];
    for (const read of legs) {
      built.push({ read, built: await buildLeg(routingLeg(read), router) });
    }
    await this.tripRepository.writeRoutedLegs(id, built);
    return JobStatus.Success;
  }

  // Nightly: files what no event reached, such as assets added while the worker was down, and names again the stops a
  // failed or interrupted naming left without a title.
  @OnJob({ name: JobName.TripFileSweep, queue: QueueName.BackgroundTask })
  async handleFileSweep(): Promise<JobStatus> {
    const [toFile, toName] = await Promise.all([
      this.tripRepository.getAlbumIdsToFile(),
      this.tripRepository.getAlbumIdsToName(),
    ]);
    await this.jobRepository.queueAll([
      ...toFile.map((id) => ({ name: JobName.TripFile, data: { id } }) as const),
      ...toName.map((id) => ({ name: JobName.TripName, data: { id } }) as const),
    ]);
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
      trip: {
        albumId,
        kind: dto.kind,
        isFavorites: dto.isFavorites,
        isShowcased: dto.isShowcased,
        language: dto.language,
        contentVersion: 1,
      },
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
    // Names untitled stops, and fetches the second language of the names the document brought.
    const trip = await this.created(auth, albumId, result, dto.kind);
    if (dto.legs.some(({ mode, status }) => status === TripLegStatus.Pending && mode !== TripLegMode.Trail)) {
      await this.queueRouting(albumId);
    }
    return trip;
  }

  /**
   * Makes a trip of the album and lays every asset out into new stops by its kind, the rest Unplaced (trips PLAN
   * §2.5). A route also gets its start and finish and pending legs between consecutive stops. Owner only.
   */
  async create(auth: AuthDto, dto: TripCreateDto): Promise<TripResponseDto> {
    const { albumId, kind, start, finish, isFinishAtStart, language } = dto;
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
    const legs =
      kind === TripKind.Route
        ? routeLegs(route).map(({ from, to, mode }) => ({ albumId, fromStopId: from.id, toStopId: to.id, mode }))
        : [];
    const result = await this.tripRepository.create(auth.user.id, {
      trip: { albumId, kind, language, contentVersion: 1 },
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
      legs,
      overlays: [],
      likes: [],
      generatedCaptions: [],
    });
    const trip = await this.created(auth, albumId, result, kind);
    if (legs.length > 0) {
      await this.queueRouting(albumId);
    }
    return trip;
  }

  /**
   * Sets a stop's title, story, place or pin, or gives the pin back to its assets. The album's owner and editors edit
   * (trips PLAN D7). A cleared title is named again (travel-album `editor.edited`), and a moved pin routes its legs
   * again.
   */
  async updateStop(auth: AuthDto, albumId: string, stopId: string, dto: TripStopUpdateDto): Promise<TripResponseDto> {
    return this.editStops(auth, albumId, () => this.tripEditorRepository.updateStop(albumId, stopId, dto));
  }

  /** Merges a stop with the next one in trip order; the first keeps its texts. */
  async mergeNextStop(auth: AuthDto, albumId: string, stopId: string): Promise<TripResponseDto> {
    return this.editStops(auth, albumId, () => this.tripEditorRepository.mergeNext(albumId, stopId));
  }

  /** Splits a stop: the asset and every later one go to a new stop. */
  async splitStop(auth: AuthDto, albumId: string, stopId: string, dto: TripStopSplitDto): Promise<TripResponseDto> {
    return this.editStops(auth, albumId, () => this.tripEditorRepository.split(albumId, stopId, dto.assetId));
  }

  /** Deletes a stop without assets. */
  async deleteStop(auth: AuthDto, albumId: string, stopId: string): Promise<TripResponseDto> {
    return this.editStops(auth, albumId, () => this.tripEditorRepository.deleteStop(albumId, stopId));
  }

  /** Makes a new stop of the chosen assets. */
  async createStop(auth: AuthDto, albumId: string, dto: TripStopCreateDto): Promise<TripResponseDto> {
    return this.editStops(auth, albumId, () => this.tripEditorRepository.newStop(albumId, dto.assetIds));
  }

  /** Moves the chosen assets into a stop. */
  async moveAssets(auth: AuthDto, albumId: string, dto: TripAssetsMoveDto): Promise<TripResponseDto> {
    return this.editStops(auth, albumId, () => this.tripEditorRepository.moveAssets(albumId, dto.assetIds, dto.stopId));
  }

  /** Adds a point by hand to a route, right after a stop or the start. */
  async addPoint(auth: AuthDto, albumId: string, dto: TripPointCreateDto): Promise<TripResponseDto> {
    const { afterStopId, ...point } = dto;
    return this.editStops(auth, albumId, () =>
      this.tripEditorRepository.addPoint(albumId, pointOfEnd(point), afterStopId),
    );
  }

  /** Puts a point added by hand right after another stop, or the start. */
  async movePoint(auth: AuthDto, albumId: string, stopId: string, dto: TripPointOrderDto): Promise<TripResponseDto> {
    return this.editStops(auth, albumId, () => this.tripEditorRepository.movePoint(albumId, stopId, dto.afterStopId));
  }

  /** Sets or moves the start of a route; null removes it. A finish at the start follows. */
  async setStart(auth: AuthDto, albumId: string, dto: TripEndDto | null): Promise<TripResponseDto> {
    return this.editStops(auth, albumId, () => this.tripEditorRepository.setStart(albumId, dto && pointOfEnd(dto)));
  }

  /** Sets or moves the finish of a route, or puts it at the start; null removes it. */
  async setFinish(auth: AuthDto, albumId: string, dto: TripFinishUpdateDto | null): Promise<TripResponseDto> {
    const point =
      dto && !dto.isFinishAtStart
        ? pointOfEnd({ latitude: dto.latitude!, longitude: dto.longitude!, title: dto.title })
        : null;
    return this.editStops(auth, albumId, () =>
      this.tripEditorRepository.setFinish(albumId, point, dto?.isFinishAtStart ?? false),
    );
  }

  /** Marks stops of a route as shot on the way, not, or undecided. */
  async setTransit(auth: AuthDto, albumId: string, dto: TripTransitUpdateDto): Promise<TripResponseDto> {
    return this.editStops(auth, albumId, () =>
      this.tripEditorRepository.setTransit(albumId, dto.stopIds, dto.isTransit),
    );
  }

  /** Sets the owner's point of an asset in the trip; null removes it. Assets without GPS are placed again. */
  async setAssetPoint(
    auth: AuthDto,
    albumId: string,
    assetId: string,
    dto: TripAssetPointDto | null,
  ): Promise<TripResponseDto> {
    return this.editStops(auth, albumId, () =>
      this.tripEditorRepository.setAssetPoint(
        albumId,
        assetId,
        dto && { latitude: dto.latitude, longitude: dto.longitude },
      ),
    );
  }

  /** Files Unplaced assets of a Places trip to its centre stop, made at `centre` the first time. */
  async toCenter(auth: AuthDto, albumId: string, dto: TripAssetsCenterDto): Promise<TripResponseDto> {
    return this.editStops(auth, albumId, () =>
      this.tripEditorRepository.toCenter(albumId, dto.assetIds, dto.centre && pointOfEnd(dto.centre)),
    );
  }

  /**
   * The album's cameras for the clock-offset wizard, with a suggested shift where one is worth it (trips PLAN D9).
   * Editors open it; the shift itself goes through Immich's bulk asset update, and only on the caller's own assets.
   */
  async getCameras(auth: AuthDto, albumId: string): Promise<TripCamerasDto> {
    await this.requireEdit(auth, albumId);
    const kind = await this.tripRepository.getKind(albumId);
    if (!kind) {
      throw new NotFoundException('Trip not found');
    }
    const assets = await this.tripRepository.getClockAssets(albumId);
    return { cameras: clockCameras(assets, auth.user.id, kind) };
  }

  /**
   * Places offered to the Unplaced assets of a Places trip by their CLIP embeddings (travel-album `place_hints`); none
   * for another kind. Editors only: the hints serve filing.
   */
  async getPlaceHints(auth: AuthDto, albumId: string): Promise<TripPlaceHintsDto> {
    await this.requireEdit(auth, albumId);
    const found = await this.tripRepository.getPlaceHintRows(albumId);
    return found ? placeHints(found.rows, found.hasCenter) : { places: [], center: [] };
  }

  /**
   * Up to five places by address or name, in the trip's language, for picking a point (travel-album `geo/search`).
   * Editors only: it asks Nominatim on their behalf.
   */
  async searchPlaces(auth: AuthDto, albumId: string, { query }: TripGeoSearchDto): Promise<TripGeoPlacesDto> {
    await this.requireEdit(auth, albumId);
    const request = nominatimSearchRequest(query, await this.languageOf(albumId));
    return { places: await this.geocode(() => this.tripGeoRepository.fetchJson(request, parseNominatimSearch)) };
  }

  /** The place at a point, in the trip's language; none where Nominatim knows no place (travel-album `geo/reverse`). */
  async reversePlace(auth: AuthDto, albumId: string, point: TripGeoReverseQueryDto): Promise<TripGeoPlacesDto> {
    await this.requireEdit(auth, albumId);
    const request = nominatimReverseRequest(point, await this.languageOf(albumId));
    const place = await this.geocode(() => this.tripGeoRepository.fetchJson(request, parseNominatimPlace));
    return { places: place ? [place] : [] };
  }

  // A geo service that does not answer is 502, as in travel-album.
  private async geocode<T>(ask: () => Promise<T>): Promise<T> {
    try {
      return await ask();
    } catch (error) {
      if (error instanceof TripGeoError) {
        throw new BadGatewayException('The place search did not answer; try again later');
      }
      throw error;
    }
  }

  // A stop edit by the album's owner or an editor, then as travel-album's `editor.edited`: pending legs are routed and
  // untitled stops named.
  private async editStops(auth: AuthDto, albumId: string, edit: () => Promise<TripEdited>): Promise<TripResponseDto> {
    await this.requireEdit(auth, albumId);
    const edited = await edit();
    if (edited.result !== TripEditResult.Updated) {
      throw refusal(edited.result);
    }
    if (edited.needsRouting) {
      await this.queueRouting(albumId);
    }
    if (edited.needsNaming) {
      await this.queueNaming(albumId);
    }
    return this.read(auth, albumId);
  }

  /**
   * Sets a leg's mode, or gives it back to the default by distance (`mode: null`). The leg is built again, its train
   * stations forgotten. The album's owner and editors edit.
   */
  async setLegMode(auth: AuthDto, albumId: string, legId: string, dto: TripLegModeUpdateDto): Promise<TripResponseDto> {
    return this.editLeg(auth, albumId, () => this.tripRepository.setLegMode(albumId, legId, dto.mode));
  }

  /** Up to five stations near each end of a leg, nearest first (travel-album `leg_stations`). Editors only. */
  async getLegStations(auth: AuthDto, albumId: string, legId: string): Promise<TripLegStationsDto> {
    await this.requireEdit(auth, albumId);
    const leg = await this.requireLeg(albumId, legId);
    const language = await this.languageOf(albumId);
    return {
      departure: await this.stationsNear(leg.from, language),
      arrival: await this.stationsNear(leg.to, language),
    };
  }

  /**
   * Picks the station at one end of a train leg; the leg is built again. Only a station `getLegStations` offers at
   * that end is taken, so the name is OpenStreetMap's and not any text (travel-album `set_leg_station`).
   */
  async setLegStation(
    auth: AuthDto,
    albumId: string,
    legId: string,
    { side, ...station }: TripLegStationUpdateDto,
  ): Promise<TripResponseDto> {
    return this.editLeg(auth, albumId, async () => {
      const leg = await this.requireLeg(albumId, legId);
      if (leg.mode !== TripLegMode.Train) {
        throw refusal(TripEditResult.LegNotTrain);
      }
      const end = side === TripStationSide.Departure ? leg.from : leg.to;
      if (!isOffered(station, await this.stationsNear(end, await this.languageOf(albumId)))) {
        throw new BadRequestException('The station is not one offered at that end of the leg');
      }
      return this.tripRepository.setLegStation(albumId, legId, side, station);
    });
  }

  /** Sends a leg that needs attention back to routing, mode unchanged. */
  async retryLeg(auth: AuthDto, albumId: string, legId: string): Promise<TripResponseDto> {
    return this.editLeg(auth, albumId, () => this.tripRepository.retryLeg(albumId, legId));
  }

  /** Sends every leg of the trip that needs attention back to routing. */
  async retryLegs(auth: AuthDto, albumId: string): Promise<TripResponseDto> {
    return this.editLeg(auth, albumId, () => this.tripRepository.retryLegs(albumId));
  }

  // A leg edit by the album's owner or an editor; the leg is routed again.
  private async editLeg(auth: AuthDto, albumId: string, edit: () => Promise<TripEditResult>): Promise<TripResponseDto> {
    await this.requireEdit(auth, albumId);
    const result = await edit();
    if (result !== TripEditResult.Updated) {
      throw refusal(result);
    }
    await this.queueRouting(albumId);
    return this.read(auth, albumId);
  }

  private async requireLeg(albumId: string, legId: string) {
    const leg = await this.tripRepository.getLegEnds(albumId, legId);
    if (!leg) {
      throw refusal(TripEditResult.LegMissing);
    }
    return {
      mode: leg.mode,
      from: pointOf({ latitude: leg.fromLatitude, longitude: leg.fromLongitude }),
      to: pointOf({ latitude: leg.toLatitude, longitude: leg.toLongitude }),
    };
  }

  // A stop without a point has no stations near it. A service that does not answer is 502, as in travel-album.
  private async stationsNear(point: LatLng | null, language: string): Promise<StationCandidate[]> {
    if (!point) {
      return [];
    }
    try {
      return await this.routerFor(language).stations(point);
    } catch (error) {
      if (error instanceof TripGeoError) {
        throw new BadGatewayException('The station search did not answer; try again later');
      }
      throw error;
    }
  }

  private async queueRouting(albumId: string) {
    await this.jobRepository.queue({ name: JobName.TripRouteLegs, data: { id: albumId } });
  }

  private async queueNaming(albumId: string) {
    await this.jobRepository.queue({ name: JobName.TripName, data: { id: albumId } });
  }

  private async created(
    auth: AuthDto,
    albumId: string,
    result: TripCreateResult,
    kind: TripKind,
  ): Promise<TripResponseDto> {
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
        // A Plain trip has no map, so nothing to name (travel-album PLAN §5.12).
        if (kind !== TripKind.Plain) {
          await this.queueNaming(albumId);
        }
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

// The HTTP answer to an edit the repository refused.
const refusal = (result: Exclude<TripEditResult, TripEditResult.Updated>) => {
  switch (result) {
    case TripEditResult.TripMissing: {
      return new NotFoundException('Trip not found');
    }
    case TripEditResult.StopMissing: {
      return new NotFoundException('Stop not found in the trip');
    }
    case TripEditResult.LegMissing: {
      return new NotFoundException('Leg not found in the trip');
    }
    case TripEditResult.StopIsEnd: {
      return new BadRequestException('The start and finish are edited as such');
    }
    case TripEditResult.StopIsPoint: {
      return new BadRequestException('A point added by hand has no assets');
    }
    case TripEditResult.StopNotPoint: {
      return new BadRequestException('Only a point added by hand moves in the order; stops go by their assets’ time');
    }
    case TripEditResult.NotRoute: {
      return new BadRequestException('Only a Route trip has points, a start, a finish and stops on the way');
    }
    case TripEditResult.NoStart: {
      return new BadRequestException('A finish at the start needs a start');
    }
    case TripEditResult.AfterFinish: {
      return new BadRequestException('Nothing goes after the finish');
    }
    case TripEditResult.StopHasAssets: {
      return new BadRequestException('Only a stop without assets is deleted');
    }
    case TripEditResult.NoMap: {
      return new BadRequestException('A Plain trip has no map');
    }
    case TripEditResult.MergeLast: {
      return new BadRequestException('The last stop has no next one to merge with');
    }
    case TripEditResult.SplitFirst: {
      return new BadRequestException('A stop is split after its first asset');
    }
    case TripEditResult.AssetForeign: {
      return new BadRequestException('An asset is not in the trip, or in the trash');
    }
    case TripEditResult.MoveEmpties: {
      return new BadRequestException('A stop would be left without assets; merge it instead');
    }
    case TripEditResult.AssetMissing: {
      return new NotFoundException('Asset not found in the trip');
    }
    case TripEditResult.AssetPlaced: {
      return new BadRequestException('Only Unplaced assets go to the centre');
    }
    case TripEditResult.NotPlaces: {
      return new BadRequestException('Only a Places trip has a centre');
    }
    case TripEditResult.NoCenter: {
      return new BadRequestException('The trip has no centre yet; give one');
    }
    case TripEditResult.PlaceForeign: {
      return new BadRequestException('The place is not in the trip');
    }
    case TripEditResult.LegNotTrain: {
      return new BadRequestException('Only a train leg has stations');
    }
    case TripEditResult.LegNotAttention: {
      return new BadRequestException('Only a leg that needs attention is retried');
    }
    case TripEditResult.NoLegsToRetry: {
      return new BadRequestException('No leg of the trip needs attention');
    }
    case TripEditResult.Unchanged: {
      return new BadRequestException('Nothing changed');
    }
  }
};

const stationOf = (name: string | null, latitude: number | null, longitude: number | null) =>
  latitude === null || longitude === null ? null : { name: name ?? '', latitude, longitude };

// A pending leg as `buildLeg` takes it. The routing query leaves out legs whose stops have no point.
const routingLeg = (row: RoutingLegRow): RoutingLeg => ({
  mode: row.mode,
  isModeManual: row.isModeManual,
  from: { latitude: row.fromLatitude!, longitude: row.fromLongitude! },
  to: { latitude: row.toLatitude!, longitude: row.toLongitude! },
  departure: stationOf(row.departureName, row.departureLatitude, row.departureLongitude),
  arrival: stationOf(row.arrivalName, row.arrivalLatitude, row.arrivalLongitude),
});

// A start or finish of a route: a stop without assets. A title the owner gave is manual; without one, naming gives it.
const endStop = (albumId: string, role: TripStopRole, { latitude, longitude, title }: TripEndDto) => ({
  id: randomUUID(),
  albumId,
  role,
  latitude,
  longitude,
  title,
  titleSource: title && 'manual',
  isAddedByHand: true,
});

// A start, finish or point the owner picked; without a title, naming gives one.
const pointOfEnd = ({ latitude, longitude, title }: TripEndDto) => ({ latitude, longitude, title: title ?? null });

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
  language: trip.language,
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
