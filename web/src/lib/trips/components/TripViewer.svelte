<script lang="ts">
  import { page } from '$app/state';
  import Portal from '$lib/elements/Portal.svelte';
  import { assetViewerManager } from '$lib/managers/asset-viewer-manager.svelte';
  import TripPlain from '$lib/trips/components/TripPlain.svelte';
  import TripRoad, { type RoadView } from '$lib/trips/components/TripRoad.svelte';
  import TripWide, { type PhoneView, type WideView } from '$lib/trips/components/TripWide.svelte';
  import { TripLikes } from '$lib/trips/trip-likes.svelte';
  import '$lib/trips/trip-theme.css';
  import type { TripPhoto, TripView } from '$lib/trips/trip-view';
  import { handlePromiseError } from '$lib/utils';
  import { lazyComponent } from '$lib/utils/lazy-component.svelte';
  import { navigate } from '$lib/utils/navigation';
  import { TripKind } from '@immich/sdk';
  import { Theme, themeManager } from '@immich/ui';
  import { mdiImageMultiple, mdiWeatherNight, mdiWeatherSunny } from '@mdi/js';
  import { MediaQuery } from 'svelte/reactivity';
  import { t } from 'svelte-i18n';

  // The trip viewer (trips PLAN §2.3): the map layout on wide screens and for Places, the road on a phone. One
  // lightbox, Gallery's asset viewer, pages through the whole trip in the viewer's order.

  interface Props {
    view: TripView;
    title: string;
    /** Where the stock album view of this album is */
    albumUrl: string;
  }

  let { view, title, albumUrl }: Props = $props();

  const NARROW = new MediaQuery('max-width: 820px');
  const narrow = $derived(NARROW.current);
  const likes = $derived(new TripLikes(view));

  const params = page.url.searchParams;
  const stopParam = params.get('stop') ?? undefined;
  const viewParam = params.get('view');

  const stored = (key: string) => {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  };
  const store = (key: string, value: string) => {
    try {
      localStorage.setItem(key, value);
    } catch {
      // A private window may refuse storage; the choice then lasts for the page.
    }
  };
  const wideViews: WideView[] = ['map', 'grid', 'photos'];
  const initialWide = (
    wideViews.includes(viewParam as WideView) ? viewParam : (stored('trips:wide-view') ?? 'map')
  ) as WideView;
  const phoneViews: PhoneView[] = ['list', 'grid', 'map'];
  const initialPhone = (
    phoneViews.includes(viewParam as PhoneView) ? viewParam : (stored('trips:places-view') ?? 'grid')
  ) as PhoneView;
  const roadViews: RoadView[] = ['road', 'list', 'grid', 'map'];
  const initialRoad = (
    roadViews.includes(viewParam as RoadView) ? viewParam : (stored('trips:road-view') ?? 'road')
  ) as RoadView;

  /** The current view goes into the URL, without a history entry. */
  const writeView = (value: string, isDefault: boolean) => {
    const url = new URL(location.href);
    if (isDefault) {
      url.searchParams.delete('view');
    } else {
      url.searchParams.set('view', value);
    }
    history.replaceState(history.state, '', url);
  };

  const openPhoto = (photo: TripPhoto) => {
    handlePromiseError(navigate({ targetRoute: 'current', assetId: photo.id }));
  };

  const LazyAssetViewer = lazyComponent(() => import('$lib/components/asset-viewer/AssetViewer.svelte'));
  const index = $derived(view.photos.findIndex(({ id }) => id === assetViewerManager.asset?.id));
  const cursor = $derived({
    current: assetViewerManager.asset!,
    nextAsset: index >= 0 ? view.photos[index + 1]?.asset : undefined,
    previousAsset: index > 0 ? view.photos[index - 1]?.asset : undefined,
  });
  const currentLike = $derived(assetViewerManager.asset ? likes.get(assetViewerManager.asset.id) : undefined);

  const closeLightbox = (assetId: string) => {
    assetViewerManager.showAssetViewer(false);
    handlePromiseError(
      navigate({ targetRoute: 'current', assetId: null }).then(() => {
        const tile = document.querySelector<HTMLElement>(`.trip [data-asset-id="${CSS.escape(assetId)}"]`);
        tile?.scrollIntoView({ block: 'nearest' });
        tile?.focus();
      }),
    );
  };
