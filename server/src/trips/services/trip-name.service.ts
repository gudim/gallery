import { Injectable } from '@nestjs/common';
import type { JobOf } from 'src/types.js';
import { OnJob } from 'src/decorators.js';
import { JobName, JobStatus, QueueName } from 'src/enum.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { TripKind, TripStopRole } from 'src/trips/enum.js';
import { TripGeoRepository } from 'src/trips/repositories/trip-geo.repository.js';
import { TripNameRepository, TripStopName } from 'src/trips/repositories/trip-name.repository.js';
import { LatLng } from 'src/trips/utils/geo.js';
import {
  followsStart,
  hasPlaceNames,
  isUntitled,
  namesByDistrict,
  nominatimReverseRequest,
  parseNominatimReverse,
  resolveTripNamingLanguages,
  stopTitle,
  tripNamingLanguages,
} from 'src/trips/utils/naming.js';

// Names stops through Nominatim (trips PLAN D13), as travel-album's geocode_stops and geocode_langs jobs did.
@Injectable()
export class TripNameService {
  private readonly languages: string[];

  constructor(
    private logger: LoggingRepository,
    private tripNameRepository: TripNameRepository,
    private tripGeoRepository: TripGeoRepository,
  ) {
    this.logger.setContext(TripNameService.name);
    this.languages = resolveTripNamingLanguages();
  }

  /**
   * Gives a title, region and country to every stop of the trip that has a point and no title; a title anyone wrote
   * stays (trips PLAN D12), and a finish at the start takes the start's name. A stop with names also gets Nominatim's
   * answers in the other languages, which stay in the geo cache for search (travel-album PLAN §5.15). The requests
   * run outside any transaction, one per second; the names are written in one at the end, where a stop named or
   * moved meanwhile is left as it is. A failed request ends the asking, keeps what was found, and fails the job; the
   * nightly sweep queues it again.
   */
  @OnJob({ name: JobName.TripName, queue: QueueName.TripNetwork })
  async handleName({ id }: JobOf<JobName.TripName>): Promise<JobStatus> {
    const trip = await this.tripNameRepository.getStopsToName(id);
    if (!trip || trip.kind === TripKind.Plain) {
      return JobStatus.Skipped;
    }

    const { language, otherLanguages } = tripNamingLanguages(trip.language, this.languages);
    const byDistrict = namesByDistrict(trip.kind);
    const finishes = trip.stops.filter((stop) => followsStart(stop) && isUntitled(stop));
    const names: TripStopName[] = [];
    let status = JobStatus.Success;
    try {
      for (const stop of trip.stops) {
        const isNamed = !isUntitled(stop);
        if (followsStart(stop) || (isNamed && !hasPlaceNames(stop))) {
          continue;
        }
        const found = await this.reverse(stop, language);
        if (!found) {
          continue;
        }
        for (const other of otherLanguages) {
          await this.reverse(stop, other);
        }
        const title = isNamed ? null : stopTitle(found, byDistrict);
        if (!title) {
          continue;
        }
        const name = { title, region: found.region, country: found.country };
        names.push({ ...readAs(stop), ...name });
        if (stop.role === TripStopRole.Start) {
          names.push(...finishes.map((finish) => ({ ...readAs(finish), ...name })));
        }
      }
    } catch (error) {
      this.logger.warn(`Naming the stops of trip ${id} stopped: ${error}`);
      status = JobStatus.Failed;
    }

    const named = await this.tripNameRepository.nameStops(id, names);
    this.logger.debug(
      `Named ${named} of ${names.length} stops of trip ${id} in ${[language, ...otherLanguages].join(', ')}`,
    );
    return status;
  }

  private reverse(point: LatLng, language: string) {
    return this.tripGeoRepository.fetchJson(nominatimReverseRequest(point, language), parseNominatimReverse);
  }
}

// What the stop was when read: the write checks it is still so.
const readAs = ({ id, latitude, longitude, titleSource }: Omit<TripStopName, 'title' | 'region' | 'country'>) => ({
  id,
  latitude,
  longitude,
  titleSource,
});
