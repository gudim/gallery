import { Injectable } from '@nestjs/common';
import { Kysely, sql } from 'kysely';
import { InjectKysely } from 'nestjs-kysely';
import { setTimeout as sleep } from 'node:timers/promises';
import { DummyValue, GenerateSql } from 'src/decorators.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { DB } from 'src/schema/index.js';
import { TripGeoService } from 'src/trips/enum.js';
import {
  TRIP_GEO_INTERVAL_MS,
  TripGeoConfig,
  TripGeoHttpRequest,
  TripGeoRequest,
  buildTripGeoRequest,
  resolveTripGeoConfig,
} from 'src/trips/utils/geo-services.js';

/** A geo service did not answer, or answered with an error or with something that is not JSON. Never cached. */
export class TripGeoError extends Error {
  constructor(
    readonly service: TripGeoService,
    message: string,
    options?: ErrorOptions,
  ) {
    super(`${service}: ${message}`, options);
    this.name = 'TripGeoError';
  }
}

// The one way trips reach Valhalla, BRouter, Overpass and Nominatim (travel-album atlas/geo/{routecache,ratelimit}.py):
// the permanent cache first, then at most one request per second per host across every worker process, then the
// network with a timeout. Request builders and response parsing are the callers'.
@Injectable()
export class TripGeoRepository {
  readonly config: TripGeoConfig;

  constructor(
    @InjectKysely() private db: Kysely<DB>,
    private logger: LoggingRepository,
  ) {
    this.logger.setContext(TripGeoRepository.name);
    this.config = resolveTripGeoConfig();
  }

  /**
   * The service's answer to `request`, read by `parse`. A cached answer is parsed without a request. A fresh answer is
   * stored only once `parse` accepts it, so a service error, a timeout, or an answer `parse` throws on (no route, say)
   * is tried on the network again next time. `parse`'s error reaches the caller as it is.
   */
  async fetchJson<T>(request: TripGeoRequest, parse: (data: unknown) => T): Promise<T> {
    const http = buildTripGeoRequest(request, this.config);
    const cached = await this.getCached(http.key);
    if (cached) {
      return parse(cached.response);
    }

    await this.waitForTurn(http.host);
    const data = await this.send(http);
    const result = parse(data);
    await this.putCached(http, data);
    return result;
  }

  @GenerateSql({ params: [DummyValue.STRING] })
  getCached(key: string) {
    return this.db.selectFrom('trip_geo_cache').select('response').where('key', '=', key).executeTakeFirst();
  }

  async putCached(http: TripGeoHttpRequest, data: unknown): Promise<void> {
    await this.db
      .insertInto('trip_geo_cache')
      .values({ key: http.key, service: http.service, request: http.description, response: data })
      .onConflict((oc) =>
        oc.column('key').doUpdateSet((eb) => ({
          service: eb.ref('excluded.service'),
          request: eb.ref('excluded.request'),
          response: eb.ref('excluded.response'),
          createdAt: sql`now()`,
        })),
      )
      .execute();
  }

  /**
   * Books the host's next free moment, at least TRIP_GEO_INTERVAL_MS after the one booked before it, and returns how
   * many milliseconds are left until it. The row lock of the upsert orders concurrent callers in every process, and
   * the database clock is the only clock involved.
   */
  @GenerateSql({ params: [DummyValue.STRING] })
  async reserveTurn(host: string): Promise<number> {
    const { delay } = await this.db
      .insertInto('trip_geo_host')
      .values({ host, requestAt: sql`clock_timestamp()` })
      .onConflict((oc) =>
        oc.column('host').doUpdateSet({
          requestAt: sql`greatest(clock_timestamp(), "trip_geo_host"."requestAt" + ${TRIP_GEO_INTERVAL_MS} * interval '1 millisecond')`,
        }),
      )
      .returning(sql<string>`greatest(0, extract(epoch from ("requestAt" - clock_timestamp())) * 1000)`.as('delay'))
      .executeTakeFirstOrThrow();
    return Math.ceil(Number(delay));
  }

  private async waitForTurn(host: string): Promise<void> {
    const delay = await this.reserveTurn(host);
    if (delay > 0) {
      await sleep(delay);
    }
  }

  private async send(http: TripGeoHttpRequest): Promise<unknown> {
    this.logger.debug(`Requesting ${http.description}`);
    const headers: Record<string, string> = { 'User-Agent': this.config.userAgent, Accept: 'application/json' };
    if (http.contentType) {
      headers['Content-Type'] = http.contentType;
    }

    let response: Response;
    try {
      response = await fetch(http.url, {
        method: http.method,
        headers,
        body: http.body,
        signal: AbortSignal.timeout(http.timeoutMs),
      });
    } catch (error) {
      throw new TripGeoError(http.service, `no answer from ${http.host}: ${error}`, { cause: error });
    }
    if (!response.ok) {
      throw new TripGeoError(http.service, `${http.host} answered ${response.status} ${response.statusText}`);
    }
    try {
      return await response.json();
    } catch (error) {
      throw new TripGeoError(http.service, `${http.host} answered with something that is not JSON`, { cause: error });
    }
  }
}
