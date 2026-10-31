<script lang="ts">
  import { PLACES_COLOR, type TripView } from '$lib/trips/trip-view';
  import { TripKind, TripLegMode, TripOverlayKind } from '@immich/sdk';
  import type { Feature, LineString, Point, Position } from 'geojson';
  import { LngLatBounds, type Map } from 'maplibre-gl';
  import { onMount } from 'svelte';
  import { CircleLayer, GeoJSON, LineLayer } from 'svelte-maplibre';

  // A trip's route on Gallery's map (trips PLAN §2.3): legs coloured by day and styled by mode, the start and finish,
  // and trails. Stops themselves are Gallery's own asset markers, passed to the map by the trip page.

  interface Props {
    map: Map;
    view: TripView;
    onReady?: (map: Map) => void;
  }

  let { map, view, onReady }: Props = $props();

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
      properties: { mode: leg.mode, color: colorOf(leg.day) },
    })),
  });

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

  onMount(() => {
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
  });
</script>

<GeoJSON id="trip-trails" data={trails}>
  <LineLayer
    id="trip-trails"
    layout={{ 'line-cap': 'round', 'line-join': 'round' }}
    paint={{ 'line-color': ['get', 'color'], 'line-width': 3.4, 'line-opacity': 0.9 }}
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
        'line-opacity': STYLES[mode].opacity,
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
