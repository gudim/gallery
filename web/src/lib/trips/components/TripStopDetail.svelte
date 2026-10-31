<script lang="ts">
  import TripTile from '$lib/trips/components/TripTile.svelte';
  import type { TripLikes } from '$lib/trips/trip-likes.svelte';
  import { dateRange, dayLabel, itemTitle, yearSpan } from '$lib/trips/trip-text';
  import { timeSpan, type TripItem, type TripPhoto, type TripView } from '$lib/trips/trip-view';
  import { TripKind } from '@immich/sdk';
  import { locale, t } from 'svelte-i18n';

  // An opened stop (travel-album map.js openStop): back, its title and meta, story, the place's article and its assets.

  interface Props {
    item: TripItem;
    view: TripView;
    likes: TripLikes;
    narrow: boolean;
    isWide: boolean;
    onBack: () => void;
    onToggleWide: () => void;
    onOpenPhoto: (photo: TripPhoto) => void;
  }

  let { item, view, likes, narrow, isWide, onBack, onToggleWide, onOpenPhoto }: Props = $props();

  const lang = $derived($locale ?? 'en');
  const isPlaces = $derived(view.kind === TripKind.Places);
  const frames = (count: number) => $t('trips_assets_count', { values: { count } });
  const title = $derived(itemTitle(item, view, $t, lang));

  const meta = $derived.by(() => {
    if (item.type === 'unplaced') {
      return [frames(item.photos.length)];
    }
    const parts: string[] = [];
    if (isPlaces) {
      parts.push(yearSpan(item.photos), frames(item.photos.length));
    } else {
      parts.push(dayLabel(view.days[item.day]?.date ?? '', lang));
      if (item.type === 'transit') {
        parts.push($t('trips_on_the_way'));
      }
      if (item.photos.length > 0) {
        parts.push(timeSpan(item), frames(item.photos.length));
      } else {
        parts.push($t('trips_no_shots'));
      }
    }
    if (item.videoCount > 0) {
      parts.push($t('trips_videos_count', { values: { count: item.videoCount } }));
    }
    if (item.type === 'stop' && view.isMultiCountry && item.country) {
      parts.push(item.country);
    }
    return parts.filter(Boolean);
  });

  const empty = $derived.by(() => {
    if (item.type === 'stop' && isPlaces) {
      return item.stop.role ? $t('trips_empty_center') : $t('trips_empty_place');
    }
    return $t('trips_empty_stop');
  });

  /** Places: a new visit starts after a gap of more than a day, or where dated and undated assets meet. */
  const visits = $derived.by(() => {
    const groups: TripPhoto[][] = [];
    let last: TripPhoto | undefined;
    for (const photo of item.photos) {
      const gap = last ? Date.parse(photo.asset.localDateTime) - Date.parse(last.asset.localDateTime) : 0;
      if (!last || gap > 24 * 3600 * 1000 || Boolean(photo.date) !== Boolean(last.date)) {
        groups.push([]);
      }
      groups.at(-1)!.push(photo);
      last = photo;
    }
    return groups;
  });
  const visitLabel = (photos: TripPhoto[]) =>
    `${
      dateRange(
        photos.map(({ date }) => date),
        lang,
      ) || $t('trips_no_date')
    } · ${frames(photos.length)}`;
</script>

