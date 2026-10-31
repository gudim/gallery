<script lang="ts">
  import { Icon } from '@immich/ui';
  import { mdiMapMarker } from '@mdi/js';
  import { t } from 'svelte-i18n';
  import { Marker } from 'svelte-maplibre';

  // A stop's pin being moved in edit mode (trips PLAN §2.5): dragged on Gallery's map, written only when the owner
  // saves it, as travel-album's pin move waited for confirmation.

  interface Props {
    lngLat: { lng: number; lat: number };
  }

  let { lngLat = $bindable() }: Props = $props();
</script>

<Marker
  draggable
  {lngLat}
  anchor="bottom"
  zIndex={10}
  ondragend={(event) => (lngLat = { lng: event.lngLat[0], lat: event.lngLat[1] })}
>
  <div class="cursor-grab active:cursor-grabbing" aria-label={$t('trips_drag_pin')} data-testid="trip-pin-drag">
    <Icon icon={mdiMapMarker} size="48" class="text-primary drop-shadow-lg" />
  </div>
</Marker>
