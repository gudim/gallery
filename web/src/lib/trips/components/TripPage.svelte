<script lang="ts">
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import ControlAppBar from '$lib/components/shared-components/ControlAppBar.svelte';
  import ThemeButton from '$lib/components/shared-components/ThemeButton.svelte';
  import Portal from '$lib/elements/Portal.svelte';
  import { assetViewerManager } from '$lib/managers/asset-viewer-manager.svelte';
  import { mediaQueryManager } from '$lib/stores/media-query-manager.svelte';
  import TripPanel from '$lib/trips/components/TripPanel.svelte';
  import TripRoad from '$lib/trips/components/TripRoad.svelte';
  import TripRouteLayers from '$lib/trips/components/TripRouteLayers.svelte';
  import { loadTripView } from '$lib/trips/trip-data';
  import { TripLikes } from '$lib/trips/trip-likes.svelte';
  import type { TripItem, TripTransit, TripView, TripViewStop } from '$lib/trips/trip-view';
  import { handleError } from '$lib/utils/handle-error';
  import { lazyComponent } from '$lib/utils/lazy-component.svelte';
  import { TripKind, type MapMarkerResponseDto } from '@immich/sdk';
  import { Button, IconButton, LoadingSpinner } from '@immich/ui';
  import { mdiArrowLeft, mdiHeart, mdiHeartOutline, mdiMapOutline, mdiRoadVariant } from '@mdi/js';
  import type { Map } from 'maplibre-gl';
  import { untrack } from 'svelte';
  import { t } from 'svelte-i18n';

  // A trip (trips PLAN §2.3): Gallery's map with the route and its stops, the panel of stops beside it (below it on a
  // phone), and on a phone the road as the other view. Opened from the album's map button.

  interface Props {
    albumId: string;
    albumName: string;
    /** The album view this page came from */
    albumUrl: string;
  }

  let { albumId, albumName, albumUrl }: Props = $props();

  let view = $state<TripView | null>();
  let likes = $state<TripLikes>();

  $effect(() => {
    const id = albumId;
    untrack(() => {
      view = undefined;
      loadTripView(id)
        .then((result) => {
          view = result;
          likes = result ? new TripLikes(result) : undefined;
        })
        .catch((error: unknown) => {
          view = null;
          handleError(error, $t('trips_load_failed'));
        });
    });
  });

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
  const showRoad = $derived(isPhone && canRoad && phoneView === 'road');

  let openId = $state<string | undefined>(page.url.searchParams.get('stop') ?? undefined);
  let pickedIds = $state<string[]>();
  let map = $state<Map>();

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
    openId = item.id;
    pickedIds = undefined;
    writeStop(item.id);
    flyTo(item.id);
  };

  const back = () => {
    openId = undefined;
    writeStop(undefined);
  };

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
  <ControlAppBar backIcon={mdiArrowLeft} onClose={() => goto(albumUrl)} title={albumName}>
    {#snippet trailing()}
      {#if isPhone && canRoad}
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
          <div class="relative h-1/2 min-h-0 w-full sm:h-full sm:w-2/3" data-testid="trip-map">
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
                {/snippet}
              </GalleryMap>
            {/if}
          </div>
        {/if}
        <div class={['min-h-0 w-full', hasMap ? 'h-1/2 sm:h-full sm:w-1/3' : 'h-full']}>
          <TripPanel
            {view}
            {openId}
            {pickedIds}
            onOpen={open}
            onBack={back}
            onClearPicked={() => (pickedIds = undefined)}
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
