import { TripGeoService, TripKind, TripStopRole } from 'src/trips/enum.js';
import { TripGeoRequest } from 'src/trips/utils/geo-services.js';
import { LatLng } from 'src/trips/utils/geo.js';

// Naming stops through Nominatim (trips PLAN D13), ported from travel-album's atlas/geo/nominatim.py. Pure: no I/O.

/** The title source of a name Nominatim gave, as travel-album wrote it (the migration keeps it). */
export const TRIP_TITLE_SOURCE_GEOCODED = 'geocoded';

export const TRIPS_GEO_LANGS_VARIABLE = 'TRIPS_GEO_LANGS';

// travel-album's ATLAS_GEO_LANG (`ru`) and its other interface language (`en`).
const DEFAULT_LANGS = ['ru', 'en'];

const LANGUAGE_TAG = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;

/**
 * A language tag as Nominatim's `accept-language` takes it, or null when it is not one: `_` becomes `-` (Gallery's web
 * locales are `zh_Hans`, `pt_BR`), the language is lower case, a script title case and a region upper case.
 */
export const normalizeTripLanguage = (value: string): string | null => {
  const [language, ...subtags] = value.trim().replaceAll('_', '-').split('-');
  const tag = [
    language.toLowerCase(),
    ...subtags.map((subtag) =>
      /^[a-z]{4}$/i.test(subtag)
        ? subtag[0].toUpperCase() + subtag.slice(1).toLowerCase()
        : /^[a-z]{2}$/i.test(subtag)
          ? subtag.toUpperCase()
          : subtag,
    ),
  ].join('-');
  return LANGUAGE_TAG.test(tag) ? tag : null;
};

/**
 * The instance's naming languages (`TRIPS_GEO_LANGS`, comma separated): the first names the stops of a trip that has
 * no language of its own, the rest are asked for too and kept in the geo cache, where search finds a place by its name
 * in another language (travel-album PLAN §5.15).
 */
export const resolveTripNamingLanguages = (env: NodeJS.ProcessEnv = process.env): string[] => {
  const value = env[TRIPS_GEO_LANGS_VARIABLE]?.trim();
  if (!value) {
    return DEFAULT_LANGS;
  }
  const langs = value
    .split(',')
    .filter((lang) => lang.trim())
    .map((lang) => normalizeTripLanguage(lang));
  if (langs.length === 0 || langs.includes(null)) {
    throw new Error(`${TRIPS_GEO_LANGS_VARIABLE} is not a comma separated list of language codes: ${value}`);
  }
  return [...new Set(langs as string[])];
};

/**
 * The language a trip's stops are named in, the trip's own (the owner's locale when it was made) or else the
 * instance's first, and every instance language but that one, asked for search (trips DECISIONS-LOG 2026-10-31,
 * owner). An instance language that differs from the trip's only by a region (`ru` for `ru-RU`) is the same language,
 * since OpenStreetMap names carry no region and Nominatim gives the same names, so it is not asked again
 * (DECISIONS-LOG 2026-11-01, owner).
 */
export const tripNamingLanguages = (tripLanguage: string | null, instance: string[]) => {
  const language = tripLanguage ?? instance[0];
  return { language, otherLanguages: instance.filter((other) => withoutRegion(other) !== withoutRegion(language)) };
};

// A normalized tag without its region (`RU`, `419`); a script (`Hant`) stays, since OpenStreetMap names carry one.
const withoutRegion = (tag: string) =>
  tag
    .split('-')
    .filter((subtag, index) => index === 0 || !/^([A-Z]{2}|\d{3})$/.test(subtag))
    .join('-');

/**
 * Nominatim's reverse geocode of a point in one language. The whole answer is cached, with the address and the
 * object's names; coordinates keep six decimals, so a stop at the same point reuses the answer.
 */
export const nominatimReverseRequest = ({ latitude, longitude }: LatLng, lang: string): TripGeoRequest => ({
  service: TripGeoService.Nominatim,
  path: '/reverse',
  query: {
    lat: latitude.toFixed(6),
    lon: longitude.toFixed(6),
    zoom: 18,
    format: 'jsonv2',
    addressdetails: 1,
    namedetails: 1,
    'accept-language': lang,
  },
});

// travel-album `nominatim.SEARCH_LIMIT`: the places a search offers.
const SEARCH_LIMIT = 5;

/**
 * Nominatim's search for a place by address or name, for the editor's point picker (travel-album `nominatim.search`).
 * The query is folded to single spaces and lower case, so the same search reuses the cached answer.
 */
