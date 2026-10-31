import {
  AssetTypeEnum,
  TripKind,
  TripPointSource,
  type AssetResponseDto,
  type TripLegDto,
  type TripResponseDto,
  type TripStopDto,
} from '@immich/sdk';

// What the trip viewer shows, derived from the trip read and the album's assets (trips PLAN §2.3). Ported from
// travel-album's atlas/albums/payload.py and the derivations at the top of static/viewer/map.js and road.js.

/** Day colours, by day index (travel-album payload.py DAYCOL). */
export const DAY_COLORS = [
  '#e6394a',
  '#f2792b',
  '#e8b32c',
  '#7cb342',
  '#26a69a',
  '#2196f3',
  '#5c6bc0',
  '#8e5fd6',
  '#d94f9c',
  '#8d6e63',
  '#546e7a',
];

/** The one pin colour of a Places trip, which has no days. */
export const PLACES_COLOR = '#2196f3';

export type TripPhoto = {
  id: string;
  asset: AssetResponseDto;
  /** `HH:MM` local time, or '' */
  time: string;
  /** `YYYY-MM-DD` local date, or '' */
  date: string;
  isVideo: boolean;
  /** The point was inferred from neighbours in time */
  isInferred: boolean;
  latitude: number | null;
  longitude: number | null;
  likes: number;
  isLiked: boolean;
};

export type TripDay = {
  date: string;
  color: string;
  /** Assets of the day's stops and of the legs between them */
  count: number;
  /** Distinct regions of the day's stops, in trip order */
  regions: string[];
};

type ItemBase = {
  id: string;
  day: number;
  photos: TripPhoto[];
  videoCount: number;
  /** `HH:MM` of the first and last asset, or of the stop's window; '—' when there is none */
  t0: string;
  t1: string;
};

export type TripViewStop = ItemBase & {
  type: 'stop';
  stop: TripStopDto;
  title: string;
  story: string;
  region: string;
  country: string;
  latitude: number | null;
  longitude: number | null;
  date: string;
  /** 1-based among stops with assets; start, finish and empty stops have none */
  number?: number;
  isEnd: boolean;
  article?: string;
  placeId: string | null;
};

/** Assets shot on the way between two stops, shown on the leg between them. */
export type TripTransit = ItemBase & {
  type: 'transit';
  fromStopId: string;
  toStopId: string;
  stopIds: string[];
  latitude: number | null;
  longitude: number | null;
  /** Where on the leg, as a share of its length (0.05–0.95) */
  fraction: number;
};

export type TripUnplaced = ItemBase & { type: 'unplaced' };

export type TripItem = TripViewStop | TripTransit | TripUnplaced;

export type TripViewLeg = TripLegDto & { day: number; points: [number, number][] };

export type TripView = {
  kind: TripKind;
  albumId: string;
  stops: TripViewStop[];
  days: TripDay[];
  legs: TripViewLeg[];
  transit: TripTransit[];
  unplaced?: TripUnplaced;
  /** Stops with assets, each followed by the transit after it, then Unplaced: the order of every view */
  order: TripItem[];
  /** Every shown asset in `order`: the lightbox pages through these */
  photos: TripPhoto[];
  km: number | null;
  overlays: TripResponseDto['overlays'];
  /** Stops span more than one country, so meta lines name it */
  isMultiCountry: boolean;
};

const localDate = (iso: string | null | undefined) => (iso ? iso.slice(0, 10) : '');
const localTime = (iso: string | null | undefined) => (iso ? iso.slice(11, 16) : '');

/** Decodes an encoded polyline into [latitude, longitude] points. Trip legs use precision 6, as Valhalla does. */
export const decodePolyline = (encoded: string, precision = 6): [number, number][] => {
  const factor = 10 ** precision;
  const points: [number, number][] = [];
  let index = 0;
  let lat = 0;
  let lng = 0;
  while (index < encoded.length) {
    for (const axis of [0, 1]) {
      let result = 0;
      let shift = 0;
      let byte: number;
      do {
        byte = encoded.codePointAt(index++)! - 63;
        result |= (byte & 0x1f) << shift;
        shift += 5;
      } while (byte >= 0x20 && index < encoded.length);
      const delta = result & 1 ? ~(result >> 1) : result >> 1;
      if (axis === 0) {
        lat += delta;
      } else {
        lng += delta;
      }
    }
    points.push([lat / factor, lng / factor]);
  }
  return points;
};

