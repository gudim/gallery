import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import type { JobOf } from 'src/types.js';
import { OnJob } from 'src/decorators.js';
import { JobName, JobStatus, Permission, QueueName } from 'src/enum.js';
import { AccessRepository } from 'src/repositories/access.repository.js';
import { JobRepository } from 'src/repositories/job.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { StorageService } from 'src/services/storage.service.js';
import {
  TripLlmSettingsResponseDto,
  TripLlmSettingsUpdateDto,
  TripTextsEstimateDto,
  TripTextsEstimateQueryDto,
  TripTextsProgressDto,
  TripTextsStartDto,
} from 'src/trips/dtos/trip-texts.dto.js';
import { TripKind, TripTextsProblem } from 'src/trips/enum.js';
import { TripTextsRepository } from 'src/trips/repositories/trip-texts.repository.js';
import { TRIPS_USER_AGENT_VARIABLE, defaultTripGeoUserAgent } from 'src/trips/utils/geo-services.js';
import { TripLlmConfig, completeTripText } from 'src/trips/utils/llm-client.js';
import {
  TripLlmKeyState,
  decryptLlmKey,
  nextLlmKeyCipher,
  resolveLlmSecret,
  tripLlmKeyState,
} from 'src/trips/utils/llm-key.js';
import { resolveTripNamingLanguages } from 'src/trips/utils/naming.js';
import {
  TRIP_TEXTS_CHUNK,
  TripTextCaption,
  TripTextsError,
  checkPlaceAnswer,
  checkStopAnswer,
  isReplaceableText,
  joinCaption,
  placeRequest,
  planStopTexts,
  stopRequest,
} from 'src/trips/utils/texts.js';
import { checkAccess } from 'src/utils/access.js';

const mimeTypeOf = (path: string) => (/\.webp$/i.test(path) ? 'image/webp' : 'image/jpeg');

/** A failed stop or place runs again on its own until this many attempts (trips DECISIONS-LOG 2026-11-01). */
export const TRIP_TEXTS_ATTEMPTS = 3;
const RETRY_DELAY_MS = 60_000;

const PROBLEM_MESSAGES: Record<TripTextsProblem, string> = {
  [TripTextsProblem.NoSettings]: 'No LLM settings',
  [TripTextsProblem.NoConsent]: 'Sending photos to the LLM server is not allowed in the settings',
  [TripTextsProblem.KeyUnreadable]: 'The saved LLM key cannot be read: TRIPS_LLM_SECRET is missing or changed',
};

// LLM texts of trips (trips PLAN §2.6).
@Injectable()
export class TripTextsService {
  private readonly secret = resolveLlmSecret();
  private readonly userAgent = process.env[TRIPS_USER_AGENT_VARIABLE]?.trim() || defaultTripGeoUserAgent();
  private readonly defaultLanguage = resolveTripNamingLanguages()[0];

  constructor(
    private logger: LoggingRepository,
    private accessRepository: AccessRepository,
    private jobRepository: JobRepository,
    private tripTextsRepository: TripTextsRepository,
  ) {
    this.logger.setContext(TripTextsService.name);
  }

  async getSettings(auth: AuthDto): Promise<TripLlmSettingsResponseDto> {
    const settings = await this.tripTextsRepository.getSettings(auth.user.id);
    return {
      url: settings?.url ?? '',
      model: settings?.model ?? '',
      key: tripLlmKeyState(settings?.keyCipher ?? null, this.secret),
      allowUpload: settings?.allowUpload ?? false,
      canStoreKey: !!this.secret,
    };
  }

  async updateSettings(auth: AuthDto, dto: TripLlmSettingsUpdateDto): Promise<TripLlmSettingsResponseDto> {
    const previous = await this.tripTextsRepository.getSettings(auth.user.id);
    await this.tripTextsRepository.upsertSettings({
      userId: auth.user.id,
      url: dto.url,
      model: dto.model,
      keyCipher: nextLlmKeyCipher(previous, dto, this.secret),
      allowUpload: dto.allowUpload,
    });
    return this.getSettings(auth);
  }

  private problemOf(settings: Awaited<ReturnType<TripTextsRepository['getSettings']>>) {
    if (!settings) {
      return TripTextsProblem.NoSettings;
    }
    if (!settings.allowUpload) {
      return TripTextsProblem.NoConsent;
    }
    if (tripLlmKeyState(settings.keyCipher, this.secret) === TripLlmKeyState.Unreadable) {
      return TripTextsProblem.KeyUnreadable;
    }
    return null;
  }

  /** The user's server, or why generation is off; a settings problem is never retried. */
  private async getConfig(userId: string): Promise<TripLlmConfig> {
    const settings = await this.tripTextsRepository.getSettings(userId);
    const problem = this.problemOf(settings);
    if (problem || !settings) {
      throw new TripTextsError(PROBLEM_MESSAGES[problem ?? TripTextsProblem.NoSettings], false);
    }
    const key = settings.keyCipher ? decryptLlmKey(settings.keyCipher, this.secret!) : null;
    return { url: settings.url, model: settings.model, key, userAgent: this.userAgent };
  }

