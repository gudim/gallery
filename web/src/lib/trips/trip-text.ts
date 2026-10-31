import { TripKind } from '@immich/sdk';
import type { MessageFormatter } from 'svelte-i18n';
import type { TripItem, TripPhoto, TripView } from '$lib/trips/trip-view';

// Texts the trip viewer derives from its model (travel-album static/viewer/map.js and road.js). `t` is svelte-i18n's
// formatter, `lang` the locale for dates.

type Translate = MessageFormatter;

const utc = (date: string) => new Date(`${date}T00:00:00Z`);

/** "8 августа", "August 8" */
export const dayLabel = (date: string, lang: string) =>
  date ? new Intl.DateTimeFormat(lang, { day: 'numeric', month: 'long', timeZone: 'UTC' }).format(utc(date)) : '';

/** "8 августа 2026 г.", "August 8, 2026" */
export const longDate = (date: string, lang: string) =>
  date
    ? new Intl.DateTimeFormat(lang, { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }).format(
        utc(date),
      )
    : '';

/** A date or a range of dates, as Intl writes ranges in the language. */
export const dateRange = (dates: string[], lang: string) => {
  const sorted = dates.filter(Boolean).sort();
  if (sorted.length === 0) {
    return '';
  }
  const first = sorted[0];
  const last = sorted.at(-1)!;
  if (first === last) {
    return longDate(first, lang);
  }
  return new Intl.DateTimeFormat(lang, { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }).formatRange(
    utc(first),
    utc(last),
  );
};

/** "2019–2024", or one year */
export const yearSpan = (photos: TripPhoto[]) => {
  const years = [...new Set(photos.map(({ date }) => date.slice(0, 4)).filter(Boolean))].sort();
  if (years.length === 0) {
    return '';
  }
  return years.length === 1 ? years[0] : `${years[0]}–${years.at(-1)}`;
};

/** The title of an item in lists and the lightbox. */
export const itemTitle = (item: TripItem, view: TripView, t: Translate, lang: string) => {
  if (item.type === 'unplaced') {
    return t('trips_unplaced');
  }
  if (item.type === 'transit') {
    const name = (id: string) => {
      const stop = view.stops.find((candidate) => candidate.id === id);
      return stop?.title || stop?.region || '…';
    };
    return t('trips_transit_title', { values: { from: name(item.fromStopId), to: name(item.toStopId) } });
  }
  return item.title || item.region || longDate(item.date, lang);
};

/** The header line under the title: the dates and days of a route, or places, assets and years. */
export const rangeLine = (view: TripView, t: Translate, lang: string, withAssets = false) => {
  if (view.kind === TripKind.Places) {
    const places = view.stops.filter(({ photos }) => photos.length > 0).length;
    const parts = [t('trips_places_count', { values: { count: places } })];
    if (withAssets) {
      parts.push(t('trips_assets_count', { values: { count: view.photos.length } }));
    }
    const years = yearSpan(view.photos);
    if (years) {
      parts.push(years);
    }
    return parts.join(' · ');
  }
  if (view.days.length === 0) {
    return '';
  }
  const first = view.days[0].date;
  const last = view.days.at(-1)!.date;
  return t('trips_range', {
    values: {
      from: dayLabel(first, lang),
      to: dayLabel(last, lang),
      year: last.slice(0, 4),
      count: view.days.length,
    },
  });
};
