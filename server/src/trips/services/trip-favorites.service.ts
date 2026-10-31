import { Injectable } from '@nestjs/common';
import type { ArgOf } from 'src/repositories/event.repository.js';
import type { JobOf } from 'src/types.js';
import { OnEvent, OnJob } from 'src/decorators.js';
import { JobName, JobStatus, QueueName } from 'src/enum.js';
import { AssetFavoriteRepository } from 'src/repositories/asset-favorite.repository.js';
import { JobRepository } from 'src/repositories/job.repository.js';
import { TripFavoritesRepository } from 'src/trips/repositories/trip-favorites.repository.js';
import { resolveTripNamingLanguages } from 'src/trips/utils/naming.js';

// Gallery's own `favorites` string in its ten maintained locales (i18n/<locale>.json), keyed by language tag.
const ALBUM_NAMES: Record<string, string> = {
  en: 'Favorites',
  ru: 'Избранное',
  de: 'Favoriten',
  fr: 'Favoris',
  it: 'Preferiti',
  nl: 'Favorieten',
  pl: 'Ulubione',
  es: 'Favoritos',
  'zh-Hans': '收藏夹',
  'zh-Hant': '收藏',
};

/** The name of a new Favorites album in a language tag: the tag's own, else its language's, else English. */
export const favoritesAlbumName = (language: string) =>
  ALBUM_NAMES[language] ?? ALBUM_NAMES[language.split('-', 1)[0]] ?? ALBUM_NAMES.en;

/**
 * The Favorites trip mirrors its owner's stars (trips PLAN D15): a star or an unstar by hand queues mirroring, and the
 * first star makes the trip; adding to its album stars, removing from it unstars.
 */
@Injectable()
export class TripFavoritesService {
  constructor(
    private jobRepository: JobRepository,
    private tripFavoritesRepository: TripFavoritesRepository,
    private assetFavoriteRepository: AssetFavoriteRepository,
  ) {}

  // The server keeps no user locale, so a new Favorites trip takes the instance's first naming language (trips
  // DECISIONS-LOG 2026-10-31, owner).
  private readonly language = resolveTripNamingLanguages()[0];

  @OnEvent({ name: 'AssetFavoritesUpdate' })
  async onAssetFavoritesUpdate({ userId, isFavorite }: ArgOf<'AssetFavoritesUpdate'>) {
    await this.jobRepository.queue({ name: JobName.TripFavorites, data: { id: userId, canCreate: isFavorite } });
  }

  // Adding to the Favorites trip's album stars the asset for its owner, removing unstars it (trips GLOSSARY).
  @OnEvent({ name: 'AlbumAssetsAdd' })
  async onAlbumAssetsAdd({ albumId, assetIds }: ArgOf<'AlbumAssetsAdd'>) {
    const ownerId = await this.tripFavoritesRepository.getFavoritesOwnerId(albumId);
    if (ownerId) {
      await this.assetFavoriteRepository.addAll(ownerId, assetIds);
    }
  }

  @OnEvent({ name: 'AlbumAssetsRemove' })
  async onAlbumAssetsRemove({ albumId, assetIds }: ArgOf<'AlbumAssetsRemove'>) {
    const ownerId = await this.tripFavoritesRepository.getFavoritesOwnerId(albumId);
    if (ownerId) {
      await this.assetFavoriteRepository.removeAll(ownerId, assetIds);
    }
  }

  @OnJob({ name: JobName.TripFavorites, queue: QueueName.BackgroundTask })
  async handleMirror({ id, canCreate }: JobOf<JobName.TripFavorites>): Promise<JobStatus> {
    const newTrip = canCreate ? { albumName: favoritesAlbumName(this.language), language: this.language } : null;
    const { albumId, stops } = await this.tripFavoritesRepository.mirror(id, newTrip);
    if (!albumId) {
      return JobStatus.Skipped;
    }
    if (stops > 0) {
      await this.jobRepository.queue({ name: JobName.TripName, data: { id: albumId } });
    }
    return JobStatus.Success;
  }
}
