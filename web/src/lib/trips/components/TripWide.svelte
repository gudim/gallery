<script lang="ts">
  import TripFinale from '$lib/trips/components/TripFinale.svelte';
  import TripMap, { type TripBasemap } from '$lib/trips/components/TripMap.svelte';
  import TripStopDetail from '$lib/trips/components/TripStopDetail.svelte';
  import TripTile from '$lib/trips/components/TripTile.svelte';
  import type { TripLikes } from '$lib/trips/trip-likes.svelte';
  import { dayLabel, itemTitle, rangeLine, yearSpan } from '$lib/trips/trip-text';
  import { inkOn, timeSpan, tripStats, type TripItem, type TripPhoto, type TripView } from '$lib/trips/trip-view';
  import { TripKind } from '@immich/sdk';
  import { mdiImageMultipleOutline, mdiMapOutline, mdiViewGridOutline } from '@mdi/js';
  import { tick } from 'svelte';
  import { SvelteSet } from 'svelte/reactivity';
  import { locale, t } from 'svelte-i18n';
  import type { Snippet } from 'svelte';

  // The map layout of the trip viewer (travel-album static/viewer/map.js): wide, a list of stops beside the map, a
  // grid of every asset, or the map over sections of assets. A Places trip uses it on a phone too, with its own row of
  // views.

  export type WideView = 'map' | 'grid' | 'photos';
  /** A Places trip on a phone: the list, the sections of assets, or the map over the whole screen */
  export type PhoneView = 'list' | 'grid' | 'map';

  interface Props {
    view: TripView;
    title: string;
    likes: TripLikes;
    narrow: boolean;
    initialView: WideView;
    initialPhoneView?: PhoneView;
    initialStopId?: string;
    onView: (view: WideView | PhoneView) => void;
    onOpenPhoto: (photo: TripPhoto) => void;
    tools: Snippet;
  }

  let {
    view,
    title,
    likes,
    narrow,
    initialView,
    initialPhoneView = 'grid',
    initialStopId,
    onView,
    onOpenPhoto,
    tools,
  }: Props = $props();

  const lang = $derived($locale ?? 'en');
  const isPlaces = $derived(view.kind === TripKind.Places);
  const stats = $derived(tripStats(view));

  let phone = $state<PhoneView>(initialPhoneView);
  const asWide: Record<PhoneView, WideView> = { list: 'map', grid: 'photos', map: 'map' };
  let current = $state<WideView>(narrow ? asWide[initialPhoneView] : initialView);
  let openId = $state<string | undefined>(initialStopId);
  let isWide = $state(false);
  const hiddenDays = new SvelteSet<number>();
  let basemap = $state<TripBasemap>('color');
  let filterOpen = $state(!narrow);
  let mapApi: { fitAll: () => void; flyTo: (item: TripItem) => void } | undefined;
  let tripMap = $state<ReturnType<typeof TripMap>>();
  let sections = $state<HTMLDivElement>();
  let hotId = $state<string>();

  const hasMask = $derived(view.overlays.some(({ kind }) => kind === 'mask'));
  $effect.pre(() => {
    if (hasMask) {
      basemap = 'focus';
    }
  });

  const openItem = $derived(
    openId ? (view.order.find(({ id }) => id === openId) ?? view.stops.find(({ id }) => id === openId)) : undefined,
  );

  const frames = (count: number) => $t('trips_assets_count', { values: { count } });
  const colorOf = (day: number) => (isPlaces ? '#2196f3' : (view.days[day]?.color ?? '#2196f3'));

  const setView = async (next: WideView) => {
    current = next;
    onView(next);
    if (next !== 'map') {
      openId = undefined;
    }
    await tick();
    if (next !== 'grid') {
      mapApi?.fitAll();
    }
  };

  const open = async (item: TripItem) => {
    if (current === 'photos') {
      const section = sections?.querySelector<HTMLElement>(`[data-section="${CSS.escape(item.id)}"]`);
      section?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      return;
    }
    if (current === 'grid') {
      await setView('map');
    }
    openId = item.id;
    mapApi?.flyTo(item);
  };

  const close = () => {
    openId = undefined;
    isWide = false;
  };

  const days = $derived(
    view.days.map((day, index) => ({
      ...day,
      index,
      label: dayLabel(day.date, lang),
      stops: view.stops.filter((stop) => stop.day === index),
    })),
  );

  const sectionWhen = (item: TripItem) => {
    if (isPlaces || item.type === 'unplaced') {
      return yearSpan(item.photos);
    }
    const day = dayLabel(view.days[item.day]?.date ?? '', lang);
    return item.t0 !== '—' && item.t1 !== '—' ? `${day}, ${timeSpan(item)}` : day;
  };

  // Photos view: the first section whose bottom is below the top of the scroll area is "hot" on the map.
  const onSectionsScroll = () => {
    if (!sections) {
      return;
    }
    const top = sections.getBoundingClientRect().top + 8;
    const hot = [...sections.querySelectorAll<HTMLElement>('[data-section]')].find(
      (section) => section.getBoundingClientRect().bottom > top,
    );
    hotId = hot?.dataset.section;
    tripMap?.setHot(hotId);
  };

  const sortedPlaces = $derived.by(() => {
    const places = view.stops.filter(({ photos }) => photos.length > 0);
    return placeSort === 'name'
      ? places.sort((a, b) => a.title.localeCompare(b.title, lang))
      : places.sort((a, b) => b.photos.length - a.photos.length || a.id.localeCompare(b.id));
  });
  let placeSort = $state<'frames' | 'name'>('frames');

  const views: { id: WideView; icon: string; label: string }[] = $derived([
    { id: 'map', icon: mdiMapOutline, label: $t('trips_view_map') },
    { id: 'grid', icon: mdiViewGridOutline, label: $t('trips_view_grid') },
    { id: 'photos', icon: mdiImageMultipleOutline, label: $t('trips_view_photos') },
  ]);

  const phoneViews: { id: PhoneView; label: string }[] = $derived([
    { id: 'list', label: $t('trips_view_list') },
    { id: 'grid', label: $t('trips_view_grid') },
    { id: 'map', label: $t('trips_view_map') },
  ]);

  const setPhoneView = async (next: PhoneView) => {
    phone = next;
    current = asWide[next];
    openId = undefined;
    onView(next);
    await tick();
    if (next === 'map') {
      mapApi?.fitAll();
    }
  };

  const onTabKey = (event: KeyboardEvent) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') {
      return;
    }
    const index = views.findIndex(({ id }) => id === current);
    const next = views[(index + (event.key === 'ArrowRight' ? 1 : views.length - 1)) % views.length];
    void setView(next.id);
  };

  const toggleDay = (index: number) => {
    if (hiddenDays.has(index)) {
      hiddenDays.delete(index);
    } else {
      hiddenDays.add(index);
    }
  };

  const showWholeRoute = () => {
    close();
    hiddenDays.clear();
    mapApi?.fitAll();
  };

  const onKeydown = (event: KeyboardEvent) => {
    if (event.key === 'Escape' && openId && !event.defaultPrevented) {
      close();
    }
  };
