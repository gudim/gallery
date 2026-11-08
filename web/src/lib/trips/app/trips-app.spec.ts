import { loadTripsApp, parseTripsApp, tripsAppUrl } from '$lib/trips/app/trips-app';

const app = { version: 'v5.10.0.2', versionCode: 5_100_002, file: 'gallery-trips-v5.10.0.2.apk', size: 1 };

// A fetch answering with `body` parsed as JSON, as the browser's would.
const respond = (body: string, status = 200) =>
  vi.fn().mockResolvedValue({ ok: status === 200, json: () => Promise.resolve(JSON.parse(body) as unknown) });

describe('parseTripsApp', () => {
  it('reads the fields the app needs', () => {
    expect(parseTripsApp(app)).toEqual({ version: 'v5.10.0.2', versionCode: 5_100_002, file: app.file });
  });

  it.each([
    ['null', null],
    ['a string', 'x'],
    ['a missing file', { ...app, file: undefined }],
    ['a text version code', { ...app, versionCode: '5100002' }],
    ['a file that is not an apk', { ...app, file: 'index.html' }],
    ['a file outside the folder', { ...app, file: '../secret.apk' }],
  ])('refuses %s', (_, value) => {
    expect(parseTripsApp(value)).toBeUndefined();
  });
});

describe('loadTripsApp', () => {
  it('reads gallery-trips.json', async () => {
    const fetchFn = respond(JSON.stringify(app));
    await expect(loadTripsApp(fetchFn)).resolves.toMatchObject({ file: app.file });
    expect(fetchFn).toHaveBeenCalledWith('/trips-app/gallery-trips.json', { cache: 'no-cache' });
  });

  it('is absent when the server has no app', async () => {
    await expect(loadTripsApp(respond('', 404))).resolves.toBeUndefined();
  });

  it("is absent when the web's page answers instead", async () => {
    await expect(loadTripsApp(respond('<!doctype html><html></html>'))).resolves.toBeUndefined();
  });

  it('is absent when the request fails', async () => {
    await expect(loadTripsApp(vi.fn().mockRejectedValue(new Error('offline')))).resolves.toBeUndefined();
  });
});

describe('tripsAppUrl', () => {
  it('points into the folder', () => {
    expect(tripsAppUrl(parseTripsApp(app)!)).toBe('/trips-app/gallery-trips-v5.10.0.2.apk');
  });
});
