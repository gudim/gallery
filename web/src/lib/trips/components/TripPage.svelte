<script lang="ts">
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import ControlAppBar from '$lib/components/shared-components/ControlAppBar.svelte';
  import ThemeButton from '$lib/components/shared-components/ThemeButton.svelte';
  import AssetSelectControlBar from '$lib/components/timeline/AssetSelectControlBar.svelte';
  import Portal from '$lib/elements/Portal.svelte';
  import { assetMultiSelectManager } from '$lib/managers/asset-multi-select-manager.svelte';
  import { assetViewerManager } from '$lib/managers/asset-viewer-manager.svelte';
  import { mediaQueryManager } from '$lib/stores/media-query-manager.svelte';
  import TripAssetActions from '$lib/trips/components/TripAssetActions.svelte';
  import TripPanel from '$lib/trips/components/TripPanel.svelte';
  import TripPinDrag from '$lib/trips/components/TripPinDrag.svelte';
  import TripRoad from '$lib/trips/components/TripRoad.svelte';
  import TripRouteLayers from '$lib/trips/components/TripRouteLayers.svelte';
  import { loadTrip } from '$lib/trips/trip-data';
  import type { TripEditor } from '$lib/trips/trip-editor.svelte';
  import { TripLikes } from '$lib/trips/trip-likes.svelte';
  import type { TripItem, TripTransit, TripViewStop } from '$lib/trips/trip-view';
  import { handleError } from '$lib/utils/handle-error';
  import { lazyComponent } from '$lib/utils/lazy-component.svelte';
  import { TripKind, updateStop, type MapMarkerResponseDto } from '@immich/sdk';
  import { Button, IconButton, LoadingSpinner } from '@immich/ui';
  import {
    mdiArrowLeft,
    mdiCheck,
    mdiHeart,
    mdiHeartOutline,
    mdiMapOutline,
    mdiPencilOutline,
    mdiRoadVariant,
  } from '@mdi/js';
  import type { Map } from 'maplibre-gl';
  import { onDestroy, untrack } from 'svelte';
  import { t } from 'svelte-i18n';

  // A trip (trips PLAN §2.3): Gallery's map with the route and its stops, the panel of stops beside it (below it on a
  // phone), and on a phone the road as the other view. Opened from the album's map button. Owners and editors get an
  // edit mode (§2.5): stop actions in the panel, pins dragged on the map, assets picked in the stop's timeline.

  interface Props {
    albumId: string;
    albumName: string;
    /** The album view this page came from */
    albumUrl: string;
    /** The album's owner or an editor */
    canEdit?: boolean;
  }

  let { albumId, albumName, albumUrl, canEdit = false }: Props = $props();

  let editor = $state<TripEditor | null>();
  let likes = $state<TripLikes>();
  let isEditing = $state(false);
  const view = $derived(editor === undefined ? undefined : (editor?.view ?? null));

  $effect(() => {
    const id = albumId;
    untrack(() => {
      editor?.destroy();
      editor = undefined;
      loadTrip(id)
        .then((result) => {
          editor = result;
          likes = result?.view ? new TripLikes(result.view) : undefined;
        })
        .catch((error: unknown) => {
          editor = null;
          handleError(error, $t('trips_load_failed'));
        });
    });
  });
  onDestroy(() => editor?.destroy());

  const isPhone = $derived(mediaQueryManager.maxMd);
  const hasMap = $derived(view?.kind !== TripKind.Plain);
  const canRoad = $derived(view?.kind === TripKind.Route);

  const stored = (key: string) => {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  };
  let phoneView = $state<'map' | 'road'>(stored('trips:phone-view') === 'map' ? 'map' : 'road');
  const setPhoneView = (next: 'map' | 'road') => {
    phoneView = next;
    try {
      localStorage.setItem('trips:phone-view', next);
    } catch {
      // A private window may refuse storage; the choice then lasts for the page.
    }
  };
  const showRoad = $derived(isPhone && canRoad && phoneView === 'road' && !isEditing);

  let openId = $state<string | undefined>(page.url.searchParams.get('stop') ?? undefined);
  let openLegId = $state<string>();
  let pickedIds = $state<string[]>();
  let map = $state<Map>();
  /** The stop whose pin is being dragged, and where it is now */
  let moving = $state<{ stopId: string; lngLat: { lng: number; lat: number } }>();

  /** `?stop=` follows the opened stop, without a history entry. */
  const writeStop = (id: string | undefined) => {
    const url = new URL(location.href);
    if (id) {
      url.searchParams.set('stop', id);
    } else {
      url.searchParams.delete('stop');
    }
    history.replaceState(history.state, '', url);
  };

  const flyTo = (id: string | undefined) => {
    const item = id ? view?.order.find((candidate) => candidate.id === id) : undefined;
    if (map && item && item.type !== 'unplaced' && item.latitude !== null && item.longitude !== null) {
      map.easeTo({ center: [item.longitude, item.latitude], zoom: Math.max(map.getZoom(), 12) });
    }
  };

  const open = (item: TripItem) => {
    if (openId !== item.id) {
      assetMultiSelectManager.clear();
    }
    openId = item.id;
    openLegId = undefined;
    moving = undefined;
    pickedIds = undefined;
    writeStop(item.id);
    flyTo(item.id);
  };

  const back = () => {
    assetMultiSelectManager.clear();
    openId = undefined;
    openLegId = undefined;
    moving = undefined;
    writeStop(undefined);
  };

  const openLeg = (legId: string) => {
    back();
    openLegId = legId;
  };

  const toggleEditing = () => {
    isEditing = !isEditing;
    moving = undefined;
    openLegId = undefined;
    assetMultiSelectManager.clear();
  };

  const startMoving = (stop: TripViewStop) => {
    if (stop.latitude !== null && stop.longitude !== null) {
      moving = { stopId: stop.id, lngLat: { lng: stop.longitude, lat: stop.latitude } };
    }
  };

  const saveMoving = async () => {
    if (!moving || !editor) {
      return;
    }
    const { stopId, lngLat } = moving;
    const isSaved = await editor.run(
      (id) => updateStop({ id, stopId, tripStopUpdateDto: { latitude: lngLat.lat, longitude: lngLat.lng } }),
      $t('trips_edit_failed'),
    );
    if (isSaved) {
      moving = undefined;
    }
  };

  /** The stop or item the picked assets came from */
  const selectionItem = $derived(openId ? view?.order.find(({ id }) => id === openId) : undefined);

  type Located = (TripViewStop | TripTransit) & { latitude: number; longitude: number };
  const isLocated = (item: TripItem): item is Located =>
    item.type !== 'unplaced' && item.latitude !== null && item.longitude !== null && item.photos.length > 0;

  /** Stops are Gallery's asset markers: one per stop with assets, showing its first asset. */
  const markers = $derived(
    (view?.order ?? []).filter(isLocated).map((item): MapMarkerResponseDto => ({
      id: item.photos[0].id,
      lat: item.latitude,
      lon: item.longitude,
      city: item.type === 'stop' ? item.title || item.region || null : null,
      state: null,
      country: item.type === 'stop' ? item.country || null : null,
    })),
  );
  const itemByMarker = $derived(new globalThis.Map(view?.order.map((item) => [item.photos[0]?.id, item]) ?? []));

  const onSelect = (assetIds: string[]) => {
    const items = assetIds.map((id) => itemByMarker.get(id)).filter((item) => item !== undefined);
    if (items.length === 1) {
      open(items[0]);
    } else if (items.length > 1) {
      openId = undefined;
      pickedIds = items.map(({ id }) => id);
    }
  };

  const currentLike = $derived(
    assetViewerManager.isViewing &&
      assetViewerManager.asset &&
      view?.photos.some(({ id }) => id === assetViewerManager.asset!.id)
      ? likes?.get(assetViewerManager.asset.id)
      : undefined,
  );

  const LazyMap = lazyComponent(() => import('$lib/components/shared-components/map/Map.svelte'));