</script>

<svelte:window onkeydown={onKeydown} />

{#snippet statsRow()}
  <div class="stats" data-testid="trip-stats">
    <div class="stat">
      <b>{stats.assets}</b><span>{$t('trips_stat_assets', { values: { count: stats.assets } })}</span>
    </div>
    <div class="stat" hidden={stats.videos === 0}>
      <b>{stats.videos}</b><span>{$t('trips_stat_videos', { values: { count: stats.videos } })}</span>
    </div>
    <div class="stat">
      <b>{stats.stops}</b><span
        >{$t(isPlaces ? 'trips_stat_places' : 'trips_stat_stops', { values: { count: stats.stops } })}</span
      >
    </div>
    <div class="stat" hidden={isPlaces}>
      <b>{stats.days}</b><span>{$t('trips_stat_days', { values: { count: stats.days } })}</span>
    </div>
    <div class="stat" hidden={isPlaces}><b>{stats.km ?? 0}</b><span>{$t('trips_stat_km')}</span></div>
  </div>
{/snippet}

{#snippet tile(photo: TripPhoto, item: TripItem, index: number)}
  <TripTile
    {photo}
    {likes}
    showTime={!narrow}
    label={$t('trips_frame_of', {
      values: { title: itemTitle(item, view, $t, lang), index: index + 1, count: item.photos.length },
    })}
    onOpen={onOpenPhoto}
  />
{/snippet}

{#snippet badge(item: TripItem)}
  {#if item.type === 'stop' && item.number}
    <span class="no" style:background={colorOf(item.day)} style:color={inkOn(colorOf(item.day))}>{item.number}</span>
  {:else}
    <span class="no way" style:--day={item.type === 'unplaced' ? 'var(--trip-dim)' : colorOf(item.day)}></span>
  {/if}
{/snippet}

<div
  class="trip-wide"
  class:wide-grid={isWide && current === 'map' && !!openItem}
  class:narrow
  data-view={current}
  data-phone={narrow ? phone : undefined}
  data-testid="trip-wide"
>
  <nav class="views" class:floating={narrow} aria-label={$t('trips_view_as')}>
    {#if narrow}
      <div class="seg" role="tablist">
        {#each phoneViews as option (option.id)}
          <button
            type="button"
            role="tab"
            aria-selected={phone === option.id}
            class:on={phone === option.id}
            onclick={() => setPhoneView(option.id)}>{option.label}</button
          >
        {/each}
      </div>
    {:else}
      <div class="seg" role="tablist" tabindex="-1" onkeydown={onTabKey}>
        {#each views as option (option.id)}
          <button
            type="button"
            role="tab"
            aria-selected={current === option.id}
            class:on={current === option.id}
            onclick={() => setView(option.id)}
          >
            <svg viewBox="0 0 24 24" width="17" height="17" aria-hidden="true"
              ><path d={option.icon} fill="currentColor" /></svg
            >
            {option.label}
          </button>
        {/each}
      </div>
    {/if}
    <div class="toolset">{@render tools()}</div>
  </nav>

  {#if current === 'grid'}
    <header class="row-head">
      <div class="titles">
        <h1>{title}</h1>
        <div class="sub" data-testid="trip-range">{rangeLine(view, $t, lang)}</div>
      </div>
      {@render statsRow()}
    </header>
    <div class="scroll grid-all" data-testid="trip-grid">
      {#each view.order as item (item.id)}
        {#each item.photos as photo, index (photo.id)}
          {@render tile(photo, item, index)}
        {/each}
      {/each}
    </div>
  {:else}
    <div class="body" class:photos={current === 'photos'}>
      {#if current === 'map'}
        <aside class="side">
          <header class="head">
            <h1>{title}</h1>
            <div class="sub" data-testid="trip-range">{rangeLine(view, $t, lang, narrow)}</div>
            {#if !narrow}
              {@render statsRow()}
            {/if}
          </header>
          <div class="scroll list" data-testid="trip-list">
            {#if isPlaces}
              <div class="dayhdr sorthdr">
                {$t('trips_places_title')}
                <span class="sortseg">
                  <button type="button" class:on={placeSort === 'frames'} onclick={() => (placeSort = 'frames')}
                    >{$t('trips_sort_frames')}</button
                  >
                  <button type="button" class:on={placeSort === 'name'} onclick={() => (placeSort = 'name')}
                    >{$t('trips_sort_name')}</button
                  >
                </span>
              </div>
              {#each sortedPlaces as stop (stop.id)}
                <button type="button" class="item place" class:on={openId === stop.id} onclick={() => open(stop)}>
                  <span class="nm">{stop.title}<small>{yearSpan(stop.photos)}</small></span>
                  <span class="np">{stop.photos.length}</span>
                </button>
              {/each}
              {#if view.unplaced}
                <button
                  type="button"
                  class="item unpl"
                  class:on={openId === 'unplaced'}
                  onclick={() => open(view.unplaced!)}
                >
                  <span class="nm">{$t('trips_unplaced')}</span>
                  <span class="np">{view.unplaced.photos.length}</span>
                </button>
              {/if}
            {:else}
              {#each days as day (day.date)}
                {#if !hiddenDays.has(day.index) && day.stops.length > 0}
                  <div class="dayhdr">
                    <span class="dot" style:background={day.color}></span>{day.label}
                    <span class="rt">{day.regions.slice(0, 3).join(' · ')}</span>
                    <span class="cnt">{day.count}</span>
                  </div>
                  {#each day.stops as stop (stop.id)}
                    <button
                      type="button"
                      class="item"
                      class:small={stop.photos.length <= 3}
                      class:on={openId === stop.id}
                      onclick={() => open(stop)}
                    >
                      <span class="tm">{stop.t0}</span>
                      <span class="nm">{stop.title || stop.region}</span>
                      <span class="np">{stop.photos.length || ''}</span>
                    </button>
                    {#each view.transit.filter(({ fromStopId }) => fromStopId === stop.id) as way (way.id)}
                      <button
                        type="button"
                        class="item small way"
                        class:on={openId === way.id}
                        onclick={() => open(way)}
                      >
                        <span class="tm">{way.t0}</span>
                        <span class="nm">{$t('trips_on_the_way')}</span>
                        <span class="np">{way.photos.length}</span>
                      </button>
                    {/each}
                  {/each}
                {/if}
              {/each}
              {#if view.kind === TripKind.Route}
                <TripFinale {view} {title} onWholeRoute={showWholeRoute} />
              {/if}
            {/if}
          </div>

          {#if openItem}
            <TripStopDetail
              item={openItem}
              {view}
              {likes}
              {narrow}
              {isWide}
              onBack={close}
              onToggleWide={() => (isWide = !isWide)}
              {onOpenPhoto}
            />
          {/if}
        </aside>
      {/if}

      <div class="mapbox">
        <TripMap
          bind:this={tripMap}
          {view}
          {narrow}
          selectedId={openId}
          toc={current === 'photos'}
          {hiddenDays}
          {basemap}
          topInset={narrow ? 62 : 0}
          onItem={open}
          onPhoto={(photo) => onOpenPhoto(photo)}
          onReady={(api) => {
            mapApi = api;
            const item = openItem;
            if (item) {
              api.flyTo(item);
            }
          }}
        />
        {#if current === 'map' && (hasMask || view.days.length > 1 || !isPlaces)}
          <div class="filt" class:closed={!filterOpen}>
            {#if narrow}
              <button type="button" class="filt-toggle" onclick={() => (filterOpen = !filterOpen)}
                >{$t('trips_filter_toggle')} ▾{#if hiddenDays.size > 0}<span class="mark"></span>{/if}</button
              >
            {/if}
            {#if filterOpen}
              {#if hasMask}
                <div class="seg small">
                  <button
                    type="button"
                    class:on={basemap === 'focus'}
                    title={$t('trips_basemap_focus_title')}
                    onclick={() => (basemap = 'focus')}>{$t('trips_basemap_focus')}</button
                  >
                  <button
                    type="button"
                    class:on={basemap === 'color'}
                    title={$t('trips_basemap_color_title')}
                    onclick={() => (basemap = 'color')}>{$t('trips_basemap_color')}</button
                  >
                </div>
              {/if}
              {#if !isPlaces}
                <div class="days" data-testid="trip-days">
                  {#each days as day (day.date)}
                    <button type="button" class:off={hiddenDays.has(day.index)} onclick={() => toggleDay(day.index)}>
                      <span class="dot" style:background={day.color}></span>{day.label}<span class="n">{day.count}</span
                      >
                    </button>
                  {/each}
                </div>
              {/if}
            {/if}
          </div>
        {/if}
      </div>

      {#if current === 'photos'}
        <div class="scroll sections" bind:this={sections} onscroll={onSectionsScroll} data-testid="trip-sections">
          {#if narrow}
            <header class="head phone-head">
              <h1>{title}</h1>
              <div class="sub">{rangeLine(view, $t, lang, true)}</div>
            </header>
          {/if}
          {#each view.order as item (item.id)}
            <section data-section={item.id} class:hot={hotId === item.id}>
              <h2 class="sech">
                {@render badge(item)}
                <span class="nm">{itemTitle(item, view, $t, lang)}</span>
                {#if item.type === 'transit'}<span class="tagword">{$t('trips_on_the_way')}</span>{/if}
                <span class="when">{sectionWhen(item)}</span>
                <span class="cnt">{frames(item.photos.length)}</span>
              </h2>
              <div class="secgrid">
                {#each item.photos as photo, index (photo.id)}
                  {@render tile(photo, item, index)}
                {/each}
              </div>
            </section>
          {/each}
        </div>
      {/if}
    </div>
  {/if}
</div>

<style>
  .trip-wide {
    position: fixed;
    inset: 0;
    display: flex;
    flex-direction: column;
    background: var(--trip-bg);
  }
  .body {
    flex: 1;
    min-height: 0;
    display: flex;
  }
  .body.photos {
    flex-direction: column;
  }
  .side {
    width: 380px;
    flex: 0 0 380px;
    background: var(--trip-panel);
    border-right: 1px solid var(--trip-line);
    display: flex;
    flex-direction: column;
    position: relative;
    z-index: 5;
  }
  .mapbox {
    flex: 1;
    position: relative;
    min-height: 0;
  }
  .body.photos .mapbox {
    flex: 0 0 clamp(240px, 36vh, 380px);
    border-bottom: 1px solid var(--trip-line);
  }
  .scroll {
    overflow-y: auto;
    overflow-x: hidden;
    flex: 1;
    min-height: 0;
    scrollbar-width: thin;
    scrollbar-color: var(--trip-scroll) transparent;
  }
  .head {
    padding: 20px 20px 14px;
    border-bottom: 1px solid var(--trip-line);
    flex: 0 0 auto;
  }
  h1 {
    margin: 0 0 4px;
    font-size: 20px;
    font-weight: 650;
    letter-spacing: -0.2px;
    padding-right: 48px;
  }
  .sub {
    color: var(--trip-muted);
    font-size: 13px;
  }
  .stats {
    display: flex;
    gap: 16px;
    margin-top: 12px;
  }
  .stat b {
    display: block;
    font-size: 19px;
    font-weight: 650;
    line-height: 1.2;
  }
  .stat span {
    font-size: 12px;
    color: var(--trip-muted);
    text-transform: uppercase;
    letter-spacing: 0.06em;
  }
  .views {
    position: fixed;
    top: 0;
    right: 10px;
    height: 78px;
    display: flex;
    align-items: center;
    gap: 10px;
    z-index: 20;
  }
  .seg {
    display: flex;
    background: var(--trip-glass);
    border: 1px solid var(--trip-line);
    border-radius: 9px;
    padding: 3px;
    gap: 2px;
    box-shadow: var(--trip-shadow);
    backdrop-filter: blur(6px);
  }
  .seg button {
    display: flex;
    align-items: center;
    gap: 6px;
    border: 0;
    background: none;
    color: var(--trip-muted);
    font: inherit;
    font-size: 13.5px;
    padding: 6px 12px;
    border-radius: 6px;
    cursor: pointer;
    white-space: nowrap;
  }
  .seg button.on {
    background: var(--trip-panel2);
    color: var(--trip-text);
    font-weight: 600;
  }
  .seg.small button {
    font-size: 12px;
    padding: 4px 10px;
  }
  .row-head {
    height: 78px;
    flex: 0 0 78px;
    display: flex;
    align-items: center;
    gap: 28px;
    padding: 0 380px 0 20px;
    border-bottom: 1px solid var(--trip-line);
    background: var(--trip-panel);
  }
  .row-head .stats {
    margin-top: 0;
  }
  .grid-all {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(168px, 1fr));
    gap: 4px;
    padding: 16px 20px 40px;
    align-content: start;
  }
  .dayhdr {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 14px 20px 8px;
    font-size: 12px;
    text-transform: uppercase;
    letter-spacing: 0.09em;
    color: var(--trip-muted);
    position: sticky;
    top: 0;
    background: var(--trip-panel);
    z-index: 2;
  }
  .dot {
    width: 9px;
    height: 9px;
    border-radius: 50%;
    flex: 0 0 auto;
  }
  .dayhdr .cnt {
    margin-left: auto;
    text-transform: none;
    letter-spacing: 0;
    color: var(--trip-dim);
  }
  .dayhdr .rt {
    color: var(--trip-dim);
    text-transform: none;
    letter-spacing: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 150px;
  }
  .sortseg {
    margin-left: auto;
    text-transform: none;
    letter-spacing: 0;
  }
  .sortseg button {
    border: 0;
    background: none;
    color: var(--trip-muted);
    font: inherit;
    font-size: 12px;
    padding: 3px 8px;
    border-radius: 4px;
    cursor: pointer;
  }
  .sortseg button.on {
    background: var(--trip-panel2);
    color: var(--trip-text);
  }
  .item {
    display: flex;
    gap: 12px;
    padding: 9px 20px;
    cursor: pointer;
    border: 0;
    border-left: 3px solid transparent;
    width: 100%;
    background: none;
    color: inherit;
    font: inherit;
    text-align: left;
    align-items: baseline;
    transition: background 0.12s;
  }
  .item:hover {
    background: var(--trip-panel2);
  }
  .item.on {
    background: var(--trip-panel2);
    border-left-color: var(--trip-accent);
  }
  .item .tm {
    color: var(--trip-muted);
    font-size: 12px;
    font-variant-numeric: tabular-nums;
    flex: 0 0 38px;
  }
  .item .nm {
    flex: 1;
    font-size: 14px;
  }
  .item .np {
    color: var(--trip-muted);
    font-size: 12px;
  }
  .item.small .nm {
    color: var(--trip-muted);
    font-size: 13px;
  }
  .item.way .nm,
  .item.unpl .nm {
    font-style: italic;
  }
  .item.place .nm small {
    display: block;
    color: var(--trip-muted);
    font-size: 12px;
  }
  /* Full-width assets: the map becomes a strip on top, the panel takes the width. */
  .wide-grid .body {
    flex-direction: column;
  }
  .wide-grid .mapbox {
    flex: 0 0 200px;
    order: -1;
    border-bottom: 1px solid var(--trip-line);
  }
  .wide-grid .side {
    width: 100%;
    flex: 1 1 auto;
    min-height: 0;
    border-right: 0;
  }
  .filt {
    position: absolute;
    top: 72px;
    right: 10px;
    z-index: 4;
    background: var(--trip-glass);
    border: 1px solid var(--trip-line);
    border-radius: 8px;
    padding: 8px;
    min-width: 150px;
    backdrop-filter: blur(6px);
    box-shadow: var(--trip-shadow);
  }
  .days {
    display: flex;
    flex-direction: column;
    gap: 2px;
    margin-top: 8px;
    padding-top: 8px;
    border-top: 1px solid var(--trip-line);
    max-height: 50vh;
    overflow-y: auto;
  }
  .seg.small + .days {
    margin-top: 8px;
  }
  .days:first-child {
    margin-top: 0;
    padding-top: 0;
    border-top: 0;
  }
  .days button {
    display: flex;
    align-items: center;
    gap: 8px;
    border: 0;
    background: none;
    color: var(--trip-text);
    font: inherit;
    font-size: 13px;
    padding: 4px 6px;
    border-radius: 5px;
    cursor: pointer;
    text-align: left;
  }
  .days button:hover {
    background: var(--trip-panel2);
  }
  .days button.off {
    opacity: 0.35;
  }
  .days .n {
    margin-left: auto;
    padding-left: 12px;
    color: var(--trip-dim);
    font-size: 12px;
  }
  .filt-toggle {
    border: 0;
    background: none;
    color: var(--trip-text);
    font: inherit;
    font-size: 13px;
    cursor: pointer;
    position: relative;
  }
  .filt-toggle .mark {
    position: absolute;
    top: -2px;
    right: -8px;
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--trip-accent);
  }
  .sections {
    padding-bottom: 40vh;
  }
  .sech {
    position: sticky;
    top: 0;
    z-index: 2;
    display: flex;
    align-items: center;
    gap: 10px;
    margin: 0;
    padding: 12px 20px;
    background: var(--trip-bg);
    font-size: 16px;
    font-weight: 650;
  }
  .sech .when {
    color: var(--trip-muted);
    font-size: 13px;
    font-weight: 400;
  }
  .sech .cnt {
    margin-left: auto;
    color: var(--trip-muted);
    font-size: 13px;
    font-weight: 400;
  }
  .sech .tagword {
    font-style: italic;
    color: var(--trip-muted);
    font-weight: 400;
    font-size: 13px;
  }
  .no {
    min-width: 24px;
    height: 24px;
    padding: 0 6px;
    border-radius: 12px;
    border: 2px solid #fff;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    font-size: 12px;
    font-weight: 650;
  }
  .no.way {
    min-width: 14px;
    width: 14px;
    height: 14px;
    padding: 0;
    border: 2px dashed var(--day);
    background: none;
  }
  .secgrid {
    display: grid;
    gap: 4px;
    grid-template-columns: repeat(auto-fill, minmax(168px, 1fr));
    padding: 0 20px 18px;
  }
  /* Phone (Places): the panel over the map, the row of views floating on top. */
  .narrow .side {
    width: 100%;
    flex: 1;
  }
  .narrow .views {
    left: 10px;
    right: 10px;
    height: 62px;
    justify-content: space-between;
  }
  .toolset {
    display: flex;
    gap: 6px;
  }
  .narrow .views {
    top: 0;
    padding-top: 8px;
    height: auto;
    align-items: stretch;
  }
  .narrow .seg {
    flex: 1;
  }
  .narrow .seg button {
    flex: 1;
    justify-content: center;
    min-height: 44px;
    font-size: 15px;
  }
  .narrow .body {
    flex-direction: column;
  }
  .narrow[data-phone='list'] .mapbox,
  .narrow[data-phone='grid'] .mapbox {
    display: none;
  }
  .narrow[data-phone='list'] .side {
    padding-top: 62px;
  }
  .narrow[data-phone='list'] .head,
  .phone-head {
    text-align: center;
  }
  .phone-head {
    padding: 70px 16px 8px;
  }
  .phone-head h1 {
    padding-right: 0;
    font-size: 24px;
  }
  .narrow[data-phone='map'] .side {
    width: 0;
    flex: 0 0 0;
    border: 0;
  }
  .narrow[data-phone='map'] .head,
  .narrow[data-phone='map'] .list {
    display: none;
  }
  .narrow[data-phone='map'] .mapbox {
    flex: 1;
  }
  .narrow .row-head {
    padding: 70px 16px 10px;
    height: auto;
    flex-basis: auto;
    flex-direction: column;
    align-items: flex-start;
    gap: 6px;
  }
  .narrow .grid-all,
  .narrow .secgrid {
    grid-template-columns: repeat(auto-fill, minmax(104px, 1fr));
    gap: 3px;
    padding: 8px;
  }
</style>
