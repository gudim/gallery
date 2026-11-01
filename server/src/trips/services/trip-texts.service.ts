import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import type { TripTextSeen } from 'src/trips/schema/tables/trip-text-task.table.js';
import type { JobOf } from 'src/types.js';
import { OnJob } from 'src/decorators.js';
import { JobName, JobStatus, QueueName } from 'src/enum.js';
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
import { requireAlbumOwner } from 'src/trips/utils/access.js';
import { TripLlmConfig, completeTripText } from 'src/trips/utils/llm-client.js';
import {
  TripLlmKeyState,
  decryptLlmKey,
  nextLlmKeyCipher,
  resolveLlmSecret,
  tripLlmKeyState,
} from 'src/trips/utils/llm-key.js';
import { llmUrlRefusal } from 'src/trips/utils/llm-url.js';
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

type TripTextTask = { id: string; placeId: string | null; overwrite: boolean; seen: TripTextSeen | null };
type TripLlmSettings = NonNullable<Awaited<ReturnType<TripTextsRepository['getSettings']>>>;

/** A trip without a map has no articles, and a place without stops has nothing to write one from. */
const hasArticle = (place: { kind: TripKind; stops: unknown[] }) =>
  place.kind !== TripKind.Plain && place.stops.length > 0;

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
    const refusal = await llmUrlRefusal(dto.url);
    if (refusal) {
      throw new BadRequestException(refusal);
    }
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

  private problemOf(settings: TripLlmSettings | undefined) {
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
    return { url: settings.url, model: settings.model, key };
  }

  // Only the album owner generates texts, with their own settings (trips DECISIONS-LOG 2026-11-01); a reader who is
  // not the owner gets 403, anyone else 404, as for a missing album.
  private async requireOwner(auth: AuthDto, albumId: string) {
    await requireAlbumOwner(this.accessRepository, auth, albumId, 'Only the album owner generates texts');
    if (!(await this.tripTextsRepository.hasTrip(albumId))) {
      throw new NotFoundException('Trip not found');
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
      const seen = overwrite
        ? {
            title: stop.title,
            story: stop.story,
            captions: Object.fromEntries(assets.map((asset) => [asset.id, asset.description])),
          }
        : null;
      stopPlans.push({ id: stop.id, seen, assets: assets.length, ...planStopTexts(stop, assets, overwrite) });
    }
    const places = [];
    let ownArticles = 0;
    if (!stopId) {
      for (const placeId of await this.tripTextsRepository.getPlaceIds(albumId)) {
        const place = await this.tripTextsRepository.getPlace(placeId);
        if (!place || !hasArticle(place)) {
          continue;
        }
        if (isReplaceableText(place.article, place.articleSource, overwrite)) {
          places.push({ id: place.id, seen: overwrite ? { article: place.article } : null });
        }
        ownArticles += Number(!isReplaceableText(place.article, place.articleSource, false));
      }
    }
    const busy = stopPlans.filter((stop) => stop.calls > 0);
    return {
      stops: busy.map(({ id, seen }) => ({ id, seen })),
      places,
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
    const { stops, places } = await this.plan(albumId, dto);
    const taskIds = await this.tripTextsRepository.replaceTasks(albumId, stops, places, dto.overwrite);
    await this.queueTasks(taskIds);
    await this.queuePlaces(albumId);
    return this.progress(albumId);
  }

  async getProgress(auth: AuthDto, albumId: string): Promise<TripTextsProgressDto> {
    await this.requireOwner(auth, albumId);
    // A stop deleted while its task waited takes the task along, and no job then queues the places; the window asks
    // for the progress every few seconds, so it queues them here.
    await this.queuePlaces(albumId);
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
    const target = task.stopId ? 'stop' : 'place';
    try {
      await (task.stopId ? this.generateStop({ ...task, stopId: task.stopId }) : this.generatePlace(task));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const detail = error instanceof TripTextsError && error.detail ? ` (${error.detail})` : '';
      const isRetryable = !(error instanceof TripTextsError) || error.isRetryable;
      if (isRetryable && task.attempt < TRIP_TEXTS_ATTEMPTS) {
        this.logger.warn(`Trip texts of ${target} failed (attempt ${task.attempt}): ${message}${detail}`);
        if (await this.queueAttempt(id, task.attempt + 1)) {
          return JobStatus.Failed;
        }
      }
      this.logger.error(`Trip texts of ${target} failed for good: ${message}${detail}`);
      await this.tripTextsRepository.failTask(id, message);
      await this.queuePlaces(task.albumId);
      return JobStatus.Failed;
    }
    await this.tripTextsRepository.finishTask(id);
    await this.queuePlaces(task.albumId);
    return JobStatus.Success;
  }

  /**
   * Queues the task's next attempt after a growing delay. A task left pending without a job would hold the run's
   * places for good, so when the queue refuses it the task fails instead, for "retry"; a worker that dies before
   * the job ends gets it again from BullMQ as a stalled job.
   */
  private async queueAttempt(id: string, attempt: number) {
    try {
      await this.tripTextsRepository.setTaskAttempt(id, attempt);
      await this.queueTasks([id], RETRY_DELAY_MS * 2 ** (attempt - 2));
      return true;
    } catch (error) {
      this.logger.error(`Trip texts: could not queue attempt ${attempt} of task ${id}: ${error}`);
      return false;
    }
  }

  /**
   * Writes a stop's title, story and captions, as travel-album's generate_stop: its assets go to the model in chunks,
   * the first writing title and story, each next one getting the previous captions. Every answer is checked before
   * anything is written, then all is written at once; a refused answer writes nothing, and so does a task that a newer
   * run replaced meanwhile.
   */
  async generateStop({ id: taskId, stopId, overwrite, seen }: TripTextTask & { stopId: string }): Promise<void> {
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
    let answered: typeof assets = [];
    for (let start = 0; start < assets.length; start += TRIP_TEXTS_CHUNK) {
      const chunk = assets.slice(start, start + TRIP_TEXTS_CHUNK);
      const frames = await Promise.all(
        chunk.map(async (asset) => {
          const data = await StorageService.backendFor(asset.previewPath).readAll(asset.previewPath);
          return { ...asset, image: { data, mimeType: mimeTypeOf(asset.previewPath) } };
        }),
      );
      const request = stopRequest(
        prompt,
        frames,
        answered.map((asset) => ({ ...asset, ...captions.get(asset.id)! })),
        written,
      );
      const answer = checkStopAnswer(await completeTripText(config, request), chunk.length);
      written ??= { title: answer.title, story: answer.story };
      for (const [index, asset] of chunk.entries()) {
        captions.set(asset.id, answer.captions[index]);
      }
      answered = chunk;
    }

    // What the run read when it started; an asset added since was not read, so only an empty or generated caption of
    // it is replaced.
    const read = seen ?? { title: stop.title, story: stop.story };
    const descriptions = seen
      ? new Map(Object.entries(seen.captions ?? {}))
      : new Map(assets.map((asset) => [asset.id, asset.description]));
    const changed = await this.tripTextsRepository.writeStop({
      taskId,
      stopId: stop.id,
      albumId: stop.albumId,
      ownerId: stop.ownerId,
      overwrite,
      title: wantTitle ? { text: written!.title, seen: read.title ?? null } : null,
      story: wantStory ? { text: written!.story, seen: read.story ?? null } : null,
      captions: captionIds.flatMap((assetId) => {
        const { caption, long } = captions.get(assetId)!;
        const seen = descriptions.get(assetId) ?? null;
        return caption || long ? [{ assetId, text: joinCaption(caption, long), seen }] : [];
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
  async generatePlace({ id: taskId, placeId, overwrite, seen }: TripTextTask): Promise<void> {
    if (!placeId) {
      return;
    }
    const place = await this.tripTextsRepository.getPlace(placeId);
    if (!place || !hasArticle(place) || !isReplaceableText(place.article, place.articleSource, overwrite)) {
      return;
    }
    const config = await this.getConfig(place.ownerId);
    const request = placeRequest({ ...place, language: place.language ?? this.defaultLanguage }, place.stops);
    const article = checkPlaceAnswer(await completeTripText(config, request));
    if (article) {
      await this.tripTextsRepository.writePlace({
        taskId,
        placeId: place.id,
        albumId: place.albumId,
        overwrite,
        article: { text: article, seen: seen ? (seen.article ?? null) : place.article },
      });
    }
  }
}
