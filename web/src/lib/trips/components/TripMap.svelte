<script lang="ts" module>
  import { addProtocol, setWorkerUrl } from 'maplibre-gl';
  import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
  import { Protocol } from 'pmtiles';

  setWorkerUrl(workerUrl);
  void addProtocol('pmtiles', new Protocol().tile);

  export type TripBasemap = 'color' | 'focus';
</script>

<script lang="ts">
  import { serverConfigManager } from '$lib/managers/server-config-manager.svelte';
  import { MODE_ART, avatarTransform } from '$lib/trips/trip-modes';
  import { PLACES_COLOR, inkOn, type TripItem, type TripPhoto, type TripView } from '$lib/trips/trip-view';
  import { getAssetMediaUrl } from '$lib/utils';
  import { AssetMediaSize, TripKind, TripLegMode, TripOverlayKind } from '@immich/sdk';
  import { Theme, themeManager } from '@immich/ui';
  import type { Feature, FeatureCollection, LineString, Point, Position } from 'geojson';
  import {
    LngLatBounds,
    Map as MapLibreMap,
    Marker,
    NavigationControl,
    Popup,
    type ExpressionSpecification,
    type GeoJSONSource,
  } from 'maplibre-gl';
  import 'maplibre-gl/dist/maplibre-gl.css';
  import { onDestroy, onMount, untrack } from 'svelte';
  import { t } from 'svelte-i18n';

  // The trip map (trips PLAN §2.3), ported from travel-album's static/viewer/map.js: a pin or a thumbnail flag per
  // stop, legs styled by mode with an avatar in the middle, assets shot on the way, trails and the country mask.

  interface Props {
    view: TripView;
    /** The stop or item opened in the side panel, ringed on the map */
    selectedId?: string;
    /** In the Photos view: legs and avatars lead to sections, and the fit leaves room for the flags */
    toc?: boolean;
    hiddenDays?: Set<number>;
    basemap?: TripBasemap;
    narrow?: boolean;
    /** Room the view switch takes over the top of the map */
    topInset?: number;
    onItem?: (item: TripItem) => void;
    onPhoto?: (photo: TripPhoto) => void;
    onReady?: (api: { fitAll: () => void; flyTo: (item: TripItem) => void }) => void;
  }

  let {
    view,
    selectedId,
    toc = false,
    hiddenDays = new Set(),
    basemap = 'color',
    narrow = false,
    topInset = 0,
    onItem,
    onPhoto,
    onReady,
  }: Props = $props();

  // travel-album's Leaflet zooms less one: MapLibre's 512 px tiles show at zoom z what 256 px tiles show at z + 1.
  const SPLIT_ZOOM = 14;
  const STOP_ZOOM = 12;
  const POLE = 14;
  const BADGE_MIN_PX = 90;

  type LineStyle = { width: number; opacity: number; dash?: number[]; cap?: 'round' | 'butt' };
  // Leaflet's pixel dash arrays (travel-album map.js) in MapLibre's units of line width.
  const dash = (pattern: number[], width: number) => pattern.map((value) => Math.max(value / width, 0.01));
  // Every leg mode has a style; `sleepers` is the second line over rails.
  const STYLES: Record<TripLegMode | 'sleepers', LineStyle> = {
    driving: { width: 3.4, opacity: 0.85 },
    flight: { width: 2.6, opacity: 0.8, dash: dash([10, 6], 2.6) },
    foot: { width: 3, opacity: 0.85, dash: [0.01, 5 / 3] },
    direct: { width: 2, opacity: 0.45, dash: dash([5, 7], 2) },
    bus: { width: 2.4, opacity: 0.85 },
    bicycle: { width: 3, opacity: 0.85, dash: dash([4, 4], 3) },
    train: { width: 3.6, opacity: 0.9 },
    boat: { width: 2.6, opacity: 0.85, dash: dash([14, 10], 2.6) },
    trail: { width: 3, opacity: 0.85 },
    sleepers: { width: 1.6, opacity: 0.9, dash: dash([2, 6], 1.6), cap: 'butt' },
  };
  const TRAIL_COLORS: Record<string, { color: string; width: number; dash?: number[] }> = {
    green: { color: '#3ddc84', width: 4 },
    yellow: { color: '#ffd400', width: 3.4, dash: dash([7, 5], 3.4) },
  };

  let container = $state<HTMLDivElement>();
  let mask = $state<SVGPathElement>();
  let map: MapLibreMap | undefined;
  let zoom = $state(0);
  let initialZoom = $state(0);
  let explodedCount = $state(0);
  let lineCount = $state(0);
  let visibleBadges = $state(0);

  const colorOf = (day: number) =>
    view.kind === TripKind.Places ? PLACES_COLOR : (view.days[day]?.color ?? PLACES_COLOR);
  const thumbUrl = (photo: TripPhoto) =>
    getAssetMediaUrl({ id: photo.id, size: AssetMediaSize.Thumbnail, cacheKey: photo.asset.thumbhash });
  const shown = (day: number) => !hiddenDays.has(day);
  const flagSide = () => (narrow ? 36 : 44);

  // Distance in metres between two [lng, lat] points.
  const metres = ([lng1, lat1]: Position, [lng2, lat2]: Position) => {
    const rad = Math.PI / 180;
    const a =
      Math.sin(((lat2 - lat1) * rad) / 2) ** 2 +
      Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(((lng2 - lng1) * rad) / 2) ** 2;
    return 2 * 6_371_000 * Math.asin(Math.sqrt(a));
  };

  /** The point at `share` of a line's length, and the segment it lies on. */
  const along = (line: Position[], share: number) => {
    const lengths = line.slice(1).map((point, index) => metres(line[index], point));
    let rest = lengths.reduce((sum, length) => sum + length, 0) * share;
    for (const [index, length] of lengths.entries()) {
      if (rest <= length || index === lengths.length - 1) {
        const k = length > 0 ? Math.min(1, rest / length) : 0;
        const [a, b] = [line[index], line[index + 1]];
        return { point: [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k] as Position, from: a, to: b };
      }
      rest -= length;
    }
    return { point: line[0], from: line[0], to: line[0] };
  };

  // ---- Lines -------------------------------------------------------------------------------------------------------

  const legFeatures = () => {
    const features: Feature<LineString | Point>[] = [];
    const line = (coordinates: Position[], style: string, day: number, color: string) => {
      features.push({
        type: 'Feature',
        geometry: { type: 'LineString', coordinates },
        properties: { style, day, color },
      });
    };
    for (const leg of view.legs) {
      const points = leg.points.map(([lat, lng]) => [lng, lat]);
      const color = colorOf(leg.day);
      const isRail = leg.mode === TripLegMode.Train;
      // A train with stations walks to the first and from the last: those ends are drawn on foot.
      if (isRail && leg.departureName && points.length >= 4) {
        line(points.slice(0, 2), 'foot', leg.day, color);
        line(points.slice(1, -1), 'train', leg.day, color);
        line(points.slice(1, -1), 'sleepers', leg.day, '#ffffff');
        line(points.slice(-2), 'foot', leg.day, color);
        for (const [name, lat, lng] of [
          [leg.departureName, leg.departureLatitude, leg.departureLongitude],
          [leg.arrivalName, leg.arrivalLatitude, leg.arrivalLongitude],
        ] as const) {
          if (lat !== null && lng !== null) {
            features.push({
              type: 'Feature',
              geometry: { type: 'Point', coordinates: [lng, lat] },
              properties: { style: 'station', day: leg.day, color, name },
            });
          }
        }
        continue;
      }
      line(points, leg.mode, leg.day, color);
      if (isRail) {
        line(points, 'sleepers', leg.day, '#ffffff');
      }
    }
    return features;
  };

  // Trails join the day of the stop with assets nearest to their first point.
  const trailFeatures = () => {
    const located = view.stops.filter(({ photos, latitude }) => photos.length > 0 && latitude !== null);
    return view.overlays
      .filter(({ kind, geometry }) => kind === TripOverlayKind.Trail && geometry.type === 'LineString')
      .map((overlay): Feature<LineString> => {
        const coordinates = (overlay.geometry as unknown as LineString).coordinates;
        const nearest = [...located].sort(
          (a, b) =>
            metres(coordinates[0], [a.longitude!, a.latitude!]) - metres(coordinates[0], [b.longitude!, b.latitude!]),
        )[0];
        const look = TRAIL_COLORS[overlay.color ?? ''] ?? { color: overlay.color ?? '#3ddc84', width: 3 };
        return {
          type: 'Feature',
          geometry: { type: 'LineString', coordinates },
          properties: { day: nearest?.day ?? 0, color: look.color, width: look.width, dashed: !!look.dash },
        };
      });
  };

  const photoFeatures = (): FeatureCollection<Point> => ({
    type: 'FeatureCollection',
    features: view.order.flatMap((item) =>
      item.photos
        .filter(({ latitude, longitude }) => latitude !== null && longitude !== null)
        .map((photo) => ({
          type: 'Feature' as const,
          geometry: { type: 'Point' as const, coordinates: [photo.longitude!, photo.latitude!] },
          properties: {
            id: photo.id,
            day: item.day,
            color: colorOf(item.day),
            inferred: photo.isInferred,
            video: photo.isVideo,
          },
        })),
    ),
  });

  const dayFilter = (): ExpressionSpecification => ['!', ['in', ['get', 'day'], ['literal', [...hiddenDays]]]];

  const lineLayers = () => Object.keys(STYLES);

  const addLayers = () => {
    if (!map) {
      return;
    }
    const features = legFeatures();
    lineCount = features.filter(({ geometry }) => geometry.type === 'LineString').length + trailFeatures().length;
    map.addSource('trip-legs', { type: 'geojson', data: { type: 'FeatureCollection', features } });
    map.addSource('trip-trails', { type: 'geojson', data: { type: 'FeatureCollection', features: trailFeatures() } });
    map.addSource('trip-photos', { type: 'geojson', data: photoFeatures() });

    for (const dashed of [false, true]) {
      map.addLayer({
        id: `trip-trails-${dashed ? 'dashed' : 'solid'}`,
        type: 'line',
        source: 'trip-trails',
        filter: ['all', ['==', ['get', 'dashed'], dashed], dayFilter()],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': ['get', 'color'],
          'line-width': ['get', 'width'],
          'line-opacity': 0.95,
          ...(dashed && { 'line-dasharray': TRAIL_COLORS.yellow.dash }),
        },
      });
    }
    for (const style of lineLayers()) {
      const look = STYLES[style];
      map.addLayer({
        id: `trip-legs-${style}`,
        type: 'line',
        source: 'trip-legs',
        filter: ['all', ['==', ['get', 'style'], style], dayFilter()],
        layout: { 'line-cap': look.cap ?? 'round', 'line-join': 'round' },
        paint: {
          'line-color': ['get', 'color'],
          'line-width': look.width,
          'line-opacity': look.opacity,
          ...(look.dash && { 'line-dasharray': look.dash }),
        },
      });
    }
    map.addLayer({
      id: 'trip-stations',
      type: 'circle',
      source: 'trip-legs',
      filter: ['all', ['==', ['get', 'style'], 'station'], dayFilter()],
      paint: {
        'circle-radius': 3.5,
        'circle-color': ['get', 'color'],
        'circle-stroke-color': '#fff',
        'circle-stroke-width': 1.2,
      },
    });
    map.addLayer({
      id: 'trip-photos',
      type: 'circle',
      source: 'trip-photos',
      minzoom: SPLIT_ZOOM,
      filter: dayFilter(),
      paint: {
        'circle-radius': ['case', ['get', 'video'], 6, 4.5],
        'circle-color': ['get', 'color'],
        'circle-opacity': ['case', ['get', 'inferred'], 0.3, 0.95],
        'circle-stroke-color': '#fff',
        'circle-stroke-width': 1.3,
        'circle-stroke-opacity': ['case', ['get', 'inferred'], 0.5, 1],
      },
    });
    map.on('click', 'trip-photos', (event) => {
      const id = event.features?.[0]?.properties?.id as string | undefined;
      const photo = view.photos.find((candidate) => candidate.id === id);
      if (photo) {
        onPhoto?.(photo);
      }
    });
    for (const layer of ['trip-photos', ...lineLayers().map((style) => `trip-legs-${style}`)]) {
      map.on('mouseenter', layer, () => {
        if (layer === 'trip-photos' || toc) {
          map!.getCanvas().style.cursor = 'pointer';
        }
      });
      map.on('mouseleave', layer, () => (map!.getCanvas().style.cursor = ''));
    }
    for (const style of lineLayers()) {
      map.on('click', `trip-legs-${style}`, (event) => {
        if (!toc) {
          return;
        }
        const feature = event.features?.[0];
        const leg = view.legs.find(
          ({ day, mode }) =>
            day === feature?.properties?.day && (mode === style || ['foot', 'sleepers'].includes(style)),
        );
        if (leg) {
          openLeg(leg.fromStopId, leg.toStopId);
        }
      });
    }
  };

  /** In the Photos view a leg leads to its assets on the way, else to where it goes, else to where it comes from. */
  const openLeg = (fromStopId: string, toStopId: string) => {
    const target =
      view.transit.find((item) => item.fromStopId === fromStopId && item.toStopId === toStopId) ??
      view.order.find(({ id }) => id === toStopId) ??
      view.order.find(({ id }) => id === fromStopId);
    if (target) {
      onItem?.(target);
    }
  };

  // ---- Markers ------------------------------------------------------------------------------------------------------

  // A marker's own element belongs to MapLibre (its classes and transform place it); what it shows is a child.
  type StopMarker = { item: TripItem; marker: Marker; element: HTMLDivElement; body: HTMLDivElement; isFlag: boolean };
  let stopMarkers: StopMarker[] = [];
  let transitMarkers: { item: TripItem; marker: Marker; element: HTMLDivElement; body: HTMLDivElement }[] = [];
  let badgeMarkers: { leg: TripView['legs'][number]; marker: Marker; element: HTMLDivElement; point: Position }[] = [];
  let tooltip: Popup | undefined;

  const showTooltip = (lngLat: [number, number], lines: string[], offset: number | [number, number] = 14) => {
    if (!map) {
      return;
    }
    const body = document.createElement('div');
    body.className = 'trip-tip';
    for (const [index, text] of lines.entries()) {
      const line = document.createElement(index === 0 ? 'b' : 'div');
      line.textContent = text;
      body.append(line);
    }
    tooltip?.remove();
    tooltip = new Popup({ closeButton: false, closeOnClick: false, offset, className: 'trip-popup' })
      .setLngLat(lngLat)
      .setDOMContent(body)
      .addTo(map);
  };
  const hideTooltip = () => tooltip?.remove();

  const countLabel = (count: number) =>
    count > 0 ? $t('trips_assets_count', { values: { count } }) : $t('trips_no_shots');
  const dayLabel = (day: number) => {
    const date = view.days[day]?.date;
    return date
      ? new Intl.DateTimeFormat(navigator.language, { day: 'numeric', month: 'long', timeZone: 'UTC' }).format(
          new Date(`${date}T00:00:00Z`),
        )
      : '';
  };
  const itemLines = (item: TripItem) => {
    if (item.type !== 'stop') {
      return [];
    }
    if (view.kind === TripKind.Places) {
      const years = [...new Set(item.photos.map(({ date }) => date.slice(0, 4)).filter(Boolean))].sort();
      return [
        item.title,
        [years.length > 1 ? `${years[0]}–${years.at(-1)}` : (years[0] ?? ''), countLabel(item.photos.length)]
          .filter(Boolean)
          .join(' · '),
      ];
    }
    const when = [dayLabel(item.day), item.t0 === '—' ? '' : item.t0].filter(Boolean).join(', ');
    return [item.title, [when, countLabel(item.photos.length)].filter(Boolean).join(' · ')];
  };

  const pinSize = (count: number) => Math.round(13 + Math.min(15, Math.sqrt(count) * 2.6));

  const renderStop = (entry: StopMarker, asFlag: boolean) => {
    const { item, element, body, marker } = entry;
    const color = colorOf(item.day);
    body.replaceChildren();
    body.style.setProperty('--day', color);
    body.style.setProperty('--ink', inkOn(color));
    body.dataset.tripStop = item.id;
    element.setAttribute('role', 'button');
    element.tabIndex = 0;
    element.setAttribute('aria-label', itemLines(item).join(', '));
    const count = item.photos.length;
    if (asFlag && count > 0) {
      const side = flagSide();
      body.className = 'trip-flag';
      body.style.setProperty('--fw', `${side}px`);
      body.style.width = '';
      body.style.height = '';
      body.style.background = '';
      body.style.color = '';
      const pole = document.createElement('span');
      pole.className = 'pole';
      const cloth = document.createElement('span');
      cloth.className = 'cloth';
      const image = document.createElement('img');
      image.src = thumbUrl(item.photos[0]);
      image.alt = '';
      image.loading = 'lazy';
      cloth.append(image);
      if (item.photos[0].isVideo) {
        const play = document.createElement('span');
        play.className = 'vid';
        play.textContent = '▶';
        cloth.append(play);
      }
      const number = document.createElement('span');
      number.className = 'n';
      number.textContent = String(count);
      cloth.append(number);
      body.append(pole, cloth);
      marker.setOffset([side / 2 - 1, -(side + POLE) / 2]);
      element.style.zIndex = String(1000 + count);
    } else {
      const size = pinSize(count);
      body.className = `trip-pin${count === 0 ? ' start' : ''}`;
      body.style.width = `${size}px`;
      body.style.height = `${size}px`;
      body.style.background = color;
      body.style.color = inkOn(color);
      body.textContent = count > 3 ? String(count) : '';
      marker.setOffset([0, 0]);
      element.style.zIndex = String(count);
    }
    entry.isFlag = asFlag && count > 0;
    body.classList.toggle('on', item.id === selectedId || item.id === hotId);
  };

  let hotId = $state<string>();

  const createMarkers = () => {
    if (!map) {
      return;
    }
    for (const stop of view.stops) {
      if (stop.latitude === null || stop.longitude === null) {
        continue;
      }
      const element = document.createElement('div');
      const body = document.createElement('div');
      element.append(body);
      const marker = new Marker({ element, anchor: 'center' }).setLngLat([stop.longitude, stop.latitude]).addTo(map);
      const entry: StopMarker = { item: stop, marker, element, body, isFlag: false };
      element.addEventListener('click', (event) => {
        event.stopPropagation();
        onItem?.(stop);
      });
      element.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onItem?.(stop);
        }
      });
      element.addEventListener('mouseenter', () =>
        showTooltip(
          [stop.longitude!, stop.latitude!],
          itemLines(stop),
          entry.isFlag ? [flagSide() / 2, -(flagSide() + POLE)] : 14,
        ),
      );
      element.addEventListener('mouseleave', hideTooltip);
      stopMarkers.push(entry);
      renderStop(entry, false);
    }

    const legOf = (item: { fromStopId: string; toStopId: string }) =>
      view.legs.find(({ fromStopId, toStopId }) => fromStopId === item.fromStopId && toStopId === item.toStopId);
    const stopById = new Map(view.stops.map((stop) => [stop.id, stop]));
    for (const item of view.transit) {
      const leg = legOf(item);
      let point: Position | undefined;
      if (leg && leg.points.length > 1) {
        point = along(
          leg.points.map(([lat, lng]) => [lng, lat]),
          item.fraction,
        ).point;
      } else {
        const [a, b] = [stopById.get(item.fromStopId), stopById.get(item.toStopId)];
        if (a && b && a.latitude !== null && b.latitude !== null) {
          point = [
            a.longitude! + (b.longitude! - a.longitude!) * item.fraction,
            a.latitude + (b.latitude - a.latitude) * item.fraction,
          ];
        } else if (item.latitude !== null && item.longitude !== null) {
          point = [item.longitude, item.latitude];
        }
      }
      if (!point) {
        continue;
      }
      const element = document.createElement('div');
      const body = document.createElement('div');
      element.append(body);
      body.className = 'trip-onway';
      body.style.setProperty('--day', colorOf(item.day));
      body.style.setProperty('--ink', inkOn(colorOf(item.day)));
      body.dataset.tripTransit = item.id;
      const image = document.createElement('img');
      image.src = thumbUrl(item.photos[0]);
      image.alt = '';
      const number = document.createElement('span');
      number.className = 'n';
      number.textContent = String(item.photos.length);
      body.append(image, number);
      element.addEventListener('click', (event) => {
        event.stopPropagation();
        onItem?.(item);
      });
      const from = stopById.get(item.fromStopId);
      const to = stopById.get(item.toStopId);
      const lines = [
        $t('trips_transit_title', {
          values: {
            from: from?.title || from?.region || '…',
            to: to?.title || to?.region || '…',
          },
        }),
        `${dayLabel(item.day)}, ${item.t0 === item.t1 ? item.t0 : `${item.t0}–${item.t1}`} · ${countLabel(item.photos.length)}`,
      ];
      const lngLat = point as [number, number];
      element.addEventListener('mouseenter', () => showTooltip(lngLat, lines, 20));
      element.addEventListener('mouseleave', hideTooltip);
      transitMarkers.push({ item, element, body, marker: new Marker({ element }).setLngLat(lngLat).addTo(map) });
    }

    // Mode avatars in the middle of a leg, moved aside when assets on the way sit there.
    for (const leg of view.legs) {
      const art = MODE_ART[leg.mode];
      if (!art || leg.points.length < 2) {
        continue;
      }
      const line = leg.points.map(([lat, lng]) => [lng, lat]);
      const near = view.transit.find(
        (item) =>
          item.fromStopId === leg.fromStopId && item.toStopId === leg.toStopId && Math.abs(item.fraction - 0.5) < 0.15,
      );
      const share = near ? (near.fraction < 0.5 ? 0.75 : 0.25) : 0.5;
      const { point, from, to } = along(line, share);
      const a = map.project(from as [number, number]);
      const b = map.project(to as [number, number]);
      const angle = (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI;
      const element = document.createElement('div');
      const body = document.createElement('div');
      element.append(body);
      body.className = 'trip-legmode';
      body.dataset.tripMode = leg.mode;
      body.style.setProperty('--day', colorOf(leg.day));
      // MODE_ART is a fixed set of shapes from this repository, not user text.
      body.innerHTML = `<svg class="trip-avatar" width="40" height="40" viewBox="0 0 40 40" style="transform:${avatarTransform(angle)}" aria-hidden="true">${art}</svg>`;
      const lines = [legTitle(leg)];
      if (leg.departureName && leg.arrivalName) {
        lines.push(`${leg.departureName} → ${leg.arrivalName}`);
      }
      element.addEventListener('mouseenter', () => showTooltip(point as [number, number], lines, 22));
      element.addEventListener('mouseleave', hideTooltip);
      element.addEventListener('click', (event) => {
        event.stopPropagation();
        if (toc) {
          openLeg(leg.fromStopId, leg.toStopId);
        }
      });
      badgeMarkers.push({
        leg,
        element,
        point,
        marker: new Marker({ element }).setLngLat(point as [number, number]).addTo(map),
      });
    }
  };

  const legTitle = (leg: TripView['legs'][number]) => {
    const parts = [$t(`trips_mode_${leg.mode}`)];
    if (leg.distance) {
      const km = leg.distance / 1000;
      parts.push($t('trips_km', { values: { km: km < 10 ? km.toFixed(1) : Math.round(km) } }));
    }
    if (leg.duration) {
      const minutes = Math.max(1, Math.round(leg.duration / 60));
      const hours = Math.floor(minutes / 60);
      parts.push(
        hours > 0
          ? $t('trips_duration_hours', { values: { hours, minutes: minutes % 60 } })
          : $t('trips_duration_minutes', { values: { minutes } }),
      );
    }
    return parts.join(' · ');
  };

  /** Flags where they do not cover each other, biggest stops first; the rest stay pins (travel-album layoutFlags). */
  const layoutMarkers = () => {
    if (!map) {
      return;
    }
    const side = flagSide();
    const exploded = map.getZoom() >= SPLIT_ZOOM;
    const placed: [number, number, number, number][] = [];
    const candidates = stopMarkers
      .filter(({ item }) => item.photos.length > 0 && shown(item.day))
      .sort((a, b) => b.item.photos.length - a.item.photos.length || a.item.id.localeCompare(b.item.id));
    const flags: StopMarker[] = [];
    for (const entry of candidates) {
      const { x, y } = map.project(entry.marker.getLngLat());
      const box: [number, number, number, number] = [x - 1, y - side - POLE, x - 1 + side, y];
      if (placed.some(([l, t, r, b]) => box[0] < r && box[2] > l && box[1] < b && box[3] > t)) {
        continue;
      }

      placed.push(box);
      flags.push(entry);
    }
    for (const entry of stopMarkers) {
      const visible =
        shown(entry.item.day) && !(exploded && entry.item.photos.some(({ latitude }) => latitude !== null));
      entry.element.style.display = visible ? '' : 'none';
      if (flags.includes(entry) !== entry.isFlag) {
        renderStop(entry, flags.includes(entry));
      }
    }
    for (const { item, element } of transitMarkers) {
      element.style.display = shown(item.day) ? '' : 'none';
    }
    // An avatar shows where its leg is at least 90 px long on screen.
    let badges = 0;
    for (const { leg, element, point } of badgeMarkers) {
      const metresPerPixel = (40_075_016.686 * Math.cos((point[1] * Math.PI) / 180)) / 2 ** (map.getZoom() + 9);
      const visible = shown(leg.day) && (leg.distance ?? 0) / metresPerPixel >= BADGE_MIN_PX;
      element.style.display = visible ? '' : 'none';
      element.style.cursor = toc ? 'pointer' : 'default';
      badges += visible ? 1 : 0;
    }
    visibleBadges = badges;
    zoom = map.getZoom();
    explodedCount = exploded ? map.queryRenderedFeatures({ layers: ['trip-photos'] }).length : 0;
    drawMask();
  };

  // ---- Country mask --------------------------------------------------------------------------------------------------

  const rings = $derived(
    view.overlays
      .filter(({ kind, geometry }) => kind === TripOverlayKind.Mask && geometry.type === 'MultiPolygon')
      .flatMap((overlay) => (overlay.geometry as { coordinates: Position[][][] }).coordinates.flat()),
  );
  export const hasMask = () => rings.length > 0;

  /** Greys out everything outside the trip's countries: the viewport minus the rings, even-odd. */
  const drawMask = () => {
    if (!map || !mask || !container) {
      return;
    }
    if (basemap !== 'focus' || rings.length === 0) {
      mask.setAttribute('d', '');
      return;
    }
    const { clientWidth: width, clientHeight: height } = container;
    const margin = 64;
    let d = `M${-margin},${-margin}H${width + margin}V${height + margin}H${-margin}Z`;
    for (const ring of rings) {
      const points = ring.map((point) => map!.project(point as [number, number]));
      d += `M${points.map(({ x, y }) => `${x.toFixed(1)},${y.toFixed(1)}`).join('L')}Z`;
    }
    mask.setAttribute('d', d);
  };

  // ---- Fit -----------------------------------------------------------------------------------------------------------

  const boundsOf = (items: { latitude: number | null; longitude: number | null }[]) => {
    const bounds = new LngLatBounds();
    for (const { latitude, longitude } of items) {
      if (latitude !== null && longitude !== null) {
        bounds.extend([longitude, latitude]);
      }
    }
    return bounds.isEmpty() ? undefined : bounds;
  };

  const fitAll = (animate = true) => {
    if (!map || !container) {
      return;
    }
    const items = toc ? view.stops.filter(({ photos }) => photos.length > 0) : view.stops;
    const bounds = boundsOf(items.length > 1 ? items : view.stops);
    if (!bounds) {
      map.jumpTo({ center: [0, 30], zoom: 2 });
      return;
    }
    const { clientWidth: width, clientHeight: height } = container;
    const top = toc ? flagSide() + POLE + 10 : Math.round(height * 0.06);
    const camera = map.cameraForBounds(bounds, {
      padding: {
        top: top + topInset,
        bottom: toc ? 20 : Math.round(height * 0.06),
        left: toc ? 40 : Math.round(width * 0.06),
        right: toc ? 40 : Math.round(width * 0.06),
      },
      maxZoom: toc ? 13 : 18,
    });
    if (!camera) {
      return;
    }
    // Leaflet snaps a fit to whole zoom levels (quarters in the Photos view); the counts on the map depend on it.
    const step = toc ? 4 : 1;
    const zoom = Math.floor((camera.zoom ?? 2) * step) / step;
    if (animate) {
      map.easeTo({ center: camera.center, zoom });
    } else {
      map.jumpTo({ center: camera.center, zoom });
    }
  };

  const flyTo = (item: TripItem) => {
    if (!map || item.type === 'unplaced') {
      return;
    }
    const latitude = item.latitude ?? item.photos.find((photo) => photo.latitude !== null)?.latitude;
    const longitude = item.longitude ?? item.photos.find((photo) => photo.longitude !== null)?.longitude;
    if (latitude === null || latitude === undefined || longitude === null || longitude === undefined) {
      return;
    }
    map.easeTo({ center: [longitude, latitude], zoom: Math.max(map.getZoom(), STOP_ZOOM) });
  };

  // ---- Lifecycle -------------------------------------------------------------------------------------------------------

  const styleUrl = () =>
    themeManager.value === Theme.Dark
      ? serverConfigManager.value.mapDarkStyleUrl
      : serverConfigManager.value.mapLightStyleUrl;

  onMount(() => {
    if (!container) {
      return;
    }
    map = new MapLibreMap({
      container,
      style: styleUrl(),
      attributionControl: { compact: true },
      center: [0, 30],
      zoom: 2,
    });
    map.addControl(new NavigationControl({ showCompass: false }), 'top-left');
    map.once('load', () => {
      fitAll(false);
      initialZoom = map!.getZoom();
      createMarkers();
      layoutMarkers();
      onReady?.({ fitAll: () => fitAll(), flyTo });
    });
    // Every style load (the first one and each theme switch) needs the trip's sources and layers again.
    map.on('style.load', addLayers);
    map.on('moveend', layoutMarkers);
    map.on('move', drawMask);
    const observer = new ResizeObserver(() => {
      map?.resize();
      drawMask();
    });
    observer.observe(container);
    return () => observer.disconnect();
  });

  onDestroy(() => {
    tooltip?.remove();
    map?.remove();
  });

  let lastStyle = '';
  $effect(() => {
    const url = styleUrl();
    if (map && lastStyle && url !== lastStyle) {
      map.setStyle(url);
    }
    lastStyle = url;
  });

  $effect(() => {
    void hiddenDays;
    void basemap;
    untrack(() => {
      if (!map?.isStyleLoaded()) {
        return;
      }
      const filter = dayFilter();
      for (const style of lineLayers()) {
        map.setFilter(`trip-legs-${style}`, ['all', ['==', ['get', 'style'], style], filter]);
      }
      map.setFilter('trip-stations', ['all', ['==', ['get', 'style'], 'station'], filter]);
      map.setFilter('trip-photos', filter);
      for (const dashed of [false, true]) {
        map.setFilter(`trip-trails-${dashed ? 'dashed' : 'solid'}`, ['all', ['==', ['get', 'dashed'], dashed], filter]);
      }
      layoutMarkers();
    });
  });

  $effect(() => {
    void selectedId;
    void hotId;
    for (const { item, body } of [...stopMarkers, ...transitMarkers]) {
      body.classList.toggle('on', item.id === selectedId || item.id === hotId);
    }
  });

  export const setHot = (id: string | undefined) => (hotId = id);

  const hint = $derived.by(() => {
    if (toc) {
      return '';
    }
    if (explodedCount > 0) {
      return $t('trips_own_coords', { values: { count: explodedCount } });
    }
    return zoom <= initialZoom + 0.01
      ? $t(view.kind === TripKind.Places ? 'trips_zoom_in_places' : 'trips_zoom_in')
      : '';
  });

  // The source data never changes while the map lives; refresh only when a new view arrives.
  $effect(() => {
    const data = view;
    untrack(() => {
      const source = map?.getSource('trip-photos') as GeoJSONSource | undefined;
      if (source && data) {
        void source.setData(photoFeatures());
      }
    });
  });
