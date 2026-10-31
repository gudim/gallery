<script lang="ts">
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import AlbumMap from '$lib/components/album-page/AlbumMap.svelte';
  import type { FilterState } from '$lib/components/filter-panel/filter-panel';
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import { isAlbumOwner } from '$lib/services/album.service';
  import TripCreateModal from '$lib/trips/components/TripCreateModal.svelte';
  import { getTrip, type AlbumResponseDto } from '@immich/sdk';
  import { IconButton, modalManager } from '@immich/ui';
  import { mdiMapMarkerPath, mdiMapOutline } from '@mdi/js';
  import { t } from 'svelte-i18n';

  // The album's map button (trips PLAN §2.3): an album with a trip opens the trip; any other album gets Gallery's map,
  // and its owner a button that makes a trip of it (§2.5).

  interface Props {
    album: AlbumResponseDto;
    filters?: FilterState;
    /** Whether Gallery would show its album map here */
    showAlbumMap: boolean;
  }

  let { album, filters, showAlbumMap }: Props = $props();

  let hasTrip = $state<boolean>();

  const check = async (id: string) => {
    try {
      const trip = await getTrip({ id, ...authManager.params });
      hasTrip = !!trip;
    } catch {
      hasTrip = false;
    }
  };

  $effect(() => {
    hasTrip = undefined;
    void check(album.id);
  });

  const tripUrl = $derived(
    authManager.isSharedLink ? `${page.url.pathname.replace(/\/photos\/[^/]+$/, '')}/trip` : `/trips/${album.id}`,
  );

  const canCreate = $derived(!authManager.isSharedLink && album.assetCount > 0 && isAlbumOwner(album));

  const onCreate = async () => {
    if (await modalManager.show(TripCreateModal, { albumId: album.id })) {
      await goto(`/trips/${album.id}`);
    }
  };
</script>

{#if hasTrip}
  <IconButton
    shape="round"
    variant="ghost"
    color="secondary"
    aria-label={$t('trips_open_trip')}
    href={tripUrl}
    icon={mdiMapOutline}
    data-testid="trip-map-button"
  />
{:else if hasTrip === false}
  {#if showAlbumMap}
    <AlbumMap {album} {filters} />
  {/if}
  {#if canCreate}
    <IconButton
      shape="round"
      variant="ghost"
      color="secondary"
      aria-label={$t('trips_create_title')}
      title={$t('trips_create_title')}
      icon={mdiMapMarkerPath}
      onclick={onCreate}
      data-testid="trip-create-button"
    />
  {/if}
{/if}
