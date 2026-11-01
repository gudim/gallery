<script lang="ts">
  import Timeline from '$lib/components/timeline/Timeline.svelte';
  import TripClockModal from '$lib/trips/components/TripClockModal.svelte';
  import TripLegEdit from '$lib/trips/components/TripLegEdit.svelte';
  import TripPlaceHints from '$lib/trips/components/TripPlaceHints.svelte';
  import TripPointModal from '$lib/trips/components/TripPointModal.svelte';
  import TripStopEdit from '$lib/trips/components/TripStopEdit.svelte';
  import type { TripEditor } from '$lib/trips/trip-editor.svelte';
  import { assetMultiSelectManager } from '$lib/managers/asset-multi-select-manager.svelte';
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import { TimelineManager } from '$lib/managers/timeline-manager/timeline-manager.svelte';
  import { MODE_ICONS } from '$lib/trips/trip-map';
  import { dayLabel, itemTitle, rangeLine, yearSpan } from '$lib/trips/trip-text';
  import { timeSpan, tripStats, type TripItem, type TripView, type TripViewStop } from '$lib/trips/trip-view';
  import {
    addPoint,
    AssetOrder,
    retryLegs,
    setFinish,
    setStart,
    TripKind,
    TripLegStatus,
    TripStopRole,
    type TripLegDto,
  } from '@immich/sdk';
  import { Button, CloseButton, Icon, LoadingSpinner, modalManager } from '@immich/ui';
  import {
    mdiAlertCircleOutline,
    mdiArrowLeft,
    mdiClockEditOutline,
    mdiFlagCheckered,
    mdiHomeMapMarker,
    mdiMapMarkerPlusOutline,
    mdiRefresh,
  } from '@mdi/js';
  import { locale, t } from 'svelte-i18n';

  // The panel beside a trip's map (trips PLAN §2.3), in the place of the map page's timeline panel: the trip's
  // numbers, its stops by day with the legs between them, and an opened stop with its assets in Gallery's timeline.
  // In edit mode (§2.5) an opened stop or leg shows what can be changed, and the route's ends and points can be added.

  interface Props {
    view: TripView;
    /** Set for owners and editors in edit mode */
    editor?: TripEditor;
    /** The stop or item opened */
    openId?: string;
    /** Stops picked on the map (a cluster of markers) */
    pickedIds?: string[];
    /** The leg opened in edit mode */
    openLegId?: string;
    onOpen: (item: TripItem) => void;
    onOpenLeg: (legId: string) => void;
    onBack: () => void;
    onClearPicked: () => void;
    onMovePin: (stop: TripViewStop) => void;
  }

  let { view, editor, openId, pickedIds, openLegId, onOpen, onOpenLeg, onBack, onClearPicked, onMovePin }: Props =
    $props();

  const isEditing = $derived(!!editor);

  const lang = $derived($locale ?? 'en');
  const isPlaces = $derived(view.kind === TripKind.Places);
  const isRoute = $derived(view.kind === TripKind.Route);
  const stats = $derived(tripStats(view));
  const frames = (count: number) => $t('trips_assets_count', { values: { count } });

  const openItem = $derived(
    openId ? (view.order.find(({ id }) => id === openId) ?? view.stops.find(({ id }) => id === openId)) : undefined,
  );
  // Every leg, drawn or not: a leg still being routed has no line yet.
  const openLeg = $derived(openLegId && editor ? editor.trip!.legs.find(({ id }) => id === openLegId) : undefined);
  const stopName = (id: string) => {
    const stop = view.stops.find((candidate) => candidate.id === id);
    return stop ? rowTitle(stop) : '…';
  };

  /** A stop's name in lists; the start, the finish and a point not named yet still read as something. */
  const rowTitle = (stop: TripViewStop) => {
    if (stop.title || stop.region) {
      return stop.title || stop.region;
    }
    if (stop.stop.role) {
      return stop.stop.role === TripStopRole.Start ? $t('trips_start') : $t('trips_finish');
    }
    return $t('trips_untitled_stop');
  };

  const statsLine = $derived(
    [
      frames(stats.assets),
      stats.videos > 0 ? $t('trips_videos_count', { values: { count: stats.videos } }) : '',
      isPlaces
        ? $t('trips_places_count', { values: { count: stats.stops } })
        : $t('trips_stops_count', { values: { count: stats.stops } }),
      isRoute ? $t('trips_days_count', { values: { count: stats.days } }) : '',
      isRoute && stats.km ? $t('trips_km', { values: { km: stats.km.toLocaleString(lang) } }) : '',
    ].filter(Boolean),
  );

  const legLine = (leg: TripLegDto) => {
    const parts = [$t(`trips_mode_${leg.mode}`)];
    if (leg.distance) {
      const km = leg.distance / 1000;
      parts.push($t('trips_km', { values: { km: km < 10 ? km.toFixed(1) : Math.round(km) } }));
    }
    if (leg.duration) {
      const minutes = Math.max(1, Math.round(leg.duration / 60));
      const hours = Math.floor(minutes / 60);
      parts.push(
        hours > 0
          ? $t('trips_duration_hours', { values: { hours, minutes: minutes % 60 } })
          : $t('trips_duration_minutes', { values: { minutes } }),
      );
    }
    if (leg.departureName && leg.arrivalName) {
      parts.push(`${leg.departureName} → ${leg.arrivalName}`);
    }
    return parts.join(' · ');
  };

  // In edit mode every leg is listed, a leg still being routed included.
  const legsFrom = (stopId: string) =>
    (editor?.trip?.legs ?? view.legs).filter(({ fromStopId }) => fromStopId === stopId);

  const days = $derived(
    view.days.map((day, index) => ({
      ...day,
      label: dayLabel(day.date, lang),
      stops: view.stops.filter((stop) => stop.day === index),
    })),
  );

  let placeSort = $state<'frames' | 'name'>('frames');
  const places = $derived.by(() => {
    const list = view.stops.filter(({ photos }) => isEditing || photos.length > 0);
    return placeSort === 'name'
      ? list.sort((a, b) => a.title.localeCompare(b.title, lang))
      : list.sort((a, b) => b.photos.length - a.photos.length || a.id.localeCompare(b.id));
  });

  const picked = $derived(pickedIds ? view.order.filter(({ id }) => pickedIds.includes(id)) : undefined);

  const meta = (item: TripItem) => {
    if (item.type === 'unplaced') {
      return [frames(item.photos.length)];
    }
    const parts: string[] = [];
    if (isPlaces || view.kind === TripKind.Plain) {
      parts.push(yearSpan(item.photos));
    } else {
      parts.push(dayLabel(view.days[item.day]?.date ?? '', lang));
      if (item.type === 'transit') {
        parts.push($t('trips_on_the_way'));
      }
      parts.push(item.photos.length > 0 ? timeSpan(item) : $t('trips_no_shots'));
    }
    if (item.photos.length > 0) {
      parts.push(frames(item.photos.length));
    }
    if (item.videoCount > 0) {
      parts.push($t('trips_videos_count', { values: { count: item.videoCount } }));
    }
    if (item.type === 'stop' && view.isMultiCountry && item.country) {
      parts.push(item.country);
    }
    return parts.filter(Boolean);
  };

  const empty = (item: TripItem) => {
    if (item.type === 'stop' && isPlaces) {
      return item.stop.role ? $t('trips_empty_center') : $t('trips_empty_place');
    }
    return $t('trips_empty_stop');
  };

  const hasStart = $derived(view.stops.some(({ stop }) => stop.role === TripStopRole.Start));
  const hasFinish = $derived(view.stops.some(({ stop }) => stop.role === TripStopRole.Finish));
  const attentionCount = $derived(
    editor?.trip?.legs.filter(({ status }) => status === TripLegStatus.Attention).length ?? 0,
  );
  const firstPoint = $derived.by(() => {
    const stop = view.stops.find(({ latitude, longitude }) => latitude !== null && longitude !== null);
    return stop ? { latitude: stop.latitude!, longitude: stop.longitude! } : undefined;
  });

  const onEnd = async (role: TripStopRole) => {
    const picked = await modalManager.show(TripPointModal, {
      albumId: view.albumId,
      title: role === TripStopRole.Start ? $t('trips_start') : $t('trips_finish'),
      point: firstPoint,
      isNamed: true,
    });
    if (picked && editor) {
      const end = { latitude: picked.latitude, longitude: picked.longitude, title: picked.title || null };
      await editor.run(
        (id) =>
          role === TripStopRole.Start ? setStart({ id, tripEndDto: end }) : setFinish({ id, tripFinishUpdateDto: end }),
        $t('trips_edit_failed'),
      );
    }
  };

  /** A point from the overview goes right after the start; it can be moved after any stop from its own card. */
  const onAddPoint = async () => {
    const picked = await modalManager.show(TripPointModal, {
      albumId: view.albumId,
      title: $t('trips_add_point'),
      point: firstPoint,
      isNamed: true,
    });
    if (picked && editor) {
      await editor.run(
        (id) => addPoint({ id, tripPointCreateDto: { ...picked, title: picked.title || null, afterStopId: null } }),
        $t('trips_edit_failed'),
      );
    }
  };

  let timelineManager = $state<TimelineManager>() as TimelineManager;
  const timelineOptions = $derived(
    openItem && openItem.photos.length > 0
      ? {
          albumId: view.albumId,
          order: AssetOrder.Asc,
          assetFilter: new Set(openItem.photos.map(({ id }) => id)),
        }
      : undefined,
  );
