import { describe, expect, it } from 'vitest';
import { decodePolyline, encodePolyline } from 'src/trips/utils/polyline.js';

describe('polyline', () => {
  it('encodes Google’s example at precision 5', () => {
    const points = [
      { latitude: 38.5, longitude: -120.2 },
      { latitude: 40.7, longitude: -120.95 },
      { latitude: 43.252, longitude: -126.453 },
    ];
    expect(encodePolyline(points, 5)).toBe('_p~iF~ps|U_ulLnnqC_mqNvxq`@');
    expect(decodePolyline('_p~iF~ps|U_ulLnnqC_mqNvxq`@', 5)).toEqual(points);
  });

  // The web viewer's decodePolyline test reads the same string.
  it('keeps legs at precision 6, as Valhalla does', () => {
    expect(encodePolyline([{ latitude: 38.5, longitude: -120.2 }])).toBe('_izlhA~rlgdF');
    expect(decodePolyline('_izlhA~rlgdF')).toEqual([{ latitude: 38.5, longitude: -120.2 }]);
  });

  it('round-trips points across the globe to six decimals', () => {
    const points = [
      { latitude: 54.687157, longitude: 25.279652 },
      { latitude: -33.86882, longitude: 151.20929 },
      { latitude: 64.1466, longitude: -21.9426 },
      { latitude: -89.999999, longitude: 179.999999 },
      { latitude: 0, longitude: -180 },
    ];
    expect(decodePolyline(encodePolyline(points))).toEqual(points);
  });

  it('encodes nothing as an empty string', () => {
    expect(encodePolyline([])).toBe('');
    expect(decodePolyline('')).toEqual([]);
  });
});
