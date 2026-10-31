<script lang="ts" module>
  export type RoadView = 'road' | 'list' | 'grid' | 'map';
</script>

<script lang="ts">
  import TripFinale from '$lib/trips/components/TripFinale.svelte';
  import TripMap from '$lib/trips/components/TripMap.svelte';
  import TripStopDetail from '$lib/trips/components/TripStopDetail.svelte';
  import TripTile from '$lib/trips/components/TripTile.svelte';
  import type { TripLikes } from '$lib/trips/trip-likes.svelte';
  import { dayLabel, itemTitle } from '$lib/trips/trip-text';
  import { timeSpan, type TripItem, type TripPhoto, type TripView } from '$lib/trips/trip-view';
  import { getAssetMediaUrl } from '$lib/utils';
  import { AssetMediaSize } from '@immich/sdk';
  import { onMount, tick, type Snippet } from 'svelte';
  import { locale, t } from 'svelte-i18n';

  // The phone layout of a Route trip (travel-album static/viewer/road.js and views.js): the winding road with a
  // station per stop, a list, a grid and the map, under one sticky row of views. A station opens its assets.

  interface Props {
    view: TripView;
    title: string;
    likes: TripLikes;
    initialView: RoadView;
    initialStopId?: string;
    onView: (view: RoadView) => void;
    onOpenPhoto: (photo: TripPhoto) => void;
    tools: Snippet;
  }

  let { view, title, likes, initialView, initialStopId, onView, onOpenPhoto, tools }: Props = $props();

  const lang = $derived($locale ?? 'en');
  let current = $state<RoadView>(initialView);
  let openId = $state<string>();

  // The road's rhythm (travel-album road.js): a stop every STEP px at least, PAD above the first.
  const STEP = 268;
  const PAD = 130;
  const WAVE = 660;
  const DAY_GAP = 96;

  /** Stations: stops with assets, each followed by the assets shot on the way after it. */
  const stations = $derived(view.order.filter((item) => item.type !== 'unplaced'));
  const total = $derived(stations.reduce((sum, item) => sum + item.photos.length, 0));
  const frames = (count: number) => $t('trips_assets_count', { values: { count } });
  const sub = $derived([
    $t('trips_days_count', { values: { count: view.days.length } }),
    $t('trips_stops_count', { values: { count: view.stops.filter(({ photos }) => photos.length > 0).length } }),
    frames(total),
    $t('trips_km', { values: { km: view.km ?? 0 } }),
  ]);

  /** The first station of each day carries the day's badge. */
  const dayStarts = $derived(
    new Set(stations.flatMap((item, index) => (index === 0 || stations[index - 1].day !== item.day ? [index] : []))),
  );

  const seenPlaces = $derived.by(() => {
    return stations.map(
      (item, index) =>
        item.type === 'stop' &&
        !!item.placeId &&
        stations.slice(0, index).every((before) => !(before.type === 'stop' && before.placeId === item.placeId)),
    );
  });

  const meta = (item: TripItem) => {
    const parts = [timeSpan(item)];
    if (item.type === 'stop') {
      if (item.region) {
        parts.push(item.region);
      }
      if (view.isMultiCountry && item.country) {
        parts.push(item.country);
      }
    }
    return parts;
  };

  let road = $state<HTMLDivElement>();
  let width = $state(0);
  let height = $state(0);
  let ys = $state<number[]>([]);
  let progressT = $state(0);
  let donePath = $state<SVGPathElement>();
  let pathLength = $state(0);
  let me = $state({ x: 0, y: 0 });

  const roadX = (y: number) => width / 2 + Math.min(width * 0.26, 108) * Math.sin((y * 2 * Math.PI) / WAVE);

  /** Captions are as tall as their story, so every gap is measured; STEP is only the minimum. */
  const layout = async () => {
    await tick();
    if (!road) {
      return;
    }
    width = road.clientWidth;
    const elements = [...road.querySelectorAll<HTMLElement>('.stn')];
    const capHeight = (element: HTMLElement) => element.querySelector<HTMLElement>('.cap')?.offsetHeight ?? 0;
    const next: number[] = [];
    let y = PAD;
    for (const [index, element] of elements.entries()) {
      if (index > 0 && dayStarts.has(index)) {
        y += DAY_GAP;
      }
      next.push(y);
      y += element.classList.contains('way')
        ? Math.max(STEP / 2, 83 + capHeight(element))
        : Math.max(STEP, 134 + capHeight(element));
    }
    const last = elements.at(-1);
    height = last ? next.at(-1)! + 62 + capHeight(last) + DAY_GAP : 0;
    ys = next;
    await tick();
    pathLength = donePath?.getTotalLength() ?? 0;
    onScroll();
  };

  const roadPath = $derived.by(() => {
    let d = '';
    for (let y = 0; y <= height; y += 12) {
      d += `${d ? 'L' : 'M'}${roadX(y).toFixed(1)},${y} `;
    }
    return d;
  });

  const onScroll = () => {
    if (!road || !donePath || height === 0) {
      return;
    }
    const top = road.getBoundingClientRect().top + scrollY;
    progressT = Math.max(0, Math.min(1, (scrollY + innerHeight * 0.5 - top) / height));
    const point = donePath.getPointAtLength(pathLength * progressT);
    me = { x: point.x, y: point.y };
  };

  let frame = 0;
  const onWindowScroll = () => {
    if (frame) {
      return;
    }
    frame = requestAnimationFrame(() => {
      frame = 0;
      onScroll();
    });
  };

  // Captions slide in once, when they scroll into view.
  const reveal = (node: HTMLElement) => {
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) {
            continue;
          }

          entry.target.classList.add('in');
          observer.unobserve(entry.target);
        }
      },
      { rootMargin: '0px 0px -12% 0px' },
    );
    observer.observe(node);
    return { destroy: () => observer.disconnect() };
  };

  const setView = async (next: RoadView) => {
    current = next;
    openId = undefined;
    onView(next);
    scrollTo({ top: 0 });
    if (next === 'road') {
      await layout();
    }
  };

  const openStation = (item: TripItem) => {
    const photo = item.photos[0];
    if (photo) {
      onOpenPhoto(photo);
    }
  };

  const openItem = $derived(
    openId ? (view.order.find(({ id }) => id === openId) ?? view.stops.find(({ id }) => id === openId)) : undefined,
  );

  const thumb = (photo: TripPhoto) =>
    getAssetMediaUrl({ id: photo.id, size: AssetMediaSize.Thumbnail, cacheKey: photo.asset.thumbhash });

  const grouped = $derived(
    view.days.map((day, index) => ({
      ...day,
      index,
      label: dayLabel(day.date, lang),
      items: stations.filter((item) => item.day === index),
    })),
  );

  const views: { id: RoadView; label: string }[] = $derived([
    { id: 'road', label: $t('trips_view_road') },
    { id: 'list', label: $t('trips_view_list') },
    { id: 'grid', label: $t('trips_view_grid') },
    { id: 'map', label: $t('trips_view_map') },
  ]);

  onMount(() => {
    void layout().then(() => {
      if (initialStopId) {
        const index = stations.findIndex(
          (item) => item.id === initialStopId || (item.type === 'transit' && item.stopIds.includes(initialStopId)),
        );
        if (index !== -1 && current === 'road') {
          const top = (road?.getBoundingClientRect().top ?? 0) + scrollY + ys[index] - innerHeight * 0.3;
          scrollTo({ top });
        }
      }
    });
  });
