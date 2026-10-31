<script lang="ts">
  import TripViewer from '$lib/trips/components/TripViewer.svelte';
  import { loadTripView } from '$lib/trips/trip-data';
  import type { TripView } from '$lib/trips/trip-view';
  import { Route } from '$lib/route';
  import { handleError } from '$lib/utils/handle-error';
  import type { AlbumResponseDto } from '@immich/sdk';
  import { untrack } from 'svelte';
  import { t } from 'svelte-i18n';

  // A signed-in user's trip viewer at /trips/{albumId}; the album page links here when the album has a trip.

  interface Props {
    album: AlbumResponseDto;
  }

  let { album }: Props = $props();

  const albumId = $derived(album.id);
  let view = $state<TripView | null>();

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
</script>

{#if view}
  <TripViewer {view} title={album.albumName} albumUrl={Route.viewAlbum({ id: album.id })} />
{:else if view === null}
  <p class="p-8 text-center">{$t('trips_no_trip')}</p>
{/if}