</script>

<svelte:head>
  <title>{title}</title>
</svelte:head>

{#snippet tools()}
  <a class="tool" href={albumUrl} title={$t('trips_all_photos')} aria-label={$t('trips_all_photos')}>
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"
      ><path d={mdiImageMultiple} fill="currentColor" /></svg
    >
  </a>
  <button
    type="button"
    class="tool"
    title={$t('trips_theme')}
    aria-label={$t('trips_theme')}
    onclick={() => themeManager.toggle()}
  >
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"
      ><path d={themeManager.value === Theme.Dark ? mdiWeatherSunny : mdiWeatherNight} fill="currentColor" /></svg
    >
  </button>
{/snippet}

<div class="trip" data-testid="trip-viewer" data-kind={view.kind}>
  {#if view.kind === TripKind.Plain}
    <TripPlain {view} {title} {likes} onOpenPhoto={openPhoto} {tools} />
  {:else if narrow && view.kind === TripKind.Route}
    <TripRoad
      {view}
      {title}
      {likes}
      initialView={initialRoad}
      initialStopId={stopParam}
      onView={(value) => {
        store('trips:road-view', value);
        writeView(value, value === 'road');
      }}
      onOpenPhoto={openPhoto}
      {tools}
    />
  {:else}
    <TripWide
      {view}
      {title}
      {likes}
      {narrow}
      initialView={initialWide}
      initialPhoneView={initialPhone}
      initialStopId={stopParam}
      onView={(value) => {
        store(narrow ? 'trips:places-view' : 'trips:wide-view', value);
        writeView(value, value === (narrow ? 'grid' : 'map'));
      }}
      onOpenPhoto={openPhoto}
      {tools}
    />
  {/if}
</div>

{#if assetViewerManager.isViewing && assetViewerManager.asset}
  <Portal target="body">
    {#if LazyAssetViewer.current}
      {@const AssetViewer = LazyAssetViewer.current}
      <AssetViewer {cursor} isShared onClose={closeLightbox} />
    {/if}
    {#if currentLike && index >= 0}
      <button
        type="button"
        class="trip-like"
        class:liked={currentLike.isLiked}
        aria-pressed={currentLike.isLiked}
        aria-busy={currentLike.isBusy}
        title={`${$t(currentLike.isLiked ? 'trips_unlike' : 'trips_like')}: ${currentLike.count}`}
        onclick={() => likes.toggle(assetViewerManager.asset!.id)}
      >
        ♥{currentLike.count > 0 ? ` ${currentLike.count}` : ''}
      </button>
    {/if}
  </Portal>
{/if}

<style>
  .trip {
    min-height: 100dvh;
  }
  .tool {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 38px;
    height: 38px;
    border-radius: 9px;
    background: var(--trip-glass);
    border: 1px solid var(--trip-line);
    color: var(--trip-text);
    box-shadow: var(--trip-shadow);
  }
  button.tool {
    cursor: pointer;
  }
  .trip-like {
    position: fixed;
    left: 50%;
    bottom: 18px;
    transform: translateX(-50%);
    z-index: 1001;
    min-width: 44px;
    min-height: 44px;
    padding: 0 16px;
    border-radius: 22px;
    border: 1px solid rgba(255, 255, 255, 0.25);
    background: rgba(8, 10, 13, 0.6);
    color: #d9dee6;
    font-size: 17px;
    cursor: pointer;
    backdrop-filter: blur(6px);
  }
  .trip-like.liked {
    color: #ff5a6e;
  }
  .trip-like[aria-busy='true'] {
    cursor: progress;
  }
</style>