</script>

<svelte:head>
  <title>{albumName}</title>
</svelte:head>

<div class="flex h-dvh flex-col bg-immich-bg dark:bg-immich-dark-bg" data-testid="trip-page">
  {#if isEditing && editor && selectionItem && assetMultiSelectManager.selectionActive}
    <AssetSelectControlBar>
      <TripAssetActions
        {editor}
        item={selectionItem}
        onMoved={(stopId) => {
          const target = stopId ? view?.order.find(({ id }) => id === stopId) : undefined;
          if (target) {
            open(target);
          }
        }}
      />
    </AssetSelectControlBar>
  {:else}
    <ControlAppBar backIcon={mdiArrowLeft} onClose={() => goto(albumUrl)} title={albumName}>
      {#snippet trailing()}
        {#if canEdit && view && isPhone}
          <IconButton
            shape="round"
            variant={isEditing ? 'filled' : 'ghost'}
            color={isEditing ? 'primary' : 'secondary'}
            aria-label={isEditing ? $t('done') : $t('edit')}
            icon={isEditing ? mdiCheck : mdiPencilOutline}
            onclick={toggleEditing}
            data-testid="trip-edit-toggle"
          />
        {:else if canEdit && view}
          <Button
            size="small"
            shape="round"
            variant={isEditing ? 'filled' : 'ghost'}
            color={isEditing ? 'primary' : 'secondary'}
            leadingIcon={isEditing ? mdiCheck : mdiPencilOutline}
            onclick={toggleEditing}
            data-testid="trip-edit-toggle"
          >
            {isEditing ? $t('done') : $t('edit')}
          </Button>
        {/if}
        {#if isPhone && canRoad && !isEditing}
          <IconButton
            shape="round"
            variant="ghost"
            color="secondary"
            aria-label={phoneView === 'road' ? $t('trips_view_map') : $t('trips_view_road')}
            icon={phoneView === 'road' ? mdiMapOutline : mdiRoadVariant}
            onclick={() => setPhoneView(phoneView === 'road' ? 'map' : 'road')}
          />
        {/if}
        <ThemeButton />
      {/snippet}
    </ControlAppBar>
  {/if}

  <div class="min-h-0 flex-1 pt-(--navbar-height) max-md:pt-(--navbar-height-md)">
    {#if view === undefined}
      <div class="flex size-full items-center justify-center"><LoadingSpinner /></div>
    {:else if view === null}
      <p class="p-8 text-center">{$t('trips_no_trip')}</p>
    {:else if showRoad}
      <TripRoad {view} title={albumName} onOpen={(item) => (setPhoneView('map'), open(item))} />
    {:else}
      {@const trip = view}
      <div class="flex size-full flex-col sm:flex-row">
        {#if hasMap}
          <div
            class={['relative min-h-0 w-full sm:h-full sm:w-2/3', isEditing && !moving ? 'h-1/3' : 'h-1/2']}
            data-testid="trip-map"
          >
            {#if LazyMap.current}
              {@const GalleryMap = LazyMap.current}
              <GalleryMap mapMarkers={markers} showSettings={false} {onSelect}>
                {#snippet layers({ map: instance })}
                  <TripRouteLayers
                    map={instance}
                    view={trip}
                    onReady={(ready) => {
                      map = ready;
                      flyTo(openId);
                    }}
                  />
                  {#if moving}
                    <TripPinDrag bind:lngLat={moving.lngLat} />
                  {/if}
                {/snippet}
              </GalleryMap>
            {/if}
            {#if moving}
              <div
                class="absolute inset-x-0 bottom-3 z-10 mx-auto flex w-fit items-center gap-2 rounded-full bg-light py-1.5 ps-4 pe-1.5 whitespace-nowrap shadow-lg sm:bottom-8"
                data-testid="trip-pin-bar"
              >
                <span class="text-sm">{$t('trips_drag_pin')}</span>
                <Button size="small" shape="round" color="secondary" onclick={() => (moving = undefined)}
                  >{$t('cancel')}</Button
                >
                <Button size="small" shape="round" disabled={editor?.isBusy} onclick={saveMoving}>{$t('save')}</Button>
              </div>
            {/if}
          </div>
        {/if}
        <!-- On a phone the edit panel takes more room, and gives it back to the map while a pin is moved. -->
        <div
          class={[
            'min-h-0 w-full',
            hasMap ? 'sm:h-full sm:w-1/3' : 'h-full',
            hasMap && (isEditing && !moving ? 'h-2/3' : 'h-1/2'),
          ]}
        >
          <TripPanel
            {view}
            editor={isEditing && editor ? editor : undefined}
            {openId}
            {openLegId}
            {pickedIds}
            onOpen={open}
            onOpenLeg={openLeg}
            onBack={back}
            onClearPicked={() => (pickedIds = undefined)}
            onMovePin={startMoving}
          />
        </div>
      </div>
    {/if}
  </div>
</div>

{#if currentLike && likes}
  <Portal target="body">
    <div class="fixed bottom-4 left-1/2 z-1001 -translate-x-1/2">
      <Button
        shape="round"
        color="secondary"
        leadingIcon={currentLike.isLiked ? mdiHeart : mdiHeartOutline}
        aria-pressed={currentLike.isLiked}
        aria-label={$t(currentLike.isLiked ? 'trips_unlike' : 'trips_like')}
        disabled={currentLike.isBusy}
        onclick={() => likes?.toggle(assetViewerManager.asset!.id)}
        data-testid="trip-like"
      >
        {currentLike.count}
      </Button>
    </div>
  </Portal>
{/if}
