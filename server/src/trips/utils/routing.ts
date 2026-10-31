import type { TripGeoRequest } from 'src/trips/utils/geo-services.js';
import { TripGeoService } from 'src/trips/enum.js';
import { TripGeoError } from 'src/trips/repositories/trip-geo.repository.js';
import { type LatLng, haversineM, round6 } from 'src/trips/utils/geo.js';
import { decodePolyline } from 'src/trips/utils/polyline.js';

// Requests to the routers and to Overpass, and readers of their answers (travel-album atlas/geo/{valhalla,brouter,
// overpass}.py). Pure: TripGeoRepository sends the requests and caches what a reader accepts. A reader throws a
// TripGeoError when the answer holds no route, so that answer is not cached and a retry asks again.

/** A line along roads or rails: points in order, length in metres, time in seconds. */
export type RoutedLine = { points: LatLng[]; distance: number; duration: number };

export type Station = { name: string; latitude: number; longitude: number };
/** A station near a point; `distance` in whole metres from it. */
export type StationCandidate = Station & { distance: number };

export type ValhallaCosting = 'pedestrian' | 'auto' | 'bicycle' | 'bus';
export type BRouterProfile = 'rail' | 'river';

const fixed6 = (value: number) => value.toFixed(6);

export const valhallaRequest = (costing: ValhallaCosting, a: LatLng, b: LatLng): TripGeoRequest => ({
  service: TripGeoService.Valhalla,
  json: {
    locations: [a, b].map(({ latitude, longitude }) => ({ lat: round6(latitude), lon: round6(longitude) })),
    costing,
    directions_options: { units: 'kilometers' },
  },
});

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;
const isNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

// Valhalla: `trip.legs[].shape` are polylines of precision 6, `trip.summary` has kilometres and seconds.
export const parseValhalla = (data: unknown): RoutedLine => {
  const trip = isRecord(data) ? data.trip : undefined;
  const legs = isRecord(trip) ? trip.legs : undefined;
  const summary = isRecord(trip) ? trip.summary : undefined;
  if (!Array.isArray(legs) || !isRecord(summary) || !isNumber(summary.length) || !isNumber(summary.time)) {
    throw new TripGeoError(TripGeoService.Valhalla, 'the answer holds no route');
  }
  const points = legs.flatMap((leg) =>
    isRecord(leg) && typeof leg.shape === 'string' ? decodePolyline(leg.shape) : [],
  );
  if (points.length < 2) {
    throw new TripGeoError(TripGeoService.Valhalla, 'the answer holds no route');
  }
  return { points, distance: summary.length * 1000, duration: summary.time };
};

export const brouterRequest = (profile: BRouterProfile, a: LatLng, b: LatLng): TripGeoRequest => ({
  service: TripGeoService.BRouter,
  query: {
    lonlats: `${fixed6(a.longitude)},${fixed6(a.latitude)}|${fixed6(b.longitude)},${fixed6(b.latitude)}`,
    profile,
    alternativeidx: 0,
    format: 'geojson',
  },
});

// BRouter: a GeoJSON feature collection; the first feature's coordinates are [lon, lat, elevation], its properties
// carry `track-length` (m) and `total-time` (s) as strings.
export const parseBRouter = (data: unknown): RoutedLine => {
  const features = isRecord(data) ? data.features : undefined;
  const feature: unknown = Array.isArray(features) ? features[0] : undefined;
  const geometry = isRecord(feature) ? feature.geometry : undefined;
  const coordinates = isRecord(geometry) ? geometry.coordinates : undefined;
  const properties = isRecord(feature) ? feature.properties : undefined;
  const distance = Number(isRecord(properties) ? properties['track-length'] : NaN);
  const duration = Number(isRecord(properties) ? properties['total-time'] : NaN);
  if (!Array.isArray(coordinates) || !Number.isFinite(distance) || !Number.isFinite(duration)) {
    throw new TripGeoError(TripGeoService.BRouter, 'the answer holds no route');
  }
  const points = coordinates.flatMap((point) =>
    Array.isArray(point) && isNumber(point[0]) && isNumber(point[1])
      ? [{ latitude: point[1], longitude: point[0] }]
      : [],
  );
  if (points.length < 2) {
    throw new TripGeoError(TripGeoService.BRouter, 'the answer holds no route');
  }
  return { points, distance, duration };
};

/** How far from a stop a train station is looked for, and how many are offered (travel-album overpass.py). */
export const STATION_RADIUS_M = 3000;
export const STATION_LIMIT = 5;

export const stationsRequest = ({ latitude, longitude }: LatLng): TripGeoRequest => ({
  service: TripGeoService.Overpass,
  form: {
    data:
      `[out:json][timeout:25];` +
      `node["railway"~"^(station|halt)$"](around:${STATION_RADIUS_M},${fixed6(latitude)},${fixed6(longitude)});out;`,
  },
});

/** The answer's stations nearest `point` first, at most STATION_LIMIT. An empty answer is an answer: none nearby. */
export const parseStations =
  (point: LatLng) =>
  (data: unknown): StationCandidate[] => {
    const elements = isRecord(data) ? data.elements : undefined;
    if (!Array.isArray(elements)) {
      throw new TripGeoError(TripGeoService.Overpass, 'the answer holds no stations');
    }
    return elements
      .flatMap((element) => {
        if (!isRecord(element) || element.type !== 'node' || !isNumber(element.lat) || !isNumber(element.lon)) {
          return [];
        }
        // The station's own name, as Overpass has it (trips DECISIONS-LOG 2026-10-31).
        const name = isRecord(element.tags) && typeof element.tags.name === 'string' ? element.tags.name : '';
        const station = { name, latitude: element.lat, longitude: element.lon };
        return [{ ...station, distance: Math.round(haversineM(point, station)) }];
      })
      .toSorted((a, b) => a.distance - b.distance)
      .slice(0, STATION_LIMIT);
  };

/** Whether `station` is one of `offered`: the same name and, to 1e-7°, the same point. */
export const isOffered = (station: Station, offered: Station[]) =>
  offered.some(
    (candidate) =>
      candidate.name === station.name &&
      Math.abs(candidate.latitude - station.latitude) < 1e-7 &&
      Math.abs(candidate.longitude - station.longitude) < 1e-7,
  );
