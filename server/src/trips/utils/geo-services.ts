import { createHash } from 'node:crypto';
import { serverVersion } from 'src/constants.js';
import { TripGeoService } from 'src/trips/enum.js';

// Where routing and naming go and how they introduce themselves (trips DECISIONS-LOG 2026-10-31). The defaults are the
// public servers travel-album calls; each one, and the User-Agent, can be replaced by an environment variable.

export const tripGeoUrlVariables: Record<TripGeoService, string> = {
  [TripGeoService.Valhalla]: 'TRIPS_VALHALLA_URL',
  [TripGeoService.BRouter]: 'TRIPS_BROUTER_URL',
  [TripGeoService.Overpass]: 'TRIPS_OVERPASS_URL',
  [TripGeoService.Nominatim]: 'TRIPS_NOMINATIM_URL',
};

export const TRIPS_USER_AGENT_VARIABLE = 'TRIPS_USER_AGENT';

const defaultUrls: Record<TripGeoService, string> = {
  [TripGeoService.Valhalla]: 'https://valhalla1.openstreetmap.de/route',
  [TripGeoService.BRouter]: 'https://brouter.de/brouter',
  [TripGeoService.Overpass]: 'https://overpass-api.de/api/interpreter',
  [TripGeoService.Nominatim]: 'https://nominatim.openstreetmap.org',
};

// travel-album's timeouts: a route or a station search may take a while, a geocode should not.
const timeoutsMs: Record<TripGeoService, number> = {
  [TripGeoService.Valhalla]: 40_000,
  [TripGeoService.BRouter]: 40_000,
  [TripGeoService.Overpass]: 40_000,
  [TripGeoService.Nominatim]: 20_000,
};

/** At most one request per this many milliseconds to each host. */
export const TRIP_GEO_INTERVAL_MS = 1000;

export type TripGeoConfig = {
  urls: Record<TripGeoService, string>;
  userAgent: string;
};

// Nominatim's usage policy asks for a User-Agent that names the application; a library's default is refused.
export const defaultTripGeoUserAgent = () =>
  `gallery-server/${serverVersion} trips (+https://github.com/gudim/gallery)`;

export const resolveTripGeoConfig = (env: NodeJS.ProcessEnv = process.env): TripGeoConfig => {
  const urls = { ...defaultUrls };
  for (const service of Object.values(TripGeoService)) {
    const variable = tripGeoUrlVariables[service];
    const value = env[variable]?.trim();
    if (!value) {
      continue;
    }
    if (!URL.canParse(value) || !/^https?:$/.test(new URL(value).protocol)) {
      throw new Error(`${variable} is not an http(s) URL: ${value}`);
    }
    urls[service] = value;
  }
  return { urls, userAgent: env[TRIPS_USER_AGENT_VARIABLE]?.trim() || defaultTripGeoUserAgent() };
};

/**
 * One call to a geo service. GET by default; `json` posts a JSON body (Valhalla), `form` a form (Overpass). `path` is
 * appended to the service's URL, `query` becomes its query string in key order, so the same request always has the
 * same cache key.
 */
export type TripGeoRequest = {
  service: TripGeoService;
  path?: string;
  query?: Record<string, string | number | boolean>;
  json?: unknown;
  form?: Record<string, string>;
};

export type TripGeoHttpRequest = {
  service: TripGeoService;
  method: 'GET' | 'POST';
  url: string;
  host: string;
  body?: string;
  contentType?: string;
  timeoutMs: number;
  /** Method, URL and body: what the cache key hashes. */
  description: string;
  key: string;
};

const sortedEntries = <T>(record: Record<string, T>) =>
  Object.entries(record).toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

export const buildTripGeoRequest = (request: TripGeoRequest, config: TripGeoConfig): TripGeoHttpRequest => {
  const url = new URL(config.urls[request.service].replace(/\/+$/, '') + (request.path ?? ''));
  for (const [name, value] of sortedEntries(request.query ?? {})) {
    url.searchParams.append(name, String(value));
  }

  let body: string | undefined;
  let contentType: string | undefined;
  if (request.json !== undefined) {
    body = JSON.stringify(request.json);
    contentType = 'application/json';
  } else if (request.form) {
    body = new URLSearchParams(sortedEntries(request.form)).toString();
    contentType = 'application/x-www-form-urlencoded';
  }

  const method = body === undefined ? 'GET' : 'POST';
  const description = body === undefined ? `${method} ${url.href}` : `${method} ${url.href}\n${body}`;
  return {
    service: request.service,
    method,
    url: url.href,
    host: url.host,
    body,
    contentType,
    timeoutMs: timeoutsMs[request.service],
    description,
    key: createHash('sha256').update(description).digest('hex'),
  };
};
