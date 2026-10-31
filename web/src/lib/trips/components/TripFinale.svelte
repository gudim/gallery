<script lang="ts">
  import type { TripView } from '$lib/trips/trip-view';
  import { locale, t } from 'svelte-i18n';

  // "End of the trip" (travel-album static/viewer/finale.js): where it went, the totals, the whole route on the map and
  // sharing the link. The road shows the route's silhouette above it. The author's other trips come with the showcase
  // (trips PLAN §2.8).

  interface Props {
    view: TripView;
    title: string;
    silhouette?: boolean;
    onWholeRoute: () => void;
  }

  let { view, title, silhouette = false, onWholeRoute }: Props = $props();

  const lang = $derived($locale ?? 'en');
  const placed = $derived(view.stops.filter(({ photos }) => photos.length > 0));
  const first = $derived(placed[0]);
  const last = $derived(placed.at(-1));
  const name = (stop: (typeof placed)[number] | undefined) => stop?.title || stop?.region || '';
  const summary = $derived(
    [
      $t('trips_days_count', { values: { count: view.days.length } }),
      $t('trips_stops_count', { values: { count: placed.length } }),
      view.km ? $t('trips_km', { values: { km: view.km.toLocaleString(lang) } }) : '',
      $t('trips_assets_count', { values: { count: view.photos.length } }),
    ]
      .filter(Boolean)
      .join(' · '),
  );

  let note = $state('');
  let fallbackUrl = $state('');

  const share = async () => {
    const url = location.origin + location.pathname;
    note = '';
    fallbackUrl = '';
    // eslint-disable-next-line tscompat/tscompat
    if (navigator.share) {
      try {
        // eslint-disable-next-line tscompat/tscompat
        await navigator.share({ title, url });
        return;
      } catch (error) {
        if ((error as Error).name === 'AbortError') {
          return;
        }
      }
    }
    try {
      await navigator.clipboard.writeText(url);
      note = $t('trips_link_copied');
    } catch {
      fallbackUrl = url;
      note = $t('trips_copy_link');
    }
  };

  // The route in an equirectangular projection fitted into 340×150: legs where they exist, else stops in order.
  const WIDTH = 340;
  const HEIGHT = 150;
  const PAD = 12;
  const shape = $derived.by(() => {
    const lines =
      view.legs.length > 0
        ? view.legs.map(({ points }) => points)
        : [
            placed
              .filter(({ latitude }) => latitude !== null)
              .map(({ latitude, longitude }) => [latitude!, longitude!] as [number, number]),
          ];
    const all = lines.flat();
    if (all.length < 2) {
      return;
    }
    const meanLat = all.reduce((sum, [lat]) => sum + lat, 0) / all.length;
    const k = Math.cos((meanLat * Math.PI) / 180);
    const xs = all.map(([, lng]) => lng * k);
    const ys = all.map(([lat]) => -lat);
    const [minX, maxX, minY, maxY] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
    const scale = Math.min((WIDTH - 2 * PAD) / (maxX - minX || 1), (HEIGHT - 2 * PAD) / (maxY - minY || 1));
    const dx = (WIDTH - (maxX - minX) * scale) / 2;
    const dy = (HEIGHT - (maxY - minY) * scale) / 2;
    const at = (lat: number, lng: number) => [dx + (lng * k - minX) * scale, dy + (-lat - minY) * scale] as const;
    const path = lines
      .filter((line) => line.length > 1)
      .map(
        (line) =>
          'M' +
          line
            .map(([lat, lng]) =>
              at(lat, lng)
                .map((value) => value.toFixed(1))
                .join(','),
            )
            .join('L'),
      )
      .join('');
    const dots = placed
      .filter(({ latitude }) => latitude !== null)
      .map((stop) => {
        const [x, y] = at(stop.latitude!, stop.longitude!);
        return { x, y, color: view.days[stop.day]?.color ?? '#2196f3', id: stop.id };
      });
    return { path, dots, end: dots.at(-1) };
  });
</script>