/** Where on the leg a → b the assets were shot: the median time as a share of the way, 0.05–0.95. */
export const transitFraction = (from: TripStopDto, to: TripStopDto, times: string[]) => {
  const start = Date.parse(from.localEnd ?? from.localStart ?? '');
  const end = Date.parse(to.localStart ?? '');
  const shots = times
    .filter(Boolean)
    .map((time) => Date.parse(time))
    .sort((a, b) => a - b);
  if (Number.isNaN(start) || Number.isNaN(end) || end <= start || shots.length === 0) {
    return 0.5;
  }
  const middle = shots.length / 2;
  const median = shots.length % 2 ? shots[Math.floor(middle)] : (shots[middle - 1] + shots[middle]) / 2;
  const share = (median - start) / (end - start);
  return Math.round(Math.min(0.95, Math.max(0.05, share)) * 1000) / 1000;
};

const span = (photos: TripPhoto[]) => ({
  videoCount: photos.filter(({ isVideo }) => isVideo).length,
  t0: photos[0]?.time || '—',
  t1: photos.at(-1)?.time || '—',
});

/**
 * Builds the viewer's model. `assets` are the album's assets as the caller may see them; trip assets missing from it
 * are skipped, so the model never names an asset the caller cannot open.
 */
export const buildTripView = (trip: TripResponseDto, assets: AssetResponseDto[]): TripView => {
  const kind = trip.kind;
  const assetById = new Map(assets.map((asset) => [asset.id, asset]));
  const likes = new Map(trip.likes.map((like) => [like.assetId, like]));
  const articles = new Map(trip.places.map((place) => [place.id, place.article ?? undefined]));

  const photosByStop = new Map<string | null, TripPhoto[]>();
  for (const filing of trip.assets) {
    const asset = assetById.get(filing.assetId);
    if (!asset) {
      continue;
    }
    const like = likes.get(asset.id);
    const photo: TripPhoto = {
      id: asset.id,
      asset,
      time: localTime(asset.localDateTime),
      date: localDate(asset.localDateTime),
      isVideo: asset.type === AssetTypeEnum.Video,
      isInferred: filing.pointSource === TripPointSource.Inferred,
      latitude: filing.latitude ?? asset.exifInfo?.latitude ?? null,
      longitude: filing.longitude ?? asset.exifInfo?.longitude ?? null,
      likes: like?.count ?? 0,
      isLiked: like?.isLiked ?? false,
    };
    const list = photosByStop.get(filing.stopId) ?? [];
    list.push(photo);
    photosByStop.set(filing.stopId, list);
  }

  // A Plain trip has no start or finish; a Places trip's start is its centre.
  const stops = kind === TripKind.Plain ? trip.stops.filter(({ role }) => !role) : trip.stops;
  const real = stops.filter(({ isTransit }) => !isTransit);

  const dates =
    kind === TripKind.Places
      ? []
      : [
          ...new Set(real.filter((stop) => !stop.role && stop.localStart).map((stop) => localDate(stop.localStart))),
        ].sort();
  const dayIndex = new Map(dates.map((date, index) => [date, index]));

  const viewStops: TripViewStop[] = real.map((stop) => {
    const photos = photosByStop.get(stop.id) ?? [];
    const own = localDate(stop.localStart);
    const isEnd = stop.role !== null;
    // The start and finish, and a stop without a time, take the first day (the finish the last).
    let date = own;
    if (kind === TripKind.Route && (isEnd || !stop.localStart)) {
      date = (stop.role === 'finish' ? dates.at(-1) : dates[0]) ?? '';
    }
    const timed = kind === TripKind.Route && !isEnd && !!stop.localStart;
    return {
      type: 'stop',
      id: stop.id,
      stop,
      title: stop.title ?? '',
      story: stop.story ?? '',
      region: stop.region ?? '',
      country: stop.country ?? '',
      latitude: stop.latitude,
      longitude: stop.longitude,
      date,
      day: dayIndex.get(date) ?? 0,
      photos,
      isEnd,
      placeId: stop.placeId,
      article: stop.placeId ? articles.get(stop.placeId) : undefined,
      ...span(photos),
      t0: timed ? localTime(stop.localStart) : '—',
      t1: timed ? localTime(stop.localEnd ?? stop.localStart) : '—',
    };
  });

  const days: TripDay[] = dates.map((date, index) => {
    const same = viewStops.filter((stop) => stop.date === date);
    return {
      date,
      color: DAY_COLORS[index % DAY_COLORS.length],
      count: same.reduce((sum, stop) => sum + stop.photos.length, 0),
      regions: [...new Set(same.map(({ region }) => region).filter(Boolean))],
    };
  });

  const stopDay = new Map(viewStops.map((stop) => [stop.id, stop.day]));
  const position = new Map(stops.map((stop, index) => [stop.id, index]));
  // A leg's day is the day of whichever end is shown, else of the nearest shown stop.
  const legDay = (from: string, to: string) => {
    for (const id of [from, to]) {
      const day = stopDay.get(id);
      if (day !== undefined) {
        return day;
      }
    }
    const at = position.get(from) ?? 0;
    let best: { distance: number; day: number } | undefined;
    for (const [id, day] of stopDay) {
      const distance = Math.abs((position.get(id) ?? 0) - at);
      if (!best || distance < best.distance) {
        best = { distance, day };
      }
    }
    return best?.day ?? 0;
  };

  const legs: TripViewLeg[] =
    kind === TripKind.Route
      ? trip.legs
          .filter(({ polyline }) => !!polyline)
          .map((leg) => ({
            ...leg,
            day: legDay(leg.fromStopId, leg.toStopId),
            points: decodePolyline(leg.polyline!),
          }))
      : [];

  // Transit stops between the same two real stops make one item on the leg between them.
  const transit: TripTransit[] = [];
  if (kind === TripKind.Route) {
    const byPair = new Map<string, TripTransit>();
    const stopById = new Map(stops.map((stop) => [stop.id, stop]));
    let previous: TripStopDto | undefined;
    let pending: TripStopDto[] = [];
    for (const stop of stops) {
      if (stop.isTransit) {
        if (previous) {
          pending.push(stop);
        }
        continue;
      }
      for (const way of pending) {
        const photos = photosByStop.get(way.id) ?? [];
        if (photos.length === 0) {
          continue;
        }
        const key = `${previous!.id}:${stop.id}`;
        let item = byPair.get(key);
        if (!item) {
          item = {
            type: 'transit',
            id: way.id,
            fromStopId: previous!.id,
            toStopId: stop.id,
            stopIds: [],
            day: legDay(previous!.id, stop.id),
            latitude: way.latitude,
            longitude: way.longitude,
            photos: [],
            fraction: 0.5,
            videoCount: 0,
            t0: '—',
            t1: '—',
          };
          byPair.set(key, item);
          transit.push(item);
        }
        item.stopIds.push(way.id);
        item.photos.push(...photos);
      }
      pending = [];
      previous = stop;
    }
    for (const item of transit) {
      Object.assign(item, span(item.photos));
      item.fraction = transitFraction(
        stopById.get(item.fromStopId)!,
        stopById.get(item.toStopId)!,
        item.photos.map(({ asset }) => asset.localDateTime),
      );
      const day = days.at(item.day);
      if (day) {
        day.count += item.photos.length;
      }
    }
  }

  const unplacedPhotos = kind === TripKind.Places ? (photosByStop.get(null) ?? []) : [];
  const unplaced: TripUnplaced | undefined =
    unplacedPhotos.length > 0
      ? { type: 'unplaced', id: 'unplaced', day: 0, photos: unplacedPhotos, ...span(unplacedPhotos) }
      : undefined;

  let number = 0;
  for (const stop of viewStops) {
    if (stop.photos.length > 0) {
      stop.number = ++number;
    }
  }

  const order: TripItem[] = [];
  const placedTransit = new Set<TripTransit>();
  for (const stop of viewStops) {
    if (stop.photos.length > 0) {
      order.push(stop);
    }
    for (const item of transit) {
      if (item.fromStopId !== stop.id) {
        continue;
      }

      order.push(item);
      placedTransit.add(item);
    }
  }
  order.push(...transit.filter((item) => !placedTransit.has(item)));
  if (unplaced) {
    order.push(unplaced);
  }

  const km =
    kind === TripKind.Route ? Math.round(trip.legs.reduce((sum, leg) => sum + (leg.distance ?? 0), 0) / 1000) : null;

  return {
    kind,
    albumId: trip.albumId,
    stops: viewStops,
    days,
    legs,
    transit,
    unplaced,
    order,
    photos: order.flatMap(({ photos }) => photos),
    km,
    overlays: trip.overlays,
    isMultiCountry: new Set(viewStops.map(({ country }) => country).filter(Boolean)).size > 1,
  };
};

/** The header numbers: assets, videos, stops with assets, days, km (travel-album map.js stats). */
export const tripStats = (view: TripView) => ({
  assets: view.photos.length,
  videos: view.photos.filter(({ isVideo }) => isVideo).length,
  stops: view.stops.filter(({ photos }) => photos.length > 0).length,
  days: view.days.length,
  km: view.km,
});

/** White or black text on a day colour, whichever reads at 4.5:1 (white preferred). */
export const inkOn = (hex: string) => {
  const channel = (offset: number) => {
    const value = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  const luminance = 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
  return 1.05 / (luminance + 0.05) >= 4.5 ? '#fff' : '#000';
};

/** `t0–t1`, or one time when they are equal. */
export const timeSpan = ({ t0, t1 }: { t0: string; t1: string }) => (t0 === t1 ? t0 : `${t0}–${t1}`);
