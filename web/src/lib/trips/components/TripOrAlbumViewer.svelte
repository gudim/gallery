<script lang="ts">
  import { page } from '$app/state';
  import AlbumViewer from '$lib/components/album-page/AlbumViewer.svelte';
  import TripViewer from '$lib/trips/components/TripViewer.svelte';
  import { loadTripView } from '$lib/trips/trip-data';
  import type { TripView } from '$lib/trips/trip-view';
  import { handleError } from '$lib/utils/handle-error';
  import type { AlbumResponseDto, SharedLinkResponseDto } from '@immich/sdk';
  import { untrack } from 'svelte';
  import { t } from 'svelte-i18n';

  // The shared link of an album with a trip opens the trip viewer (trips DECISIONS-LOG 2026-10-31); `?album` and an
  // album without a trip get Gallery's album view.

  interface Props {
    sharedLink: SharedLinkResponseDto;
  }

  let { sharedLink }: Props = $props();

  const album = $derived(sharedLink.album as AlbumResponseDto);
  const showAlbum = $derived(page.url.searchParams.has('album'));
  let view = $state<TripView | null>();

  const albumId = $derived(album.id);

  // Loaded once per album: opening an asset changes the route's params, which must not reload the trip.
  $effect(() => {
    const id = albumId;
    untrack(() => {
      view = undefined;
      loadTripView(id)
        .then((result) => (view = result))
        .catch((error: unknown) => {
          view = null;
          handleError(error, $t('trips_load_failed'));
        });
    });
  });

  const albumUrl = $derived(`${page.url.pathname.replace(/\/photos\/[^/]+$/, '')}?album`);
</script>

{#if showAlbum || view === null}
  <AlbumViewer {sharedLink} />
{:else if view}
  <TripViewer {view} title={album.albumName} {albumUrl} />
{/if}
