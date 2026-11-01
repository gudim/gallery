import { Injectable } from '@nestjs/common';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import { JobName } from 'src/enum.js';
import { JobRepository } from 'src/repositories/job.repository.js';
import { StorageService } from 'src/services/storage.service.js';
import { TripLlmSettingsResponseDto, TripLlmSettingsUpdateDto } from 'src/trips/dtos/trip-texts.dto.js';
import { TripKind } from 'src/trips/enum.js';
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
  isReplaceableCaption,
  isReplaceableText,
  joinCaption,
  placeRequest,
  stopRequest,
} from 'src/trips/utils/texts.js';

const mimeTypeOf = (path: string) => (/\.webp$/i.test(path) ? 'image/webp' : 'image/jpeg');

// LLM texts of trips (trips PLAN §2.6).
@Injectable()
export class TripTextsService {
  private readonly secret = resolveLlmSecret();
  private readonly userAgent = process.env[TRIPS_USER_AGENT_VARIABLE]?.trim() || defaultTripGeoUserAgent();
  private readonly defaultLanguage = resolveTripNamingLanguages()[0];

  constructor(
    private jobRepository: JobRepository,
    private tripTextsRepository: TripTextsRepository,
  ) {}

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

  /** The user's server, or why generation is off; a settings problem is never retried. */
  private async getConfig(userId: string): Promise<TripLlmConfig> {
    const settings = await this.tripTextsRepository.getSettings(userId);
    if (!settings) {
      throw new TripTextsError('No LLM settings', false);
    }
    if (!settings.allowUpload) {
      throw new TripTextsError('Sending photos to the LLM server is not allowed in the settings', false);
    }
    const state = tripLlmKeyState(settings.keyCipher, this.secret);
    if (state === TripLlmKeyState.Unreadable) {
      throw new TripTextsError('The saved LLM key cannot be read: TRIPS_LLM_SECRET is missing or changed', false);
    }
    const key = state === TripLlmKeyState.Set ? decryptLlmKey(settings.keyCipher!, this.secret!) : null;
    return { url: settings.url, model: settings.model, key, userAgent: this.userAgent };
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
    const wantTitle = !stop.isAtCenter && isReplaceableText(stop.title, stop.titleSource, overwrite);
    const wantStory = isReplaceableText(stop.story, stop.storySource, overwrite);
    const wanted = new Set(
      assets
        .filter(
          (asset) =>
            asset.ownerId === stop.ownerId &&
            isReplaceableCaption(asset.description, asset.generatedCaption, overwrite),
        )
        .map((asset) => asset.id),
    );
    if (assets.length === 0 || !(wantTitle || wantStory || wanted.size > 0)) {
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
      captions: [...wanted].flatMap((assetId) => {
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