export const nominatimSearchRequest = (query: string, lang: string): TripGeoRequest => ({
  service: TripGeoService.Nominatim,
  path: '/search',
  query: {
    q: normalizeTripGeoQuery(query),
    limit: SEARCH_LIMIT,
    format: 'jsonv2',
    addressdetails: 1,
    namedetails: 1,
    'accept-language': lang,
  },
});

export const normalizeTripGeoQuery = (query: string) => query.split(/\s+/).filter(Boolean).join(' ').toLowerCase();

/** What naming takes from a Nominatim answer. */
export type TripPlaceNames = {
  label: string;
  region: string | null;
  district: string | null;
  country: string | null;
};

const text = (value: unknown) => (typeof value === 'string' && value.trim() ? value.trim() : null);

/**
 * A reverse answer's names, or null when Nominatim knows no place there (`{"error": ...}`, which is cached like any
 * answer). The region is the settlement, else the county; the district a part of it that is not the region itself.
 * Throws on an answer that is neither, so it is not cached.
 */
export const parseNominatimReverse = (data: unknown): TripPlaceNames | null => {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    throw new Error('Nominatim answered with something that is not a place');
  }
  const answer = data as Record<string, unknown>;
  if ('error' in answer) {
    return null;
  }
  const address = (typeof answer.address === 'object' && answer.address !== null ? answer.address : {}) as Record<
    string,
    unknown
  >;
  const region = text(address.city) ?? text(address.town) ?? text(address.village) ?? text(address.county);
  const district = text(address.quarter) ?? text(address.suburb) ?? text(address.neighbourhood);
  const displayName = typeof answer.display_name === 'string' ? answer.display_name : '';
  return {
    label: text(answer.name) ?? displayName.split(', ').slice(0, 2).join(', ').trim(),
    region,
    district: district === region ? null : district,
    country: text(address.country),
  };
};

/**
 * A stop's title from its names: the region, else the label. A Places trip names "city — district", since dozens of
 * its places share a city.
 */
export const stopTitle = (names: TripPlaceNames, byDistrict: boolean): string | null => {
  if (byDistrict && names.region && names.district) {
    return `${names.region} — ${names.district}`;
  }
  return names.region || names.label || null;
};

/** Places trips (the Favorites trip among them) name by district; a Plain trip has no map and is not named. */
export const namesByDistrict = (kind: TripKind) => kind === TripKind.Places;

export type TripStopToName = LatLng & {
  id: string;
  role: TripStopRole | null;
  isFinishAtStart: boolean;
  title: string | null;
  titleSource: string | null;
  region: string | null;
  country: string | null;
};

/** A stop with no title gets one; a title anyone wrote stays (trips PLAN D12). */
export const isUntitled = ({ title }: { title: string | null }) => !title?.trim();

/**
 * A stop that has a name from Nominatim, whose other languages search reads (travel-album `_geocoded`): it has a
 * region or a country, or a title naming gave.
 */
export const hasPlaceNames = (stop: Pick<TripStopToName, 'region' | 'country' | 'titleSource'>) =>
  !!(stop.region || stop.country || stop.titleSource === TRIP_TITLE_SOURCE_GEOCODED);

/** A finish at the start is not asked for: it follows the start. */
export const followsStart = (stop: Pick<TripStopToName, 'role' | 'isFinishAtStart'>) =>
  stop.role === TripStopRole.Finish && stop.isFinishAtStart;

/** A place a search or a reverse geocode found: its names and point. */
export type TripGeoPlace = TripPlaceNames & LatLng;

const placeOf = (data: unknown): TripGeoPlace | null => {
  const names = parseNominatimReverse(data);
  const { lat, lon } = data as Record<string, unknown>;
  const [latitude, longitude] = [Number(lat), Number(lon)];
  return names && Number.isFinite(latitude) && Number.isFinite(longitude) ? { ...names, latitude, longitude } : null;
};

/** The places of a search answer, at most five. Throws on an answer that is not a list, so it is not cached. */
export const parseNominatimSearch = (data: unknown): TripGeoPlace[] => {
  if (!Array.isArray(data)) {
    throw new TypeError('Nominatim answered a search with something that is not a list');
  }
  return data
    .slice(0, SEARCH_LIMIT)
    .map((item) => placeOf(item))
    .filter((place) => place !== null);
};

/** The place at a point, or null when Nominatim knows none there. */
export const parseNominatimPlace = (data: unknown): TripGeoPlace | null => placeOf(data);
