import { describe, expect, it } from 'vitest';
import type { ServerResponse } from 'node:http';
import { setTripsAppHeaders } from 'src/trips/utils/trips-app-headers.js';

const headersFor = (pathname: string) => {
  const headers: Record<string, string> = {};
  const res = { setHeader: (name: string, value: string) => (headers[name] = value) } as unknown as ServerResponse;
  setTripsAppHeaders(res, pathname);
  return headers;
};

describe(setTripsAppHeaders.name, () => {
  it('sends the APK as an Android package to save under its name', () => {
    expect(headersFor('/trips-app/gallery-trips-v5.10.0.3.apk')).toEqual({
      'Content-Type': 'application/vnd.android.package-archive',
      'Content-Disposition': 'attachment; filename="gallery-trips-v5.10.0.3.apk"',
    });
  });

  it('keeps gallery-trips.json out of caches', () => {
    expect(headersFor('/trips-app/gallery-trips.json')).toEqual({ 'Cache-Control': 'no-cache' });
  });

  it.each(['/favicon.png', '/_app/immutable/app.js', '/other/app.apk'])('leaves %s alone', (pathname) => {
    expect(headersFor(pathname)).toEqual({});
  });
});
