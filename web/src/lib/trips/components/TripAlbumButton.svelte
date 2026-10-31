<script lang="ts">
  import { getTrip } from '@immich/sdk';
  import { IconButton } from '@immich/ui';
  import { mdiMapMarkerPath } from '@mdi/js';
  import { t } from 'svelte-i18n';

  // The album page's way into the trip viewer, shown only when the album has a trip.

  interface Props {
    albumId: string;
  }

  let { albumId }: Props = $props();

  let hasTrip = $state(false);

  const check = async (id: string) => {
    try {
      const trip = await getTrip({ id });
      hasTrip = !!trip && id === albumId;
    } catch {
      hasTrip = false;
    }
  };

  $effect(() => {
    hasTrip = false;
    void check(albumId);
  });
</script>

{#if hasTrip}
  <IconButton
    shape="round"
    variant="ghost"
    color="secondary"
    aria-label={$t('trips_open_trip')}
    href="/trips/{albumId}"
    icon={mdiMapMarkerPath}
  />
{/if}