{#snippet tile(photo: TripPhoto)}
  <TripTile
    {photo}
    {likes}
    showTime={!narrow}
    label={$t('trips_frame_of', {
      values: { title, index: item.photos.indexOf(photo) + 1, count: item.photos.length },
    })}
    onOpen={onOpenPhoto}
  />
{/snippet}

<section class="detail" class:narrow class:wide={isWide} data-testid="trip-detail">
  <div class="dhdr">
    <div class="dtop">
      <button type="button" class="back" onclick={onBack}
        >{isPlaces ? $t('trips_back_places') : $t('trips_back_route')}</button
      >
      {#if !narrow && item.photos.length > 0}
        <button type="button" class="widebtn" onclick={onToggleWide}
          >{isWide ? $t('trips_wide_off') : $t('trips_wide')}</button
        >
      {/if}
    </div>
    <h2>{title}</h2>
    <div class="meta">
      {#each meta as part, index (index)}
        {#if index > 0}<span class="sep">·</span>{/if}<span>{part}</span>
      {/each}
      {#if item.type === 'stop' && item.latitude !== null && item.longitude !== null}
        <span class="sep">·</span>
        <a
          href="https://www.openstreetmap.org/?mlat={item.latitude}&mlon={item.longitude}#map=15/{item.latitude}/{item.longitude}"
          target="_blank"
          rel="noopener noreferrer"
          class="coords">{item.latitude.toFixed(4)}, {item.longitude.toFixed(4)}</a
        >
      {/if}
    </div>
  </div>
  <div class="scroll">
    {#if item.type === 'unplaced'}
      <p class="story">{$t('trips_unplaced_note')}</p>
    {:else if item.type === 'stop' && item.story}
      <p class="story">{item.story}</p>
    {/if}
    {#if item.type === 'stop' && item.article}
      <div class="region">
        <details>
          <summary>{$t('trips_about_place')}</summary>
          {#each item.article.split(/\n\s*\n/) as paragraph, index (index)}
            <p>{paragraph}</p>
          {/each}
        </details>
      </div>
    {/if}
    {#if item.photos.length === 0}
      <div class="empty grid">{empty}</div>
    {:else if isPlaces}
      <div class="grid">
        {#each visits as visit, visitIndex (visitIndex)}
          <div class="visit">{visitLabel(visit)}</div>
          {#each visit as photo (photo.id)}
            {@render tile(photo)}
          {/each}
        {/each}
      </div>
    {:else}
      <div class="grid">
        {#each item.photos as photo (photo.id)}
          {@render tile(photo)}
        {/each}
      </div>
    {/if}
  </div>
</section>

<style>
  .detail {
    position: absolute;
    inset: 0;
    background: var(--trip-panel);
    display: flex;
    flex-direction: column;
    z-index: 5;
  }
  .detail.narrow {
    position: fixed;
    z-index: 30;
  }
  .scroll {
    overflow-y: auto;
    overflow-x: hidden;
    flex: 1;
    min-height: 0;
    scrollbar-width: thin;
    scrollbar-color: var(--trip-scroll) transparent;
  }
  .dhdr {
    padding: 16px 20px;
    border-bottom: 1px solid var(--trip-line);
  }
  .dtop {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    margin-bottom: 10px;
  }
  .back {
    background: none;
    border: 0;
    color: var(--trip-accent-ink);
    font: inherit;
    font-size: 13px;
    cursor: pointer;
    padding: 0;
  }
  .narrow .back {
    min-height: 44px;
    font-size: 15px;
  }
  .back:hover {
    text-decoration: underline;
  }
  .widebtn {
    background: none;
    border: 1px solid var(--trip-line);
    border-radius: 6px;
    color: var(--trip-muted);
    font: inherit;
    font-size: 12px;
    padding: 4px 9px;
    cursor: pointer;
    white-space: nowrap;
  }
  .widebtn:hover {
    color: var(--trip-text);
  }
  h2 {
    margin: 0 0 5px;
    font-size: 19px;
    font-weight: 650;
    letter-spacing: -0.2px;
  }
  .meta {
    color: var(--trip-muted);
    font-size: 12.5px;
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
    align-items: center;
  }
  .meta .sep {
    opacity: 0.4;
  }
  .coords {
    color: var(--trip-muted);
    text-decoration: underline;
  }
  .story {
    padding: 16px 20px;
    margin: 0;
    color: var(--trip-read);
    font-size: 14px;
    line-height: 1.65;
    white-space: pre-line;
  }
  .region {
    padding: 0 20px 14px;
    border-bottom: 1px solid var(--trip-line);
    max-height: 30vh;
    overflow-y: auto;
  }
  .region summary {
    cursor: pointer;
    color: var(--trip-accent-ink);
    font-size: 13px;
    list-style: none;
    padding: 4px 0;
  }
  .region summary::-webkit-details-marker {
    display: none;
  }
  .region summary::before {
    content: '▸ ';
  }
  .region details[open] summary::before {
    content: '▾ ';
  }
  .region p {
    margin: 8px 0 0;
    color: var(--trip-read);
    font-size: 13.5px;
    line-height: 1.62;
  }
  .grid {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 4px;
    padding: 12px;
  }
  .narrow .grid {
    grid-template-columns: repeat(auto-fill, minmax(104px, 1fr));
  }
  .wide .grid {
    grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
    gap: 5px;
    padding: 14px;
  }
  .wide .story,
  .wide .region p {
    max-width: 82ch;
  }
  .grid.empty {
    display: block;
    padding: 18px 20px;
    color: var(--trip-muted);
    font-size: 13px;
  }
  .visit {
    grid-column: 1 / -1;
    font-size: 12px;
    color: var(--trip-muted);
    padding: 8px 2px 2px;
  }
</style>
