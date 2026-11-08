import { posix } from 'node:path';
import type { ServerResponse } from 'node:http';

// The trips APK and gallery-trips.json are static web files under /trips-app/ (trips DECISIONS-LOG 2026-11-08).
// The web's static file server knows no type for .apk and sends an empty one, so a browser sniffs the APK as the zip it
// is and saves it as .zip. Called from that server's setHeaders, whose headers it keeps.
export const setTripsAppHeaders = (res: ServerResponse, pathname: string) => {
  if (!pathname.startsWith('/trips-app/')) {
    return;
  }
  const file = posix.basename(pathname);
  if (file.endsWith('.apk')) {
    res.setHeader('Content-Type', 'application/vnd.android.package-archive');
    res.setHeader('Content-Disposition', `attachment; filename="${file.replaceAll('"', '')}"`);
  } else if (file === 'gallery-trips.json') {
    // The update check must see a new release at once.
    res.setHeader('Cache-Control', 'no-cache');
  }
};