<footer class="finale" class:road={silhouette} data-testid="trip-finale">
  {#if silhouette && shape}
    <button type="button" class="shape" onclick={onWholeRoute} aria-label={$t('trips_whole_route')}>
      <svg viewBox="0 0 {WIDTH} {HEIGHT}" width={WIDTH} height={HEIGHT} aria-hidden="true">
        <path d={shape.path} class="halo" />
        <path d={shape.path} class="line" pathLength="1" />
        {#each shape.dots as dot (dot.id)}
          <circle cx={dot.x} cy={dot.y} r="3.2" fill={dot.color} class="stopdot" />
        {/each}
        {#if shape.end}
          <circle cx={shape.end.x} cy={shape.end.y} r="7" class="end" />
        {/if}
      </svg>
    </button>
  {/if}
  <h2>{$t('trips_finale_title')}</h2>
  {#if first && last && name(first) !== name(last)}
    <p class="way">{name(first)} → {name(last)}</p>
  {/if}
  <p class="sum">{summary}</p>
  <div class="actions">
    <button type="button" class="primary" onclick={onWholeRoute}>{$t('trips_whole_route')}</button>
    <button type="button" class="outline" onclick={share}>{$t('trips_share')}</button>
  </div>
  {#if note}
    <p class="note" role="status">{note}</p>
  {/if}
  {#if fallbackUrl}
    <input class="copy" readonly value={fallbackUrl} onfocus={(event) => event.currentTarget.select()} />
  {/if}
</footer>

<style>
  .finale {
    padding: 22px 20px 30px;
    border-top: 1px solid var(--trip-line);
    margin-top: 10px;
  }
  .finale.road {
    border-top: 0;
    text-align: center;
    padding: 10px 16px 60px;
  }
  h2 {
    margin: 0 0 4px;
    font-size: 17px;
    font-weight: 650;
  }
  .road h2 {
    font-size: 23px;
  }
  .way,
  .sum {
    margin: 2px 0;
    color: var(--trip-muted);
    font-size: 13px;
  }
  .road .way,
  .road .sum {
    font-size: 15px;
  }
  .actions {
    display: flex;
    gap: 8px;
    margin-top: 14px;
    flex-wrap: wrap;
  }
  .road .actions {
    flex-direction: column;
    align-items: center;
  }
  .road .actions button {
    width: 100%;
    max-width: 300px;
    min-height: 44px;
  }
  .primary,
  .outline {
    font: inherit;
    font-size: 13px;
    border-radius: 7px;
    padding: 7px 14px;
    cursor: pointer;
  }
  .primary {
    background: var(--trip-accent);
    color: var(--trip-on-accent);
    border: 1px solid var(--trip-accent);
    font-weight: 600;
  }
  .outline {
    background: none;
    color: var(--trip-text);
    border: 1px solid var(--trip-line);
  }
  .note {
    margin: 10px 0 0;
    color: var(--trip-muted);
    font-size: 12.5px;
  }
  .copy {
    margin-top: 6px;
    width: 100%;
    font: inherit;
    font-size: 12px;
    padding: 6px 8px;
    border: 1px solid var(--trip-line);
    border-radius: 6px;
    background: var(--trip-sunk);
    color: var(--trip-text);
  }
  .shape {
    border: 0;
    background: none;
    padding: 0;
    cursor: pointer;
    max-width: 100%;
  }
  .shape svg {
    max-width: 100%;
    height: auto;
  }
  .halo {
    fill: none;
    stroke: var(--trip-road-base);
    stroke-width: 9;
    stroke-linecap: round;
    stroke-linejoin: round;
  }
  .line {
    fill: none;
    stroke: var(--trip-route);
    stroke-width: 3;
    stroke-linecap: round;
    stroke-linejoin: round;
    stroke-dasharray: 1;
    animation: draw 1.6s ease-out both;
  }
  .stopdot {
    stroke: var(--trip-bg);
    stroke-width: 1.5;
  }
  .end {
    fill: var(--trip-accent);
    stroke: var(--trip-bg);
    stroke-width: 2;
    animation: pop 0.4s 1.3s both;
  }
  @keyframes draw {
    from {
      stroke-dashoffset: 1;
    }
    to {
      stroke-dashoffset: 0;
    }
  }
  @keyframes pop {
    from {
      r: 0;
    }
  }
</style>
