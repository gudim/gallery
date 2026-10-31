import { describe, expect, it } from 'vitest';
import { TripLegMode } from 'src/trips/enum.js';
import { BOAT_BEND, arc, defaultMode, haversineM, isPlausible } from 'src/trips/utils/geo.js';

const warsaw = { latitude: 52.2297, longitude: 21.0122 };
const krakow = { latitude: 50.0647, longitude: 19.945 };

describe('haversineM', () => {
  it('measures great-circle distance', () => {
    expect(haversineM(warsaw, krakow)).toBeCloseTo(252_000, -3);
    expect(haversineM(warsaw, warsaw)).toBe(0);
  });
});

describe('defaultMode', () => {
  it('walks under 2 km and drives from there', () => {
    expect(defaultMode(1999)).toBe(TripLegMode.Foot);
    expect(defaultMode(2000)).toBe(TripLegMode.Driving);
    expect(defaultMode(2500, 3000)).toBe(TripLegMode.Foot);
  });
});

describe('isPlausible', () => {
  it('allows up to max(4 × straight, straight + 2 km)', () => {
    expect(isPlausible(4000, 1000)).toBe(true);
    expect(isPlausible(4001, 1000)).toBe(false);
    expect(isPlausible(2100, 100)).toBe(true);
    expect(isPlausible(2101, 100)).toBe(false);
  });
});

const middleBend = (line: ReturnType<typeof arc>, a: typeof warsaw, b: typeof warsaw) => {
  const middle = line[Math.floor(line.length / 2)];
  const chord = { latitude: (a.latitude + b.latitude) / 2, longitude: (a.longitude + b.longitude) / 2 };
  return { middle, bend: haversineM(middle, chord) / haversineM(a, b) };
};

describe('arc', () => {
  it('draws a flight as a symmetric curve between the stops, bent north', () => {
    const line = arc(warsaw, krakow);
    expect(line).toHaveLength(33);
    expect(line[0].latitude).toBeCloseTo(warsaw.latitude, 6);
    expect(line[0].longitude).toBeCloseTo(warsaw.longitude, 6);
    expect(line.at(-1)!.latitude).toBeCloseTo(krakow.latitude, 6);
    expect(line.at(-1)!.longitude).toBeCloseTo(krakow.longitude, 6);
    const { middle, bend } = middleBend(line, warsaw, krakow);
    expect(haversineM(middle, warsaw) / haversineM(middle, krakow)).toBeCloseTo(1, 1);
    expect(bend).toBeGreaterThan(0.05);
  });

  it('bends north whichever way the leg goes', () => {
    const east = { latitude: 52, longitude: 30 };
    for (const [a, b] of [
      [warsaw, east],
      [east, warsaw],
    ]) {
      const middle = arc(a, b)[16];
      expect(middle.latitude).toBeGreaterThan(52.5);
    }
  });

  it('bends a boat half as much as a flight', () => {
    const far = { latitude: warsaw.latitude + 0.045, longitude: warsaw.longitude };
    const { bend } = middleBend(arc(warsaw, far, BOAT_BEND), warsaw, far);
    expect(bend).toBeGreaterThan(0.03);
    expect(bend).toBeLessThan(0.07);
  });
});