</script>

{#snippet stopRow(stop: TripViewStop)}
  <button
    type="button"
    class="flex w-full items-baseline gap-3 px-4 py-2 text-start hover:bg-subtle"
    data-testid="trip-stop-row"
    onclick={() => onOpen(stop)}
  >
    {#if isRoute}
      <span class="w-11 shrink-0 text-xs text-gray-500 tabular-nums dark:text-gray-400">{stop.t0}</span>
    {/if}
    <span
      class={[
        'flex-1 text-sm',
        stop.photos.length <= 3 && 'text-gray-600 dark:text-gray-300',
        !stop.title && !stop.region && 'italic',
      ]}>{rowTitle(stop)}</span
    >
    <span class="text-xs text-gray-500 dark:text-gray-400">{stop.photos.length || ''}</span>
  </button>
{/snippet}

{#snippet legRow(leg: TripLegDto)}
  {#if isEditing}
    <button
      type="button"
      class="flex w-full items-center gap-3 px-4 py-1 text-start text-xs text-gray-500 hover:bg-subtle dark:text-gray-400"
      onclick={() => onOpenLeg(leg.id)}
      data-testid="trip-leg-row"
    >
      <span class="flex w-11 shrink-0 justify-center"><Icon icon={MODE_ICONS[leg.mode]} size="16" /></span>
      <span class="flex-1">{legLine(leg)}</span>
      {#if leg.status === TripLegStatus.Pending}
        <LoadingSpinner size="tiny" />
      {:else if leg.status === TripLegStatus.Attention}
        <Icon icon={mdiAlertCircleOutline} size="16" class="text-warning" aria-label={$t('trips_leg_attention')} />
      {/if}
    </button>
  {:else}
    <div class="flex items-center gap-3 px-4 py-1 text-xs text-gray-500 dark:text-gray-400">
      <span class="flex w-11 shrink-0 justify-center"><Icon icon={MODE_ICONS[leg.mode]} size="16" /></span>
      <span>{legLine(leg)}</span>
    </div>
  {/if}
{/snippet}

<aside
  class="flex size-full flex-col overflow-hidden bg-immich-bg text-immich-fg dark:bg-immich-dark-bg dark:text-immich-dark-fg"
  data-testid="trip-panel"
>
  {#if openLeg && editor}
    <div class="min-h-0 flex-1 overflow-y-auto px-4 py-3" data-testid="trip-leg">
      <Button size="small" variant="ghost" color="secondary" leadingIcon={mdiArrowLeft} onclick={onBack} class="-ms-2">
        {$t('trips_back_route')}
      </Button>
      <h2 class="mt-1 text-lg font-medium">{stopName(openLeg.fromStopId)} → {stopName(openLeg.toStopId)}</h2>
      <p class="mb-3 text-xs text-gray-500 dark:text-gray-400">{legLine(openLeg)}</p>
      <TripLegEdit {editor} leg={openLeg} />
    </div>
  {:else if openItem}
    <div
      class={[
        'border-b border-gray-200 px-4 py-3 dark:border-immich-dark-gray',
        isEditing && 'max-h-[60%] overflow-y-auto',
      ]}
      data-testid="trip-stop"
    >
      <div class="flex items-center gap-2">
        <Button
          size="small"
          variant="ghost"
          color="secondary"
          leadingIcon={mdiArrowLeft}
          onclick={onBack}
          class="-ms-2"
        >
          {isPlaces ? $t('trips_back_places') : $t('trips_back_route')}
        </Button>
      </div>
      <h2 class="mt-1 text-lg font-medium">
        {openItem.type === 'stop' ? rowTitle(openItem) : itemTitle(openItem, view, $t, lang)}
      </h2>
      <p class="text-xs text-gray-500 dark:text-gray-400">{meta(openItem).join(' · ')}</p>
      {#if editor && openItem.type !== 'unplaced'}
        <div class="mt-3">
          <TripStopEdit {editor} item={openItem} {onMovePin} onGone={onBack} />
        </div>
      {:else if openItem.type === 'stop' && openItem.story}
        <p class="mt-2 line-clamp-6 text-sm whitespace-pre-line text-gray-700 dark:text-gray-300">
          {openItem.story}
        </p>
      {:else if openItem.type === 'unplaced'}
        <p class="mt-2 text-sm text-gray-700 dark:text-gray-300">{$t('trips_unplaced_note')}</p>
        {#if editor && isPlaces}
          <TripPlaceHints {editor} />
        {/if}
      {/if}
      {#if editor && openItem.photos.length > 0}
        <p class="mt-3 text-xs text-gray-500 dark:text-gray-400">{$t('trips_select_hint')}</p>
      {/if}
      {#if !editor && openItem.type === 'stop' && openItem.article}
        <details class="mt-2 text-sm">
          <summary class="cursor-pointer text-primary">{$t('trips_about_place')}</summary>
          <div class="max-h-[30vh] overflow-y-auto">
            {#each openItem.article.split(/\n\s*\n/) as paragraph, index (index)}
              <p class="mt-2 text-gray-700 dark:text-gray-300">{paragraph}</p>
            {/each}
          </div>
        </details>
      {/if}
    </div>
    {#if timelineOptions}
      <div class="min-h-0 flex-1">
        {#key openItem.id}
          <Timeline
            bind:timelineManager
            enableRouting={false}
            options={timelineOptions}
            assetInteraction={assetMultiSelectManager}
            isShared={authManager.isSharedLink}
          />
        {/key}
      </div>
    {:else}
      <p class="p-4 text-sm text-gray-500 dark:text-gray-400">{empty(openItem)}</p>
    {/if}
  {:else}
    <div class="border-b border-gray-200 px-4 py-3 dark:border-immich-dark-gray">
      <p class="text-sm" data-testid="trip-range">{rangeLine(view, $t, lang)}</p>
      <p class="text-xs text-gray-500 dark:text-gray-400" data-testid="trip-stats">{statsLine.join(' · ')}</p>
      {#if editor}
        <div class="mt-3 flex flex-wrap gap-2" data-testid="trip-route-actions">
          {#if isRoute && !hasStart}
            <Button
              size="small"
              shape="round"
              color="secondary"
              variant="outline"
              leadingIcon={mdiHomeMapMarker}
              onclick={() => onEnd(TripStopRole.Start)}>{$t('trips_set_start')}</Button
            >
          {/if}
          {#if isRoute && !hasFinish}
            <Button
              size="small"
              shape="round"
              color="secondary"
              variant="outline"
              leadingIcon={mdiFlagCheckered}
              onclick={() => onEnd(TripStopRole.Finish)}>{$t('trips_set_finish')}</Button
            >
          {/if}
          {#if isRoute}
            <Button
              size="small"
              shape="round"
              color="secondary"
              variant="outline"
              leadingIcon={mdiMapMarkerPlusOutline}
              onclick={onAddPoint}>{$t('trips_add_point')}</Button
            >
          {/if}
          <Button
            size="small"
            shape="round"
            color="secondary"
            variant="outline"
            leadingIcon={mdiClockEditOutline}
            onclick={() => modalManager.show(TripClockModal, { editor })}
            data-testid="trip-clock">{$t('trips_clock')}</Button
          >
          {#if attentionCount > 0}
            <Button
              size="small"
              shape="round"
              color="secondary"
              variant="outline"
              leadingIcon={mdiRefresh}
              onclick={() => editor.run((id) => retryLegs({ id }), $t('trips_edit_failed'))}
              >{$t('trips_retry_legs', { values: { count: attentionCount } })}</Button
            >
          {/if}
        </div>
      {/if}
    </div>
    <div class="min-h-0 flex-1 overflow-y-auto py-1" data-testid="trip-list">
      {#if picked}
        <div class="flex items-center justify-between px-4 py-2">
          <p class="text-sm font-medium">{$t('trips_several_stops')}</p>
          <CloseButton onclick={onClearPicked} />
        </div>
        {#each picked as item (item.id)}
          <button
            type="button"
            class="flex w-full items-baseline gap-3 px-4 py-2 text-start hover:bg-subtle"
            onclick={() => onOpen(item)}
          >
            <span class="flex-1 text-sm">{itemTitle(item, view, $t, lang)}</span>
            <span class="text-xs text-gray-500 dark:text-gray-400">{item.photos.length}</span>
          </button>
        {/each}
      {:else if isPlaces}
        <div class="flex items-center gap-2 px-4 py-2">
          <span class="flex-1 text-sm font-medium">{$t('trips_places_title')}</span>
          <Button
            size="tiny"
            variant={placeSort === 'frames' ? 'filled' : 'ghost'}
            color="secondary"
            onclick={() => (placeSort = 'frames')}>{$t('trips_sort_frames')}</Button
          >
          <Button
            size="tiny"
            variant={placeSort === 'name' ? 'filled' : 'ghost'}
            color="secondary"
            onclick={() => (placeSort = 'name')}>{$t('trips_sort_name')}</Button
          >
        </div>
        {#each places as stop (stop.id)}
          {@render stopRow(stop)}
        {/each}
        {#if view.unplaced}
          <button
            type="button"
            class="flex w-full items-baseline gap-3 px-4 py-2 text-start hover:bg-subtle"
            onclick={() => onOpen(view.unplaced!)}
          >
            <span class="flex-1 text-sm">{$t('trips_unplaced')}</span>
            <span class="text-xs text-gray-500 dark:text-gray-400">{view.unplaced.photos.length}</span>
          </button>
        {/if}
      {:else if view.kind === TripKind.Plain}
        {#each view.stops.filter(({ photos }) => isEditing || photos.length > 0) as stop (stop.id)}
          {@render stopRow(stop)}
        {/each}
      {:else}
        {#each days as day (day.date)}
          {#if day.stops.length > 0}
            <div
              class="sticky top-0 z-1 flex items-center gap-2 bg-immich-bg px-4 pt-3 pb-1 text-sm dark:bg-immich-dark-bg"
              data-testid="trip-day"
            >
              <span class="size-2 shrink-0 rounded-full" style:background={day.color}></span>
              <span class="font-medium">{day.label}</span>
              <span class="truncate text-xs text-gray-500 dark:text-gray-400"
                >{day.regions.slice(0, 3).join(' · ')}</span
              >
              <span class="ms-auto text-xs text-gray-500 dark:text-gray-400">{day.count}</span>
            </div>
            {#each day.stops as stop (stop.id)}
              {@render stopRow(stop)}
              {#each view.transit.filter(({ fromStopId }) => fromStopId === stop.id) as way (way.id)}
                <button
                  type="button"
                  class="flex w-full items-baseline gap-3 px-4 py-2 text-start hover:bg-subtle"
                  onclick={() => onOpen(way)}
                >
                  <span class="w-11 shrink-0 text-xs text-gray-500 tabular-nums">{way.t0}</span>
                  <span class="flex-1 text-sm text-gray-600 dark:text-gray-300">{$t('trips_on_the_way')}</span>
                  <span class="text-xs text-gray-500">{way.photos.length}</span>
                </button>
              {/each}
              {#each legsFrom(stop.id) as leg (leg.id)}
                {@render legRow(leg)}
              {/each}
            {/each}
          {/if}
        {/each}
      {/if}
    </div>
  {/if}
</aside>
