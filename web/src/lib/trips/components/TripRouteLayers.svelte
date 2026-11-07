<script lang="ts">
  import { BADGE_MODES, MODE_ICONS } from '$lib/trips/trip-map';
  import { alongLine, inkOn, PLACES_COLOR, type TripView } from '$lib/trips/trip-view';
  import { TripKind, TripLegMode, TripOverlayKind } from '@immich/sdk';
  import { Icon } from '@immich/ui';
  import type { Feature, LineString, Point, Position } from 'geojson';
  import { LngLatBounds, type DataDrivenPropertyValueSpecification, type Map } from 'maplibre-gl';
  import { onMount } from 'svelte';
  import { t } from 'svelte-i18n';
  import { CircleLayer, GeoJSON, LineLayer, Marker } from 'svelte-maplibre';

  // A trip's route on Gallery's map (trips PLAN §2.3): legs coloured by day and styled by mode, each with its mode's
  // badge, the start and finish, and trails. Stops themselves are Gallery's own asset markers, passed to the map by the
  // trip page.

  interface Props {
    map: Map;
    view: TripView;
    onReady?: (map: Map) => void;
    /** Set in edit mode: a leg's badge opens the leg. */
    onOpenLeg?: (legId: string) => void;
    /** The leg opened in edit mode: it glows, and the other legs fade. */
    openLegId?: string;
  }

  let { map, view, onReady, onOpenLeg, openLegId }: Props = $props();

  // How much of its own opacity a leg keeps while another leg is open.
  const FADED = 0.35;

  type LineStyle = { width: number; opacity: number; dash?: number[] };
  // Widths in px and dashes in line widths, after travel-album's leg styles.
  const STYLES: Record<TripLegMode, LineStyle> = {
    [TripLegMode.Driving]: { width: 3.4, opacity: 0.85 },
    [TripLegMode.Flight]: { width: 2.6, opacity: 0.8, dash: [3.8, 2.3] },
    [TripLegMode.Foot]: { width: 3, opacity: 0.85, dash: [0.01, 1.7] },
    [TripLegMode.Direct]: { width: 2, opacity: 0.45, dash: [2.5, 3.5] },
    [TripLegMode.Bus]: { width: 2.4, opacity: 0.85 },
    [TripLegMode.Bicycle]: { width: 3, opacity: 0.85, dash: [1.3, 1.3] },
    [TripLegMode.Train]: { width: 3.6, opacity: 0.9, dash: [3, 0.6] },
    [TripLegMode.Boat]: { width: 2.6, opacity: 0.85, dash: [5.4, 3.8] },
    [TripLegMode.Trail]: { width: 3, opacity: 0.85 },
  };
  const modes = Object.keys(STYLES) as TripLegMode[];

  const colorOf = (day: number) =>
    view.kind === TripKind.Places ? PLACES_COLOR : (view.days[day]?.color ?? PLACES_COLOR);

  const legs = $derived({
    type: 'FeatureCollection' as const,
    features: view.legs.map((leg): Feature<LineString> => ({
      type: 'Feature',
      geometry: { type: 'LineString', coordinates: leg.points.map(([lat, lng]) => [lng, lat]) },
      properties: { id: leg.id, mode: leg.mode, color: leg.color },
    })),
  });

  const openLeg = $derived({
    type: 'FeatureCollection' as const,
    features: legs.features.filter(({ properties }) => openLegId && properties?.id === openLegId),
  });
  const legOpacity = (opacity: number): DataDrivenPropertyValueSpecification<number> =>
    openLegId ? ['case', ['==', ['get', 'id'], openLegId], opacity, opacity * FADED] : opacity;

  const ends = $derived({
    type: 'FeatureCollection' as const,
    features: view.stops
      .filter(({ isEnd, latitude, longitude }) => isEnd && latitude !== null && longitude !== null)
      .map((stop): Feature<Point> => ({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [stop.longitude!, stop.latitude!] },
        properties: { color: colorOf(stop.day) },
      })),
  });

  const TRAIL_COLORS: Record<string, string> = { green: '#3ddc84', yellow: '#ffd400' };
  const trails = $derived({
    type: 'FeatureCollection' as const,
    features: view.overlays
      .filter(({ kind, geometry }) => kind === TripOverlayKind.Trail && geometry.type === 'LineString')
      .map((overlay): Feature<LineString> => ({
        type: 'Feature',
        geometry: overlay.geometry as unknown as LineString,
        properties: { color: TRAIL_COLORS[overlay.color ?? ''] ?? overlay.color ?? TRAIL_COLORS.green },
      })),
  });

  // A leg's badge sits at its middle, or a quarter along when assets shot on the way are near the middle; it hides
  // while the leg is shorter than ~90 px on screen (travel-album map.js layoutBadges).
  const badges = $derived(
    view.legs
      .filter(({ mode }) => BADGE_MODES.has(mode))
      .map((leg) => {
        const way = view.transit.find(
          ({ fromStopId, toStopId }) => fromStopId === leg.fromStopId && toStopId === leg.toStopId,
        );
        const fraction = way && Math.abs(way.fraction - 0.5) < 0.15 ? (way.fraction < 0.5 ? 0.75 : 0.25) : 0.5;
        return { leg, ...alongLine(leg.points, fraction) };
      }),
  );
  let zoom = $state(map.getZoom());
  const isShown = ({ at: [lat], meters }: { at: [number, number]; meters: number }) =>
    meters / ((40_075_016.686 * Math.cos((lat * Math.PI) / 180)) / 2 ** (zoom + 8)) >= 90;

  onMount(() => {
    const onZoom = () => (zoom = map.getZoom());
    map.on('zoom', onZoom);
    // The map fits the stops with assets; the start, finish and legs may reach further.
    const bounds = new LngLatBounds();
    const extend = (point: Position) => bounds.extend(point as [number, number]);
    for (const stop of view.stops) {
      if (stop.latitude !== null && stop.longitude !== null) {
        extend([stop.longitude, stop.latitude]);
      }
    }
    if (!bounds.isEmpty()) {
      map.fitBounds(bounds, { padding: 50, maxZoom: 15, animate: false });
    }
    onReady?.(map);
    return () => map.off('zoom', onZoom);
  });
