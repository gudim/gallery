import { likeAsset, unlikeAsset } from '@immich/sdk';
import { SvelteMap } from 'svelte/reactivity';
import { authManager } from '$lib/managers/auth-manager.svelte';
import type { TripView } from '$lib/trips/trip-view';

type Like = { count: number; isLiked: boolean; isBusy: boolean };

/**
 * Likes of a trip's assets (travel-album static/viewer/likes.js): a toggle answers at once and takes the server's
 * numbers when they come, or goes back when the request fails.
 */
export class TripLikes {
  #likes = new SvelteMap<string, Like>();

  constructor(private view: TripView) {
    for (const photo of view.photos) {
      this.#likes.set(photo.id, { count: photo.likes, isLiked: photo.isLiked, isBusy: false });
    }
  }

  get(assetId: string): Like {
    return this.#likes.get(assetId) ?? { count: 0, isLiked: false, isBusy: false };
  }

  async toggle(assetId: string) {
    const before = this.get(assetId);
    if (before.isBusy) {
      return;
    }
    const isLiked = !before.isLiked;
    this.#likes.set(assetId, { count: Math.max(0, before.count + (isLiked ? 1 : -1)), isLiked, isBusy: true });
    try {
      const request = { id: this.view.albumId, assetId, ...authManager.params };
      const result = await (isLiked ? likeAsset(request) : unlikeAsset(request));
      this.#likes.set(assetId, { count: result.count, isLiked: result.isLiked, isBusy: false });
    } catch {
      this.#likes.set(assetId, { ...before, isBusy: false });
    }
  }
}
