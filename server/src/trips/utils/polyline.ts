import type { LatLng } from 'src/trips/utils/geo.js';

// Encoded polylines (Google's format), ported from travel-album's atlas/geo/polyline.py. A leg keeps precision 6, as
// Valhalla returns it; the web viewer's `decodePolyline` (web/src/lib/trips/trip-view.ts) reads the same format.

export const POLYLINE_PRECISION = 6;

export const encodePolyline = (points: LatLng[], precision = POLYLINE_PRECISION): string => {
  const factor = 10 ** precision;
  let out = '';
  let lastLat = 0;
  let lastLng = 0;
  for (const { latitude, longitude } of points) {
    const lat = Math.round(latitude * factor);
    const lng = Math.round(longitude * factor);
    for (const delta of [lat - lastLat, lng - lastLng]) {
      let value = delta < 0 ? ~(delta << 1) : delta << 1;
      while (value >= 0x20) {
        out += String.fromCodePoint((0x20 | (value & 0x1f)) + 63);
        value >>= 5;
      }
      out += String.fromCodePoint(value + 63);
    }
    lastLat = lat;
    lastLng = lng;
  }
  return out;
};

export const decodePolyline = (encoded: string, precision = POLYLINE_PRECISION): LatLng[] => {
  const factor = 10 ** precision;
  const points: LatLng[] = [];
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
    points.push({ latitude: lat / factor, longitude: lng / factor });
  }
  return points;
};
