import { TripGeoService, TripKind, TripStopRole } from 'src/trips/enum.js';
import { TripGeoRequest } from 'src/trips/utils/geo-services.js';
import { LatLng } from 'src/trips/utils/geo.js';

// Naming stops through Nominatim (trips PLAN D13), ported from travel-album's atlas/geo/nominatim.py. Pure: no I/O.

/** The title source of a name Nominatim gave, as travel-album wrote it (the migration keeps it). */
export const TRIP_TITLE_SOURCE_GEOCODED = 'geocoded';

export const TRIPS_GEO_LANGS_VARIABLE = 'TRIPS_GEO_LANGS';

// travel-album's ATLAS_GEO_LANG (`ru`) and its other interface language (`en`). Immich keeps no user locale on the
// server, so the languages are the instance's, not the owner's (trips DECISIONS-LOG 2026-10-31).
const DEFAULT_LANGS = ['ru', 'en'];

/**
 * The languages stops are named in: the first names them, the rest are asked for too and kept in the geo cache, where
 * search finds a place by its name in another language (travel-album PLAN §5.15). `TRIPS_GEO_LANGS` is a comma
 * separated list of Nominatim `accept-language` codes.
 */
export const resolveTripNamingLanguages = (env: NodeJS.ProcessEnv = process.env): string[] => {
  const value = env[TRIPS_GEO_LANGS_VARIABLE]?.trim();
  if (!value) {
    return DEFAULT_LANGS;
  }
  const langs = [...new Set(value.split(',').map((lang) => lang.trim()))].filter(Boolean);
  const invalid = langs.find((lang) => !/^[a-z]{2,3}(-[a-z0-9]{2,8})*$/i.test(lang));
  if (langs.length === 0 || invalid !== undefined) {
    throw new Error(`${TRIPS_GEO_LANGS_VARIABLE} is not a comma separated list of language codes: ${value}`);
  }
  return langs;
};

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
