<script lang="ts">
  import type { TripLikes } from '$lib/trips/trip-likes.svelte';
  import type { TripPhoto } from '$lib/trips/trip-view';
  import { getAssetMediaUrl } from '$lib/utils';
  import { AssetMediaSize } from '@immich/sdk';

  // One asset in a trip grid (travel-album map.js cellFor): a square thumbnail, its time, ▶ for a video, ♥ likes.

  interface Props {
    photo: TripPhoto;
    likes: TripLikes;
    label: string;
    showTime?: boolean;
    onOpen: (photo: TripPhoto) => void;
  }

  let { photo, likes, label, showTime = true, onOpen }: Props = $props();

  let loaded = $state(false);
  const like = $derived(likes.get(photo.id));
</script>

<button type="button" class="trip-cell" data-asset-id={photo.id} aria-label={label} onclick={() => onOpen(photo)}>
  <img
    class:loaded
    src={getAssetMediaUrl({ id: photo.id, size: AssetMediaSize.Thumbnail, cacheKey: photo.asset.thumbhash })}
    alt=""
    loading="lazy"
    onload={() => (loaded = true)}
  />
  {#if showTime && photo.time}
    <span class="tag">{photo.time}{photo.isInferred ? ' ~' : ''}</span>
  {/if}
  {#if photo.isVideo}
    <span class="vid">▶</span>
  {/if}
  {#if like.count > 0}
    <span class="likes">♥ {like.count}</span>
  {/if}
</button>

<style>
  .trip-cell {
    position: relative;
    aspect-ratio: 1;
    overflow: hidden;
    border: 0;
    padding: 0;
    border-radius: 4px;
    cursor: pointer;
    background: var(--trip-sunk);
    display: block;
    width: 100%;
  }
  img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    display: block;
    transition:
      transform 0.25s,
      opacity 0.2s;
    opacity: 0;
  }
  img.loaded {
    opacity: 1;
  }
  .trip-cell:hover img {
    transform: scale(1.07);
  }
  .tag {
    position: absolute;
    left: 4px;
    bottom: 3px;
    font-size: 12px;
    line-height: 1.2;
    color: #fff;
    text-shadow:
      0 1px 4px #000,
      0 0 2px #000;
    font-variant-numeric: tabular-nums;
    pointer-events: none;
  }
  .vid {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 26px;
    color: #fff;
    text-shadow: 0 2px 10px #000;
    pointer-events: none;
  }
  .likes {
    position: absolute;
    right: 4px;
    top: 4px;
    font-size: 12px;
    line-height: 1;
    color: #fff;
    background: rgba(0, 0, 0, 0.45);
    border-radius: 8px;
    padding: 3px 6px;
    pointer-events: none;
  }
</style>