  // Only the album owner generates texts, with their own settings (trips DECISIONS-LOG 2026-11-01); a reader who is
  // not the owner gets 403, anyone else 404, as for a missing album.
  private async requireOwner(auth: AuthDto, albumId: string) {
    const readable = await checkAccess(this.accessRepository, {
      auth,
      permission: Permission.AlbumRead,
      ids: [albumId],
    });
    if (!readable.has(albumId) || !(await this.tripTextsRepository.hasTrip(albumId))) {
      throw new NotFoundException('Trip not found');
    }
    const owned = await this.accessRepository.album.checkOwnerAccess(auth.user.id, new Set([albumId]));
    if (auth.sharedLink || !owned.has(albumId)) {
      throw new ForbiddenException('Only the album owner generates texts');
    }
  }

  /** What a run would write, in one pass for the estimate and the start. */
  private async plan(albumId: string, { stopId, overwrite }: TripTextsEstimateQueryDto) {
    const stops = await this.tripTextsRepository.getStops(albumId, stopId);
    if (stopId && stops.length === 0) {
      throw new BadRequestException('Stop not found in the trip');
    }
    const stopPlans = [];
    for (const stop of stops) {
      const assets = await this.tripTextsRepository.getStopAssets(stop.id);
      stopPlans.push({ id: stop.id, assets: assets.length, ...planStopTexts(stop, assets, overwrite) });
    }
    const places = [];
    let ownArticles = 0;
    if (!stopId) {
      for (const placeId of await this.tripTextsRepository.getPlaceIds(albumId)) {
        const place = await this.tripTextsRepository.getPlace(placeId);
        if (!place || place.kind === TripKind.Plain || place.stops.length === 0) {
          continue;
        }
        if (isReplaceableText(place.article, place.articleSource, overwrite)) {
          places.push(place.id);
        }
        ownArticles += Number(!isReplaceableText(place.article, place.articleSource, false));
      }
    }
    const busy = stopPlans.filter((stop) => stop.calls > 0);
    return {
      stopIds: busy.map((stop) => stop.id),
      placeIds: places,
      estimate: {
        calls: busy.reduce((sum, stop) => sum + stop.calls, 0) + places.length,
        assets: busy.reduce((sum, stop) => sum + stop.assets, 0),
        stops: busy.length,
        places: places.length,
        ownTexts: stopPlans.reduce((sum, stop) => sum + stop.ownTexts, 0) + ownArticles,
      },
    };
  }

  async estimate(auth: AuthDto, albumId: string, dto: TripTextsEstimateQueryDto): Promise<TripTextsEstimateDto> {
    await this.requireOwner(auth, albumId);
    const { estimate } = await this.plan(albumId, dto);
    const problem = this.problemOf(await this.tripTextsRepository.getSettings(auth.user.id));
    return { ...estimate, problem };
  }

  /** Starts a run of the trip or one stop, replacing any run before it; places go after the stops. */
  async start(auth: AuthDto, albumId: string, dto: TripTextsStartDto): Promise<TripTextsProgressDto> {
    await this.requireOwner(auth, albumId);
    const problem = this.problemOf(await this.tripTextsRepository.getSettings(auth.user.id));
    if (problem) {
      throw new BadRequestException(PROBLEM_MESSAGES[problem]);
    }
    const { stopIds, placeIds } = await this.plan(albumId, dto);
    const taskIds = await this.tripTextsRepository.replaceTasks(albumId, stopIds, placeIds, dto.overwrite);
    await this.queueTasks(taskIds);
    await this.queuePlaces(albumId);
    return this.progress(albumId);
  }

  async getProgress(auth: AuthDto, albumId: string): Promise<TripTextsProgressDto> {
    await this.requireOwner(auth, albumId);
    return this.progress(albumId);
  }

  /** Sends the stops and places that failed after their retries again. */
  async retry(auth: AuthDto, albumId: string): Promise<TripTextsProgressDto> {
    await this.requireOwner(auth, albumId);
    await this.queueTasks(await this.tripTextsRepository.retryTasks(albumId));
    await this.queuePlaces(albumId);
    return this.progress(albumId);
  }

  private async progress(albumId: string): Promise<TripTextsProgressDto> {
    const tasks = await this.tripTextsRepository.getTasks(albumId);
    return {
      pending: tasks.filter((task) => task.error === null).length,
      failed: tasks.flatMap(({ error, ...task }) => (error === null ? [] : [{ ...task, error }])),
    };
  }

  private async queueTasks(ids: string[], delay?: number) {
    if (ids.length > 0) {
      await this.jobRepository.queueAll(ids.map((id) => ({ name: JobName.TripTexts, data: { id, delay } })));
    }
  }

  private async queuePlaces(albumId: string) {
    await this.queueTasks(await this.tripTextsRepository.takePlaceTasks(albumId));
  }

