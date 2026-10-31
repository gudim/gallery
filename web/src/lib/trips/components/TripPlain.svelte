<script lang="ts">
  import TripTile from '$lib/trips/components/TripTile.svelte';
  import type { TripLikes } from '$lib/trips/trip-likes.svelte';
  import { dateRange, itemTitle } from '$lib/trips/trip-text';
  import type { TripPhoto, TripView } from '$lib/trips/trip-view';
  import type { Snippet } from 'svelte';
  import { locale, t } from 'svelte-i18n';

  // A Plain trip (travel-album static/viewer/plain.js): no map, a section per stop with its story and assets.

  interface Props {
    view: TripView;
    title: string;
    likes: TripLikes;
    onOpenPhoto: (photo: TripPhoto) => void;
    tools: Snippet;
  }

  let { view, title, likes, onOpenPhoto, tools }: Props = $props();

  const lang = $derived($locale ?? 'en');
  const sections = $derived(view.stops.filter(({ photos }) => photos.length > 0));
  const days = $derived(new Set(view.photos.map(({ date }) => date).filter(Boolean)).size);
  const frames = (count: number) => $t('trips_assets_count', { values: { count } });

  const when = (photos: TripPhoto[]) =>
    dateRange(
      photos.map(({ date }) => date),
      lang,
    ) || $t('trips_no_date');
</script>

<div class="trip-plain" data-testid="trip-plain">
  <header class="head">
    <div class="tools">{@render tools()}</div>
    <h1>{title}</h1>
    <div class="sub">
      {$t('trips_days_count', { values: { count: days } })}<span class="sep">·</span>{frames(view.photos.length)}
    </div>
  </header>
  <main class="feed">
    {#each sections as section (section.id)}
      {@const heading = itemTitle(section, view, $t, lang)}
      {@const date = when(section.photos)}
      <section data-section={section.id}>
        <h2>{heading}</h2>
        <div class="meta">
          {heading === date ? frames(section.photos.length) : `${date} · ${frames(section.photos.length)}`}
        </div>
        {#if section.story}<p class="story">{section.story}</p>{/if}
        <div class="grid">
          {#each section.photos as photo, index (photo.id)}
            <TripTile
              {photo}
              {likes}
              showTime={false}
              label={$t('trips_frame_of', {
                values: { title: heading, index: index + 1, count: section.photos.length },
              })}
              onOpen={onOpenPhoto}
            />
          {/each}
        </div>
      </section>
    {/each}
  </main>
</div>

<style>
  .trip-plain {
    min-height: 100dvh;
    background: var(--trip-bg);
  }
  .head {
    position: relative;
    text-align: center;
    padding: 30px 70px 10px;
  }
  .tools {
    position: absolute;
    top: 12px;
    right: 12px;
    display: flex;
    gap: 6px;
  }
  h1 {
    margin: 0;
    font-size: 28px;
    font-weight: 650;
  }
  .sub {
    color: var(--trip-muted);
    font-size: 14px;
    margin-top: 6px;
  }
  .sep {
    opacity: 0.45;
    margin: 0 7px;
  }
  .feed {
    max-width: 1100px;
    margin: 0 auto;
    padding: 10px 20px 60px;
  }
  section {
    margin-top: 28px;
  }
  h2 {
    margin: 0;
    font-size: 20px;
    font-weight: 650;
  }
  .meta {
    color: var(--trip-muted);
    font-size: 13px;
    margin-top: 3px;
  }
  .story {
    color: var(--trip-read);
    font-size: 15px;
    line-height: 1.65;
    white-space: pre-line;
    margin: 10px 0 0;
    max-width: 82ch;
  }
  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
    gap: 5px;
    margin-top: 12px;
  }
  @media (max-width: 820px) {
    .head {
      padding: 64px 16px 6px;
    }
    h1 {
      font-size: 21px;
    }
    .feed {
      padding: 6px 8px 40px;
    }
    .grid {
      grid-template-columns: repeat(auto-fill, minmax(104px, 1fr));
      gap: 3px;
    }
  }
</style>