</script>

<div
  class="trip-map"
  bind:this={container}
  style:--trip-map-inset="{topInset}px"
  data-testid="trip-map"
  data-lines={lineCount}
  data-modes={visibleBadges}
>
  <svg class="trip-mask-def" aria-hidden="true">
    <defs>
      <clipPath id="trip-focus-clip" clipPathUnits="userSpaceOnUse">
        <path bind:this={mask} clip-rule="evenodd" />
      </clipPath>
    </defs>
  </svg>
  <div class="trip-mask" class:on={basemap === 'focus' && rings.length > 0}></div>
  {#if hint}
    <div class="trip-hint" class:live={explodedCount > 0}>{hint}</div>
  {/if}
</div>

<style>
  .trip-map {
    position: relative;
    width: 100%;
    height: 100%;
    background: var(--trip-sunk);
  }
  .trip-mask-def {
    position: absolute;
    width: 0;
    height: 0;
  }
  /* Above the map canvas, below the markers: outside the trip's countries the base map loses its colour. */
  .trip-mask {
    position: absolute;
    inset: 0;
    z-index: 1;
    pointer-events: none;
    display: none;
    backdrop-filter: grayscale(1) brightness(0.93);
    -webkit-backdrop-filter: grayscale(1) brightness(0.93);
    clip-path: url(#trip-focus-clip);
  }
  .trip-mask.on {
    display: block;
  }
  .trip-hint {
    position: absolute;
    left: 12px;
    bottom: 22px;
    z-index: 3;
    background: var(--trip-glass);
    border: 1px solid var(--trip-line);
    border-radius: 7px;
    padding: 6px 11px;
    font-size: 12px;
    color: var(--trip-muted);
    backdrop-filter: blur(6px);
    pointer-events: none;
  }
  .trip-hint.live {
    color: var(--trip-accent-ink);
    border-color: var(--trip-accent-line);
  }
  .trip-map :global(.maplibregl-ctrl-top-left) {
    top: var(--trip-map-inset, 0);
  }
  .trip-map :global(.maplibregl-marker) {
    z-index: 2;
  }
  .trip-map :global(.trip-pin) {
    border-radius: 50%;
    border: 2px solid #fff;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.55);
    display: flex;
    align-items: center;
    justify-content: center;
    font-weight: 650;
    font-size: 11px;
    cursor: pointer;
    transition: transform 0.15s;
  }
  .trip-map :global(.trip-pin:hover) {
    transform: scale(1.18);
  }
  .trip-map :global(.trip-pin.on) {
    box-shadow:
      0 0 0 4px rgba(242, 163, 60, 0.6),
      0 2px 8px rgba(0, 0, 0, 0.55);
  }
  .trip-map :global(.trip-pin.start) {
    border-style: dashed;
    background-clip: padding-box;
  }
  .trip-map :global(.trip-flag) {
    position: relative;
    width: var(--fw);
    height: calc(var(--fw) + 14px);
    cursor: pointer;
    filter: drop-shadow(0 2px 5px rgba(0, 0, 0, 0.5));
  }
  .trip-map :global(.trip-flag .pole) {
    position: absolute;
    left: 0;
    bottom: 0;
    width: 2px;
    height: 100%;
    background: var(--day);
    border-radius: 1px;
  }
  .trip-map :global(.trip-flag .pole::after) {
    content: '';
    position: absolute;
    left: -2px;
    bottom: -3px;
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--day);
    border: 1px solid #fff;
  }
  .trip-map :global(.trip-flag .cloth) {
    position: absolute;
    left: 0;
    top: 0;
    width: var(--fw);
    height: var(--fw);
    box-sizing: border-box;
    border: 2px solid var(--day);
    border-radius: 0 5px 5px 0;
    background: var(--trip-sunk);
    overflow: hidden;
    transition: transform 0.15s;
    transform-origin: 0 100%;
  }
  .trip-map :global(.trip-flag img),
  .trip-map :global(.trip-onway img) {
    width: 100%;
    height: 100%;
    object-fit: cover;
    display: block;
  }
  .trip-map :global(.trip-flag .vid) {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 13px;
    color: #fff;
    text-shadow: 0 1px 6px #000;
    pointer-events: none;
  }
  .trip-map :global(.trip-flag .n),
  .trip-map :global(.trip-onway .n) {
    position: absolute;
    background: var(--day);
    color: var(--ink, #fff);
    font-size: 11px;
    font-weight: 650;
    line-height: 1;
    font-variant-numeric: tabular-nums;
  }
  .trip-map :global(.trip-flag .n) {
    right: 0;
    bottom: 0;
    padding: 2px 3px 1px 4px;
    border-radius: 4px 0 0 0;
  }
  .trip-map :global(.trip-flag:hover .cloth) {
    transform: scale(1.12);
  }
  .trip-map :global(.trip-flag.on .cloth) {
    box-shadow: 0 0 0 3px rgba(242, 163, 60, 0.75);
  }
  .trip-map :global(.trip-onway) {
    position: relative;
    width: 34px;
    height: 34px;
    border-radius: 50%;
    border: 2px solid var(--day);
    background: var(--trip-sunk);
    cursor: pointer;
    filter: drop-shadow(0 2px 5px rgba(0, 0, 0, 0.5));
    transition: transform 0.15s;
  }
  .trip-map :global(.trip-onway img) {
    border-radius: 50%;
  }
  .trip-map :global(.trip-onway .n) {
    right: -6px;
    bottom: -4px;
    padding: 2px 4px;
    border-radius: 8px;
  }
  .trip-map :global(.trip-onway.on) {
    box-shadow: 0 0 0 3px rgba(242, 163, 60, 0.75);
  }
  .trip-map :global(.trip-legmode) {
    width: 40px;
    height: 40px;
  }
  :global(.trip-popup .maplibregl-popup-content) {
    background: var(--trip-panel, #fff);
    color: var(--trip-text, #1a1e26);
    border: 1px solid var(--trip-line, #ddd6ca);
    font-size: 12.5px;
    padding: 5px 9px;
    box-shadow: 0 6px 18px rgba(0, 0, 0, 0.25);
  }
  :global(.trip-popup .maplibregl-popup-tip) {
    display: none;
  }
</style>
