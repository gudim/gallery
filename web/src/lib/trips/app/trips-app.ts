// The trips Android app on this server (trips DECISIONS-LOG 2026-11-08): trips-release-server.yml lays the APK and
// gallery-trips.json into the web's static files under /trips-app/. A server without them (a local build, stock
// Gallery) answers with the web's page or an error, and the app is then absent.

export const TRIPS_APP_PATH = '/trips-app';

export type TripsApp = {
  /** The image tag the APK was built with, e.g. v5.10.0.2 */
  version: string;
  versionCode: number;
  /** The APK's file name under TRIPS_APP_PATH */
  file: string;
};

export const parseTripsApp = (value: unknown): TripsApp | undefined => {
  if (typeof value !== 'object' || value === null) {
    return undefined;
  }
  const { version, versionCode, file } = value as Record<string, unknown>;
  if (
    typeof version !== 'string' ||
    typeof versionCode !== 'number' ||
    typeof file !== 'string' ||
    !/^[\w.-]+\.apk$/.test(file)
  ) {
    return undefined;
  }
  return { version, versionCode, file };
};

export const loadTripsApp = async (fetchFn: typeof fetch = fetch): Promise<TripsApp | undefined> => {
  try {
    const response = await fetchFn(`${TRIPS_APP_PATH}/gallery-trips.json`, { cache: 'no-cache' });
    if (!response.ok) {
      return undefined;
    }
    return parseTripsApp(await response.json());
  } catch {
    return undefined;
  }
};

export const tripsAppUrl = (app: TripsApp) => `${TRIPS_APP_PATH}/${app.file}`;
