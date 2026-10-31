<script lang="ts">
  import { dayLabel, itemTitle } from '$lib/trips/trip-text';
  import { timeSpan, type TripItem, type TripPhoto, type TripView } from '$lib/trips/trip-view';
  import { getAssetMediaUrl } from '$lib/utils';
  import { AssetMediaSize } from '@immich/sdk';
  import { onMount, tick } from 'svelte';
  import { locale, t } from 'svelte-i18n';

  // The road (trips DECISIONS-LOG 2026-10-31, travel-album static/viewer/road.js): a Route trip on a phone as a winding
  // road with a station per stop, in Gallery's colours and type. A station opens its stop on the map.

  interface Props {
    view: TripView;
    title: string;
    onOpen: (item: TripItem) => void;
  }

  let { view, title, onOpen }: Props = $props();

  const lang = $derived($locale ?? 'en');

  // A stop every STEP px at least, PAD above the first, one S-bend every WAVE px.
  const STEP = 268;
  const PAD = 130;
  const WAVE = 660;
  const DAY_GAP = 96;

  /** Stations: stops with assets, each followed by the assets shot on the way after it. */
  const stations = $derived(view.order.filter((item) => item.type !== 'unplaced'));
  const total = $derived(stations.reduce((sum, item) => sum + item.photos.length, 0));
  const frames = (count: number) => $t('trips_assets_count', { values: { count } });
  const sub = $derived(
    [
      $t('trips_days_count', { values: { count: view.days.length } }),
      $t('trips_stops_count', { values: { count: view.stops.filter(({ photos }) => photos.length > 0).length } }),
      frames(total),
      view.km ? $t('trips_km', { values: { km: view.km.toLocaleString(lang) } }) : '',
    ].filter(Boolean),
  );

  /** The first station of each day carries the day's badge. */
  const dayStarts = $derived(
    new Set(stations.flatMap((item, index) => (index === 0 || stations[index - 1].day !== item.day ? [index] : []))),
  );

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
    return parts.join(' · ');
  };

  let road = $state<HTMLDivElement>();
  let scroller = $state<HTMLDivElement>();
  let width = $state(0);
  let height = $state(0);
  let ys = $state<number[]>([]);
  let progress = $state(0);
  let donePath = $state<SVGPathElement>();
  let pathLength = $state(0);
  let me = $state({ x: 0, y: 0 });

  const roadX = (y: number) => width / 2 + Math.min(width * 0.26, 108) * Math.sin((y * 2 * Math.PI) / WAVE);

  const onScroll = () => {
    if (!road || !donePath || !scroller || height === 0) {
      return;
    }
    const top = road.offsetTop - scroller.scrollTop;
    progress = Math.max(0, Math.min(1, (scroller.clientHeight * 0.5 - top) / height));
    const point = donePath.getPointAtLength(pathLength * progress);
    me = { x: point.x, y: point.y };
  };

  /** Captions are as tall as their story, so every gap is measured; STEP is only the minimum. */
  const layout = async () => {
    await tick();
    if (!road) {
      return;
    }
    width = road.clientWidth;
    const elements = [...road.querySelectorAll<HTMLElement>('[data-station]')];
    const capHeight = (element: HTMLElement) => element.querySelector<HTMLElement>('[data-caption]')?.offsetHeight ?? 0;
    const next: number[] = [];
    let y = PAD;
    for (const [index, element] of elements.entries()) {
      if (index > 0 && dayStarts.has(index)) {
        y += DAY_GAP;
      }
      next.push(y);
      y +=
        element.dataset.station === 'way'
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

  const thumb = (photo: TripPhoto) =>
    getAssetMediaUrl({ id: photo.id, size: AssetMediaSize.Thumbnail, cacheKey: photo.asset.thumbhash });

  onMount(() => {
    void layout();
  });
</script>

<svelte:window onresize={() => void layout()} />

<div class="size-full overflow-y-auto" bind:this={scroller} onscroll={onScroll} data-testid="trip-road">
  <header class="px-6 pt-6 pb-1 text-center">
    <h1 class="text-2xl font-medium text-immich-fg dark:text-immich-dark-fg">{title}</h1>
    <p class="mt-2 text-sm text-gray-500 dark:text-gray-400" data-testid="trip-sub">{sub.join(' · ')}</p>
    <p class="mt-2 text-sm text-gray-500 dark:text-gray-400">{$t('trips_road_hint')}</p>
  </header>

  <div class="relative mt-1" bind:this={road} style:height="{height}px">
    <svg
      class="absolute inset-0 size-full"
      viewBox="0 0 {width} {height}"
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      <path
        d={roadPath}
        class="fill-none stroke-gray-300 dark:stroke-gray-700"
        stroke-width="60"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
      <path
        d={roadPath}
        class="fill-none stroke-gray-200 dark:stroke-gray-800"
        stroke-width="56"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
      <path
        d={roadPath}
        class="fill-none stroke-gray-400 dark:stroke-gray-600"
        stroke-width="3"
        stroke-dasharray="16 20"
        stroke-linecap="round"
      />
      <path
        d={roadPath}
        bind:this={donePath}
        class="fill-none stroke-primary"
        stroke-width="5"
        stroke-linecap="round"
        style:stroke-dasharray={pathLength}
        style:stroke-dashoffset={pathLength * (1 - progress)}
      />
      <circle r="9" cx={me.x} cy={me.y} class="fill-primary" />
    </svg>

    {#each stations as item, index (item.id)}
      {#if dayStarts.has(index) && view.days[item.day]}
        <div class="absolute inset-x-0 text-center" style:top="{(ys[index] ?? 0) - 104}px" data-testid="trip-daymark">
          <span
            class="inline-flex items-center gap-2 rounded-full border border-gray-300 bg-immich-bg px-4 py-1.5 text-sm font-medium text-gray-600 uppercase dark:border-gray-700 dark:bg-immich-dark-bg dark:text-gray-300"
          >
            <span class="size-2.5 rounded-full" style:background={view.days[item.day].color}></span>
            {dayLabel(view.days[item.day].date, lang)} · {frames(view.days[item.day].count)}
          </span>
        </div>
      {/if}
      <div
        class="absolute inset-x-0 px-5 text-center"
        style:top="{ys[index] ?? 0}px"
        data-station={item.type === 'transit' ? 'way' : 'stop'}
      >
        <button
          type="button"
          class={[
            'absolute top-0 overflow-hidden rounded-full border-3 border-immich-bg bg-gray-200 shadow-lg ring-3 ring-primary dark:border-immich-dark-bg dark:bg-gray-800',
            item.type === 'transit' ? 'ms-[-23px] mt-[-23px] size-[46px]' : 'ms-[-46px] mt-[-46px] size-[92px]',
          ]}
          style:left="{roadX(ys[index] ?? 0)}px"
          aria-label="{itemTitle(item, view, $t, lang)}, {frames(item.photos.length)}"
          onclick={() => onOpen(item)}
        >
          <img src={thumb(item.photos[0])} alt="" loading="lazy" decoding="async" class="size-full object-cover" />
        </button>
        <button
          type="button"
          class={['block w-full', item.type === 'transit' ? 'mt-9' : 'mt-[62px]']}
          data-caption
          onclick={() => onOpen(item)}
        >
          {#if item.type === 'transit'}
            <span class="text-sm text-gray-500 italic dark:text-gray-400"
              >{$t('trips_on_the_way')} · {frames(item.photos.length)}</span
            >
          {:else if item.type === 'stop'}
            <span class="block text-xl font-medium text-immich-fg dark:text-immich-dark-fg">{item.title}</span>
            <span class="mt-1 block text-sm text-gray-500 dark:text-gray-400">{meta(item)}</span>
            {#if item.story}
              <span class="mx-auto mt-2 line-clamp-4 block max-w-[34em] text-sm text-gray-700 dark:text-gray-300"
                >{item.story}</span
              >
            {/if}
          {/if}
        </button>
      </div>
    {/each}
  </div>
</div>
