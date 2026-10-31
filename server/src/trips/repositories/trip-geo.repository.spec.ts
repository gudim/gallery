import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { DB } from 'src/schema/index.js';
import { TripGeoService } from 'src/trips/enum.js';
import { TripGeoError, TripGeoRepository } from 'src/trips/repositories/trip-geo.repository.js';

// The flow of fetchJson with the database calls stubbed; the SQL itself is covered by
// test/medium/specs/trips/trip-geo.repository.spec.ts.
const request = { service: TripGeoService.Nominatim, path: '/reverse', query: { lat: 1, lon: 2 } };
const answer = { display_name: 'Somewhere' };

const setup = () => {
  const sut = new TripGeoRepository({} as Kysely<DB>, LoggingRepository.create());
  const getCached = vi.spyOn(sut, 'getCached').mockResolvedValue(undefined);
  const putCached = vi.spyOn(sut, 'putCached').mockResolvedValue();
  const reserveTurn = vi.spyOn(sut, 'reserveTurn').mockResolvedValue(0);
  const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(Response.json(answer));
  vi.stubGlobal('fetch', fetchMock);
  return { sut, getCached, putCached, reserveTurn, fetchMock };
};

describe(TripGeoRepository.name, () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('answers from the cache without a request', async () => {
    const { sut, getCached, reserveTurn, fetchMock } = setup();
    getCached.mockResolvedValue({ response: answer });

    await expect(sut.fetchJson(request, (data) => data)).resolves.toEqual(answer);

    expect(reserveTurn).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('asks the network with its User-Agent and stores the answer', async () => {
    const { sut, putCached, reserveTurn, fetchMock } = setup();

    await expect(sut.fetchJson(request, (data) => data)).resolves.toEqual(answer);

    expect(reserveTurn).toHaveBeenCalledWith('nominatim.openstreetmap.org');
    expect(fetchMock).toHaveBeenCalledWith(
      'https://nominatim.openstreetmap.org/reverse?lat=1&lon=2',
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({ 'User-Agent': sut.config.userAgent }),
      }),
    );
    expect(putCached).toHaveBeenCalledWith(expect.objectContaining({ service: TripGeoService.Nominatim }), answer);
  });

  it('waits for its turn before the request', async () => {
    const { sut, reserveTurn, fetchMock } = setup();
    reserveTurn.mockResolvedValue(1000);

    const result = sut.fetchJson(request, (data) => data);
    await vi.advanceTimersByTimeAsync(999);
    expect(fetchMock).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await expect(result).resolves.toEqual(answer);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('does not store an answer the parser refuses', async () => {
    const { sut, putCached } = setup();

    await expect(
      sut.fetchJson(request, () => {
        throw new Error('no route');
      }),
    ).rejects.toThrow('no route');
    expect(putCached).not.toHaveBeenCalled();
  });

  it('does not store an error status', async () => {
    const { sut, putCached, fetchMock } = setup();
    fetchMock.mockResolvedValue(new Response('busy', { status: 429, statusText: 'Too Many Requests' }));

    await expect(sut.fetchJson(request, (data) => data)).rejects.toThrow(TripGeoError);
    expect(putCached).not.toHaveBeenCalled();
  });

  it('does not store an answer that is not JSON', async () => {
    const { sut, putCached, fetchMock } = setup();
    fetchMock.mockResolvedValue(new Response('<html>'));

    await expect(sut.fetchJson(request, (data) => data)).rejects.toThrow('not JSON');
    expect(putCached).not.toHaveBeenCalled();
  });

  it('reports a request that fails', async () => {
    const { sut, putCached, fetchMock } = setup();
    fetchMock.mockRejectedValue(new DOMException('The operation was aborted due to timeout', 'TimeoutError'));

    await expect(sut.fetchJson(request, (data) => data)).rejects.toThrow('nominatim: no answer from');
    expect(putCached).not.toHaveBeenCalled();
  });
});
