import { TripLegMode } from 'src/trips/enum.js';

// Geometry for trip layout, ported from travel-album's atlas/geo/{cluster,valhalla}.py. Pure: no I/O.

export type LatLng = { latitude: number; longitude: number };

const EARTH_RADIUS_M = 6_371_000;
// ROUTE_FOOT_MAX_M (travel-album PLAN §5.11): a leg shorter than this in a straight line is walked by default.
export const FOOT_MAX_M = 2000;

const radians = (degrees: number) => (degrees * Math.PI) / 180;

export const haversineM = (a: LatLng, b: LatLng): number => {
  const p1 = radians(a.latitude);
  const p2 = radians(b.latitude);
  const dp = radians(b.latitude - a.latitude);
  const dl = radians(b.longitude - a.longitude);
  const h = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(h));
};

export const defaultMode = (straightM: number, footMaxM = FOOT_MAX_M): TripLegMode =>
  straightM < footMaxM ? TripLegMode.Foot : TripLegMode.Driving;

// A routed line is believable when it is no longer than max(4 × straight, straight + 2 km).
export const isPlausible = (distanceM: number, straightM: number): boolean =>
  distanceM <= Math.max(4 * straightM, straightM + 2000);

export const FLIGHT_BEND = 0.2;
export const BOAT_BEND = 0.1;

// A flight or open-water leg is drawn as a quadratic Bézier bent north by `bend` of the chord. It is computed in a
// plane where longitude shrinks by cos(mean latitude), so the arc looks symmetric on the map. A picture, not a great
// circle: the real path is unknown.
export const arc = (a: LatLng, b: LatLng, bend = FLIGHT_BEND, segments = 32): LatLng[] => {
  const k = Math.cos(radians((a.latitude + b.latitude) / 2));
  const [ax, ay, bx, by] = [a.longitude * k, a.latitude, b.longitude * k, b.latitude];
  let px = -(by - ay) * bend;
  let py = (bx - ax) * bend;
  if (py < 0 || (py === 0 && px < 0)) {
    [px, py] = [-px, -py];
  }
  const cx = (ax + bx) / 2 + px;
  const cy = (ay + by) / 2 + py;
  const points: LatLng[] = [];
  for (let i = 0; i <= segments; i++) {
    const t = i / segments;
    const x = (1 - t) ** 2 * ax + 2 * (1 - t) * t * cx + t ** 2 * bx;
    const y = (1 - t) ** 2 * ay + 2 * (1 - t) * t * cy + t ** 2 * by;
    points.push({ latitude: y, longitude: x / k });
  }
  return points;
};