</script>

<GeoJSON id="trip-trails" data={trails}>
  <LineLayer
    id="trip-trails"
    layout={{ 'line-cap': 'round', 'line-join': 'round' }}
    paint={{ 'line-color': ['get', 'color'], 'line-width': 3.4, 'line-opacity': 0.9 }}
  />
</GeoJSON>

<GeoJSON id="trip-leg-open" data={openLeg}>
  <LineLayer
    id="trip-leg-open"
    layout={{ 'line-cap': 'round', 'line-join': 'round' }}
    paint={{ 'line-color': ['get', 'color'], 'line-width': 12, 'line-opacity': 0.35, 'line-blur': 2 }}
  />
</GeoJSON>

<GeoJSON id="trip-legs" data={legs}>
  {#each modes as mode (mode)}
    <LineLayer
      id="trip-legs-{mode}"
      filter={['==', ['get', 'mode'], mode]}
      layout={{ 'line-cap': 'round', 'line-join': 'round' }}
      paint={{
        'line-color': ['get', 'color'],
        'line-width': STYLES[mode].width,
        'line-opacity': legOpacity(STYLES[mode].opacity),
        ...(STYLES[mode].dash && { 'line-dasharray': STYLES[mode].dash }),
      }}
    />
  {/each}
</GeoJSON>

<GeoJSON id="trip-ends" data={ends}>
  <CircleLayer
    id="trip-ends"
    paint={{
      'circle-radius': 6,
      'circle-color': '#ffffff',
      'circle-stroke-color': ['get', 'color'],
      'circle-stroke-width': 3,
    }}
  />
</GeoJSON>

{#each badges as badge (badge.leg.id)}
  {#if isShown(badge)}
    {@const leg = badge.leg}
    <Marker lngLat={{ lat: badge.at[0], lng: badge.at[1] }}>
      <svelte:element
        this={onOpenLeg ? 'button' : 'div'}
        type={onOpenLeg ? 'button' : undefined}
        role={onOpenLeg ? undefined : 'img'}
        class={[
          'flex size-7 items-center justify-center rounded-full border-2 border-white shadow-md',
          onOpenLeg && 'cursor-pointer',
        ]}
        style:background={leg.color}
        style:color={inkOn(leg.color)}
        title={$t(`trips_mode_${leg.mode}`)}
        aria-label={$t(`trips_mode_${leg.mode}`)}
        onclick={() => onOpenLeg?.(leg.id)}
        data-testid="trip-leg-badge"
      >
        <Icon icon={MODE_ICONS[leg.mode]} size="16" />
      </svelte:element>
    </Marker>
  {/if}
{/each}
