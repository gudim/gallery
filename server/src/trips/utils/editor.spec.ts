import { describe, expect, it } from 'vitest';
import { TripStopRole } from 'src/trips/enum.js';
import { OrderedStop, placeAfter, transitSpans } from 'src/trips/utils/editor.js';

const at = (time: string) => new Date(`2026-05-01T${time}:00.000Z`);
const stop = (id: string, start: string | null, end = start, role: TripStopRole | null = null): OrderedStop => ({
  id,
  role,
  localStart: start === null ? null : at(start),
  localEnd: end === null ? null : at(end),
});

const ORDER = [
  stop('start', null, null, TripStopRole.Start),
  stop('a', '10:00', '11:00'),
  stop('b', '11:00', '12:00'),
  stop('finish', null, null, TripStopRole.Finish),
];

describe(placeAfter.name, () => {
  it('places a point after a stop at that stop’s end', () => {
    expect(placeAfter(ORDER, 'p', 'a')).toEqual({
      localTime: at('11:00'),
      sequences: [
        { id: 'p', sequence: 0 },
        { id: 'b', sequence: 1 },
      ],
    });
  });

  it('places a point right after the start without a time, before earlier points', () => {
    const order = [...ORDER.slice(0, 1), stop('q', null), ...ORDER.slice(1)];

    expect(placeAfter(order, 'p', null)).toEqual({
      localTime: null,
      sequences: [
        { id: 'p', sequence: 0 },
        { id: 'q', sequence: 1 },
      ],
    });
    expect(placeAfter(order, 'p', 'start')).toEqual(placeAfter(order, 'p', null));
    expect(placeAfter(order, 'p', 'q')).toMatchObject({ sequences: [{ id: 'q' }, { id: 'p' }] });
  });

  it('refuses the finish and a stop of another trip', () => {
    expect(placeAfter(ORDER, 'p', 'finish')).toBe('finish');
    expect(placeAfter(ORDER, 'p', 'elsewhere')).toBe('missing');
  });
});

describe(transitSpans.name, () => {
  it('maps transit stops to the real stops around them, and leaves out one without a stop before it', () => {
    const spans = transitSpans([
      { id: 't0', isTransit: true },
      { id: 'a', isTransit: null },
      { id: 't1', isTransit: true },
      { id: 't2', isTransit: true },
      { id: 'b', isTransit: false },
      { id: 't3', isTransit: true },
    ]);

    expect(Object.fromEntries(spans)).toEqual({ t1: ['a', 'b'], t2: ['a', 'b'] });
  });
});
