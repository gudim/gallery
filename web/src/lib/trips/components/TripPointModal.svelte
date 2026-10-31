<script lang="ts">
  import type Map from '$lib/components/shared-components/map/Map.svelte';
  import { timeDebounceOnSearch } from '$lib/constants';
  import { handleError } from '$lib/utils/handle-error';
  import { lazyComponent } from '$lib/utils/lazy-component.svelte';
  import { reverseTripPlace, searchTripPlaces, type TripGeoPlaceDto } from '@immich/sdk';
  import { ConfirmModal, Field, Input, LoadingSpinner } from '@immich/ui';
  import { mdiMagnify, mdiMapMarkerOutline } from '@mdi/js';
  import { t } from 'svelte-i18n';

  // Picks a point for a trip (trips PLAN §2.5): a place found through Nominatim in the trip's language, or a click on
  // Gallery's map, as Gallery's own location picker does. A point that takes a name proposes the place's name.

  export type TripPoint = { latitude: number; longitude: number; title: string };

  type Props = {
    albumId: string;
    title: string;
    /** Where the map opens, and the point already set */
    point?: { latitude: number; longitude: number };
    /** The point takes a name (a stop); an asset's point does not */
    isNamed?: boolean;
    onClose: (point?: TripPoint) => void;
  };

  let { albumId, title, point: initial, isNamed = false, onClose }: Props = $props();

  let point = $state(initial ? { lat: initial.latitude, lng: initial.longitude } : undefined);
  let name = $state('');
  let query = $state('');
  let places = $state<TripGeoPlaceDto[]>([]);
  let isSearching = $state(false);
  let mapElement = $state<ReturnType<typeof Map>>();
  const center = initial ? { lat: initial.latitude, lng: initial.longitude } : undefined;

  $effect(() => {
    if (mapElement && initial) {
      mapElement.addClipMapMarker(initial.longitude, initial.latitude);
    }
  });

  let searchTimer: ReturnType<typeof setTimeout> | undefined;
  let searchId = 0;
  const onSearch = () => {
    clearTimeout(searchTimer);
    const text = query.trim();
    if (!text) {
      places = [];
      isSearching = false;
      return;
    }
    isSearching = true;
    searchTimer = setTimeout(() => {
      const id = ++searchId;
      searchTripPlaces({ id: albumId, query: text })
        .then((result) => {
          if (id === searchId) {
            places = result.places;
          }
        })
        .catch((error: unknown) => id === searchId && handleError(error, $t('trips_place_search_failed')))
        .finally(() => id === searchId && (isSearching = false));
    }, timeDebounceOnSearch);
  };

  const pick = (lat: number, lng: number, label?: string) => {
    point = { lat, lng };
    mapElement?.addClipMapMarker(lng, lat);
    if (!isNamed) {
      return;
    }
    if (label !== undefined) {
      name = label;
      return;
    }
    // A point clicked on the map takes the name Nominatim gives it, until the owner types one.
    const typed = name;
    reverseTripPlace({ id: albumId, latitude: lat, longitude: lng })
      .then(({ places: [place] }) => {
        if (place && name === typed && point?.lat === lat && point.lng === lng) {
          name = place.label;
        }
      })
      .catch(() => {
        // Without a name the point is left to naming.
      });
  };

  const onPlace = (place: TripGeoPlaceDto) => {
    places = [];
    query = '';
    pick(place.latitude, place.longitude, place.label);
  };

  const LazyMap = lazyComponent(() => import('$lib/components/shared-components/map/Map.svelte'));
</script>

<ConfirmModal
  confirmColor="primary"
  {title}
  icon={mdiMapMarkerOutline}
  size="medium"
  disabled={!point}
  onClose={(confirmed) =>
    onClose(confirmed && point ? { latitude: point.lat, longitude: point.lng, title: name.trim() } : undefined)}
>
  {#snippet prompt()}
    <div class="flex w-full flex-col gap-3 text-start" data-testid="trip-point-modal">
      <div class="relative z-2">
        <Input
          bind:value={query}
          oninput={onSearch}
          leadingIcon={mdiMagnify}
          placeholder={$t('trips_point_search')}
          aria-label={$t('trips_point_search')}
          data-testid="trip-point-search"
        />
        {#if isSearching || places.length > 0}
          <div
            class="absolute inset-x-0 top-full mt-1 overflow-hidden rounded-xl border border-gray-200 bg-light shadow-lg dark:border-immich-dark-gray"
          >
            {#if isSearching && places.length === 0}
              <div class="flex justify-center p-3"><LoadingSpinner /></div>
            {/if}
            {#each places as place (`${place.latitude},${place.longitude}`)}
              <button
                type="button"
                class="block w-full px-4 py-2 text-start hover:bg-subtle focus:bg-subtle focus:outline-none"
                onclick={() => onPlace(place)}
              >
                <span class="block truncate text-sm">{place.label}</span>
                <span class="block truncate text-xs text-gray-500 dark:text-gray-400"
                  >{[place.region, place.country].filter(Boolean).join(', ')}</span
                >
              </button>
            {/each}
          </div>
        {/if}
      </div>
      <p class="text-sm text-gray-600 dark:text-gray-300">{$t('trips_point_hint')}</p>
      <div class="z-0 h-80 w-full sm:h-100">
        {#if LazyMap.current}
          {@const GalleryMap = LazyMap.current}
          <GalleryMap
            bind:this={mapElement}
            mapMarkers={[]}
            zoom={center ? 12 : 1}
            {center}
            simplified
            clickable
            onClickPoint={({ lat, lng }) => pick(lat, lng)}
            showSettings={false}
            rounded
          />
        {/if}
      </div>
      {#if isNamed}
        <Field label={$t('trips_point_name')}>
          <Input bind:value={name} placeholder={$t('trips_point_name_hint')} data-testid="trip-point-name" />
        </Field>
      {/if}
    </div>
  {/snippet}
</ConfirmModal>