</script>

<svelte:window onscroll={onWindowScroll} onresize={() => void layout()} />

<div
  class="trip-road"
  class:dense={current === 'list' || current === 'grid'}
  data-view={current}
  data-testid="trip-road"
>
  {#if current !== 'map'}
    <header class="head">
      <h1>{title}</h1>
      <div class="sub" data-testid="trip-sub">
        {#each sub as part, index (index)}{#if index > 0}<span class="sep">·</span>{/if}{part}{/each}
      </div>
      {#if current === 'road'}
        <div class="hint">{$t('trips_road_hint')}</div>
      {/if}
    </header>
  {/if}

  <nav class="vnav" class:floating={current === 'map'} aria-label={$t('trips_view_as')}>
    <div class="seg" role="tablist">
      {#each views as option (option.id)}
        <button
          type="button"
          role="tab"
          aria-selected={current === option.id}
          class:on={current === option.id}
          onclick={() => setView(option.id)}>{option.label}</button
        >
      {/each}
    </div>
    <div class="tools">{@render tools()}</div>
  </nav>

  {#if current === 'road'}
    <div class="road" bind:this={road} style:height="{height}px" data-testid="trip-road-strip">
      <svg class="svg" viewBox="0 0 {width} {height}" {width} {height} preserveAspectRatio="none" aria-hidden="true">
        <path class="edge" d={roadPath} />
        <path class="base" d={roadPath} />
        <path class="mid" d={roadPath} />
        <path
          class="done"
          d={roadPath}
          bind:this={donePath}
          style:stroke-dasharray={pathLength}
          style:stroke-dashoffset={pathLength * (1 - progressT)}
        />
        <circle class="me" r="9" cx={me.x} cy={me.y} />
      </svg>
      {#each stations as item, index (item.id)}
        {#if dayStarts.has(index) && view.days[item.day]}
          <div class="daymark" style:top="{(ys[index] ?? 0) - 104}px">
            <b
              ><span class="dot" style:background={view.days[item.day].color}></span>{dayLabel(
                view.days[item.day].date,
                lang,
              )} · {frames(view.days[item.day].count)}</b
            >
          </div>
        {/if}
        <div class="stn" class:way={item.type === 'transit'} style:top="{ys[index] ?? 0}px" data-stop-id={item.id}>
          <button
            type="button"
            class="pin"
            style:left="{roadX(ys[index] ?? 0)}px"
            aria-label="{itemTitle(item, view, $t, lang)}, {frames(item.photos.length)}"
            onclick={() => openStation(item)}
          >
            <img src={thumb(item.photos[0])} alt="" loading="lazy" decoding="async" />
            {#if item.type !== 'transit'}<span class="n">{item.photos.length}</span>{/if}
          </button>
          <div class="cap" use:reveal>
            {#if item.type === 'transit'}
              <button type="button" class="capbtn" onclick={() => openStation(item)}>
                <div class="meta">{$t('trips_on_the_way')}<span class="sep">·</span>{frames(item.photos.length)}</div>
              </button>
            {:else if item.type === 'stop'}
              <button type="button" class="capbtn" onclick={() => openStation(item)}>
                <h2>{item.title}</h2>
                <div class="meta">
                  {#each meta(item) as part, partIndex (partIndex)}{#if partIndex > 0}<span class="sep">·</span
                      >{/if}{part}{/each}
                </div>
                {#if item.story}<p class="story">{item.story}</p>{/if}
              </button>
              {#if item.article && seenPlaces[index]}
                <details class="rgn" ontoggle={() => void layout()}>
                  <summary>{$t('trips_about_place')}</summary>
                  {#each item.article.split(/\n\s*\n/) as paragraph, paragraphIndex (paragraphIndex)}
                    <p>{paragraph}</p>
                  {/each}
                </details>
              {/if}
            {/if}
          </div>
        </div>
      {/each}
    </div>
  {:else if current === 'list'}
    <div class="vlist">
      {#each grouped as day (day.date)}
        {#if day.items.length > 0}
          <div class="vday">
            <span class="dot" style:background={day.color}></span>{day.label}<span class="cnt"
              >{day.items.reduce((sum, item) => sum + item.photos.length, 0)}</span
            >
          </div>
          {#each day.items as item (item.id)}
            <button type="button" class="row" onclick={() => openStation(item)}>
              <img src={thumb(item.photos[0])} alt="" loading="lazy" />
              <span class="txt">
                <b>{itemTitle(item, view, $t, lang)}</b>
                <small>{meta(item).join(' · ')}</small>
              </span>
              <span class="cnt">{item.photos.length}</span>
            </button>
          {/each}
        {/if}
      {/each}
    </div>
  {:else if current === 'grid'}
    <div class="vgrid">
      {#each grouped as day (day.date)}
        {#if day.items.length > 0}
          <div class="vday">
            <span class="dot" style:background={day.color}></span>{day.label}<span class="cnt"
              >{day.items.reduce((sum, item) => sum + item.photos.length, 0)}</span
            >
          </div>
          {#each day.items as item (item.id)}
            {#each item.photos as photo, index (photo.id)}
              <TripTile
                {photo}
                {likes}
                showTime={false}
                label={$t('trips_frame_of', {
                  values: { title: itemTitle(item, view, $t, lang), index: index + 1, count: item.photos.length },
                })}
                onOpen={onOpenPhoto}
              />
            {/each}
          {/each}
        {/if}
      {/each}
    </div>
  {:else}
    <div class="fullmap">
      <TripMap
        {view}
        narrow
        topInset={62}
        selectedId={openId}
        onItem={(item) => (openId = item.id)}
        onPhoto={onOpenPhoto}
      />
    </div>
    {#if openItem}
      <TripStopDetail
        item={openItem}
        {view}
        {likes}
        narrow
        isWide={false}
        onBack={() => (openId = undefined)}
        onToggleWide={() => {}}
        {onOpenPhoto}
      />
    {/if}
  {/if}

  {#if current !== 'map'}
    <TripFinale {view} {title} silhouette={current === 'road'} onWholeRoute={() => setView('map')} />
  {/if}
</div>

<style>
  .trip-road {
    font:
      18px/1.55 -apple-system,
      BlinkMacSystemFont,
      'Segoe UI',
      Roboto,
      sans-serif;
    background: var(--trip-bg);
    min-height: 100dvh;
    overflow-x: hidden;
  }
  .head {
    padding: 22px 22px 4px;
    text-align: center;
  }
  h1 {
    margin: 0;
    font-size: 32px;
    letter-spacing: -0.02em;
    line-height: 1.2;
  }
  .sub {
    color: var(--trip-muted);
    font-size: 16px;
    margin-top: 9px;
  }
  .sep {
    opacity: 0.45;
    margin: 0 7px;
  }
  .hint {
    color: var(--trip-dim);
    font-size: 15px;
    margin-top: 10px;
  }
  .dense h1 {
    font-size: 21px;
  }
  .dense .sub {
    font-size: 13px;
  }
  .vnav {
    position: sticky;
    top: 0;
    z-index: 10;
    display: flex;
    gap: 8px;
    padding: 10px 14px;
    background: var(--trip-bg);
  }
  .vnav.floating {
    position: fixed;
    left: 0;
    right: 0;
    background: none;
  }
  .seg {
    flex: 1;
    display: flex;
    background: var(--trip-glass);
    border: 1px solid var(--trip-line);
    border-radius: 10px;
    padding: 3px;
    gap: 2px;
    backdrop-filter: blur(6px);
  }
  .seg button {
    flex: 1;
    min-height: 44px;
    border: 0;
    background: none;
    color: var(--trip-muted);
    font: inherit;
    font-size: 15px;
    border-radius: 7px;
    cursor: pointer;
  }
  .seg button.on {
    background: var(--trip-panel2);
    color: var(--trip-text);
  }
  .tools {
    display: flex;
    gap: 6px;
    align-items: center;
  }
  .road {
    position: relative;
    margin-top: 4px;
  }
  .svg {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    display: block;
  }
  .edge,
  .base,
  .mid,
  .done {
    fill: none;
    stroke-linecap: round;
    stroke-linejoin: round;
  }
  .edge {
    stroke: var(--trip-road-edge);
    stroke-width: 60;
  }
  .base {
    stroke: var(--trip-road-base);
    stroke-width: 56;
  }
  .mid {
    stroke: var(--trip-road-mid);
    stroke-width: 3;
    stroke-dasharray: 16 20;
  }
  .done {
    stroke: var(--trip-route);
    stroke-width: 5;
    opacity: 0.85;
  }
  .me {
    fill: var(--trip-road-me);
    filter: drop-shadow(0 0 9px var(--trip-road-me));
  }
  .stn {
    position: absolute;
    left: 0;
    right: 0;
    padding: 0 20px;
    text-align: center;
  }
  .pin {
    position: absolute;
    top: 0;
    width: 92px;
    height: 92px;
    margin: -46px 0 0 -46px;
    padding: 0;
    border: 3px solid var(--trip-bg);
    border-radius: 50%;
    overflow: hidden;
    background: var(--trip-panel);
    box-shadow:
      0 0 0 3px var(--trip-route),
      0 8px 22px #0009;
    cursor: pointer;
  }
  .pin img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    display: block;
  }
  .pin .n {
    position: absolute;
    right: -2px;
    bottom: -2px;
    background: rgba(10, 12, 16, 0.62);
    color: #fff;
    font-size: 13px;
    line-height: 1;
    padding: 4px 6px;
    border-radius: 9px;
  }
  .cap {
    margin-top: 62px;
    opacity: 0;
    transform: translateY(16px);
    transition:
      opacity 0.5s ease,
      transform 0.5s ease;
  }
  .cap:global(.in) {
    opacity: 1;
    transform: none;
  }
  .capbtn {
    display: block;
    width: 100%;
    border: 0;
    background: none;
    padding: 0;
    color: inherit;
    font: inherit;
    cursor: pointer;
  }
  .cap h2,
  .cap .meta,
  .cap .story,
  .rgn summary {
    --h: var(--trip-bg);
    text-shadow:
      2px 0 var(--h),
      -2px 0 var(--h),
      0 2px var(--h),
      0 -2px var(--h),
      1.5px 1.5px var(--h),
      -1.5px 1.5px var(--h),
      1.5px -1.5px var(--h),
      -1.5px -1.5px var(--h),
      0 0 8px var(--h),
      0 0 12px var(--h);
  }
  .stn.way .pin {
    width: 46px;
    height: 46px;
    margin: -23px 0 0 -23px;
    border-width: 2px;
    box-shadow:
      0 0 0 2px var(--trip-route),
      0 4px 12px #0007;
    outline: 2px dashed var(--trip-bg);
    outline-offset: -5px;
  }
  .stn.way .cap {
    margin-top: 36px;
  }
  .stn.way .meta {
    font-size: 14px;
    font-style: italic;
  }
  .stn h2 {
    margin: 0;
    font-size: 23px;
    font-weight: 650;
    letter-spacing: -0.01em;
    line-height: 1.25;
  }
  .meta {
    color: var(--trip-muted);
    font-size: 16px;
    margin-top: 5px;
  }
  .story {
    margin: 9px auto 0;
    max-width: 34em;
    color: var(--trip-read);
    font-size: 16.5px;
    display: -webkit-box;
    -webkit-line-clamp: 4;
    line-clamp: 4;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
  .rgn {
    margin-top: 6px;
    font-size: 15px;
  }
  .rgn summary {
    color: var(--trip-accent-ink);
    cursor: pointer;
    list-style: none;
  }
  .rgn summary::-webkit-details-marker {
    display: none;
  }
  .rgn summary::before {
    content: '▸ ';
  }
  .rgn[open] summary::before {
    content: '▾ ';
  }
  .rgn p {
    text-align: left;
    color: var(--trip-read);
    font-size: 15px;
    background: var(--trip-bg);
    margin: 8px 0 0;
  }
  .daymark {
    position: absolute;
    left: 0;
    right: 0;
    text-align: center;
    font-size: 15px;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: var(--trip-muted);
  }
  .daymark b {
    display: inline-flex;
    align-items: center;
    gap: 9px;
    background: var(--trip-bg);
    padding: 7px 15px;
    border-radius: 999px;
    border: 1px solid var(--trip-road-edge);
    font-weight: 600;
  }
  .dot {
    width: 10px;
    height: 10px;
    border-radius: 50%;
    flex: 0 0 auto;
  }
  .vday {
    position: sticky;
    top: 68px;
    z-index: 2;
    display: flex;
    align-items: center;
    gap: 9px;
    padding: 10px 16px 6px;
    background: var(--trip-bg);
    font-size: 13px;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--trip-muted);
  }
  .vday .cnt {
    margin-left: auto;
    color: var(--trip-dim);
  }
  .vlist .row {
    display: flex;
    align-items: center;
    gap: 12px;
    width: 100%;
    min-height: 56px;
    padding: 6px 16px;
    border: 0;
    border-bottom: 1px solid var(--trip-line);
    background: none;
    color: inherit;
    font: inherit;
    text-align: left;
    cursor: pointer;
  }
  .vlist .row img {
    width: 44px;
    height: 44px;
    border-radius: 8px;
    object-fit: cover;
    flex: 0 0 auto;
    background: var(--trip-sunk);
  }
  .vlist .txt {
    flex: 1;
    min-width: 0;
  }
  .vlist .txt b {
    display: block;
    font-size: 16px;
    font-weight: 600;
  }
  .vlist .txt small {
    display: block;
    color: var(--trip-muted);
    font-size: 13px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .vlist .cnt {
    color: var(--trip-muted);
    font-size: 14px;
  }
  .vgrid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(110px, 1fr));
    gap: 3px;
    padding: 0 3px;
  }
  .vgrid .vday {
    grid-column: 1 / -1;
  }
  .fullmap {
    position: fixed;
    inset: 0;
  }
</style>
