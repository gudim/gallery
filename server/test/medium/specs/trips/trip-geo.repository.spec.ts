import { Kysely } from 'kysely';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { DB } from 'src/schema/index.js';
import { TripGeoService } from 'src/trips/enum.js';
import { TripGeoRepository } from 'src/trips/repositories/trip-geo.repository.js';
import { getKyselyDB } from 'test/utils.js';

// The geo cache and rate limit against Postgres, with fetch stubbed: no test reaches the network.
let db: Kysely<DB>;

beforeAll(async () => {
  db = await getKyselyDB();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const newRepository = () => new TripGeoRepository(db, LoggingRepository.create());

describe(TripGeoRepository.name, () => {
  it('stores an answer and serves it again without the network', async () => {
    const sut = newRepository();
    const answer = { trip: { summary: { length: 1.5 } }, list: [1, 2] };
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(Response.json(answer));
    vi.stubGlobal('fetch', fetchMock);
    const request = { service: TripGeoService.Valhalla, json: { costing: 'auto', id: randomUUID() } };

    await expect(sut.fetchJson(request, (data) => data)).resolves.toEqual(answer);
    await expect(sut.fetchJson(request, (data) => data)).resolves.toEqual(answer);

    expect(fetchMock).toHaveBeenCalledOnce();
    const rows = await db
      .selectFrom('trip_geo_cache')
      .selectAll()
      .where('request', 'like', `%${request.json.id}%`)
      .execute();
    expect(rows).toEqual([
      expect.objectContaining({
        service: 'valhalla',
        response: answer,
        request: expect.stringMatching(/^POST https:/),
      }),
    ]);
  });

  it('keeps an empty answer, which is an answer too', async () => {
    const sut = newRepository();
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(Response.json([]));
    vi.stubGlobal('fetch', fetchMock);
    const request = { service: TripGeoService.Nominatim, path: '/search', query: { q: randomUUID() } };

    await expect(sut.fetchJson(request, (data) => data)).resolves.toEqual([]);
    await expect(sut.fetchJson(request, (data) => data)).resolves.toEqual([]);

    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('gives each request to a host its own second', async () => {
    const sut = newRepository();
    const host = `${randomUUID()}.example.org`;

    const delays = await Promise.all([sut.reserveTurn(host), sut.reserveTurn(host), sut.reserveTurn(host)]);

    const sorted = delays.toSorted((a, b) => a - b);
    expect(sorted[0]).toBeLessThan(100);
    expect(sorted[1]).toBeGreaterThan(900);
    expect(sorted[1]).toBeLessThanOrEqual(1000);
    expect(sorted[2]).toBeGreaterThan(1900);
    expect(sorted[2]).toBeLessThanOrEqual(2000);
  });

  it('keeps hosts apart', async () => {
    const sut = newRepository();

    await expect(sut.reserveTurn(`${randomUUID()}.example.org`)).resolves.toBeLessThan(100);
    await expect(sut.reserveTurn(`${randomUUID()}.example.org`)).resolves.toBeLessThan(100);
  });
});