  /**
   * One stop or place of a run. A failure retries later with a growing delay, up to TRIP_TEXTS_ATTEMPTS, unless it is
   * a settings problem; then the task stays failed for "retry".
   */
  @OnJob({ name: JobName.TripTexts, queue: QueueName.BackgroundTask })
  async handleTexts({ id }: JobOf<JobName.TripTexts>): Promise<JobStatus> {
    const task = await this.tripTextsRepository.getTask(id);
    if (!task || task.error !== null) {
      return JobStatus.Skipped;
    }
    try {
      await (task.stopId
        ? this.generateStop(task.stopId, task.overwrite)
        : this.generatePlace(task.placeId!, task.overwrite));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const isRetryable = !(error instanceof TripTextsError) || error.isRetryable;
      if (isRetryable && task.attempt < TRIP_TEXTS_ATTEMPTS) {
        this.logger.warn(
          `Trip texts of ${task.stopId ? 'stop' : 'place'} failed (attempt ${task.attempt}): ${message}`,
        );
        await this.tripTextsRepository.setTaskAttempt(id, task.attempt + 1);
        await this.queueTasks([id], RETRY_DELAY_MS * 2 ** (task.attempt - 1));
        return JobStatus.Failed;
      }
      this.logger.error(`Trip texts of ${task.stopId ? 'stop' : 'place'} failed for good: ${message}`);
      await this.tripTextsRepository.failTask(id, message);
      await this.queuePlaces(task.albumId);
      return JobStatus.Failed;
    }
    await this.tripTextsRepository.finishTask(id);
    await this.queuePlaces(task.albumId);
    return JobStatus.Success;
  }

  /**
   * Writes a stop's title, story and captions, as travel-album's generate_stop: its assets go to the model in chunks,
   * the first writing title and story, each next one getting the previous captions. Every answer is checked before
   * anything is written, then all is written at once; a refused answer writes nothing.
   */
  async generateStop(stopId: string, overwrite: boolean): Promise<void> {
    const stop = await this.tripTextsRepository.getStop(stopId);
    if (!stop) {
      return;
    }
    const assets = await this.tripTextsRepository.getStopAssets(stopId);
    const { wantTitle, wantStory, captionIds, calls } = planStopTexts(stop, assets, overwrite);
    if (calls === 0) {
      return;
    }
    const config = await this.getConfig(stop.ownerId);
    const prompt = { ...stop, language: stop.language ?? this.defaultLanguage };

    let written: { title: string; story: string } | null = null;
    const captions = new Map<string, TripTextCaption>();
    let previous: typeof assets = [];
    for (let start = 0; start < assets.length; start += TRIP_TEXTS_CHUNK) {
      const chunk = assets.slice(start, start + TRIP_TEXTS_CHUNK);
      const frames = await Promise.all(
        chunk.map(async (asset) => {
          if (!asset.previewPath) {
            throw new TripTextsError(`Asset ${asset.id} has no preview yet`);
          }
          const data = await StorageService.backendFor(asset.previewPath).readAll(asset.previewPath);
          return { ...asset, image: { data, mimeType: mimeTypeOf(asset.previewPath) } };
        }),
      );
      const request = stopRequest(
        prompt,
        frames,
        previous.map((asset) => ({ ...asset, ...captions.get(asset.id)! })),
        written,
      );
      const answer = checkStopAnswer(await completeTripText(config, request), chunk.length);
      written ??= { title: answer.title, story: answer.story };
      for (const [index, asset] of chunk.entries()) {
        captions.set(asset.id, answer.captions[index]);
      }
      previous = chunk;
    }

    const changed = await this.tripTextsRepository.writeStop({
      stopId: stop.id,
      albumId: stop.albumId,
      ownerId: stop.ownerId,
      overwrite,
      title: wantTitle ? written!.title : null,
      story: wantStory ? written!.story : null,
      captions: captionIds.flatMap((assetId) => {
        const { caption, long } = captions.get(assetId)!;
        return caption || long ? [{ assetId, text: joinCaption(caption, long) }] : [];
      }),
    });
    // The description goes to the XMP sidecar, as Immich's own edit sends it (AssetService.updateExif).
    if (changed.length > 0) {
      await this.jobRepository.queueAll(changed.map((id) => ({ name: JobName.SidecarWrite, data: { id } })));
    }
  }

  /**
   * Writes a place's article from the titles and stories of its stops, as travel-album's generate_place; a trip without
   * a map has no articles.
   */
  async generatePlace(placeId: string, overwrite: boolean): Promise<void> {
    const place = await this.tripTextsRepository.getPlace(placeId);
    if (
      !place ||
      place.kind === TripKind.Plain ||
      !isReplaceableText(place.article, place.articleSource, overwrite) ||
      place.stops.length === 0
    ) {
      return;
    }
    const config = await this.getConfig(place.ownerId);
    const request = placeRequest({ ...place, language: place.language ?? this.defaultLanguage }, place.stops);
    const article = checkPlaceAnswer(await completeTripText(config, request));
    if (article) {
      await this.tripTextsRepository.writePlace(place.id, place.albumId, article, overwrite);
    }
  }
}
