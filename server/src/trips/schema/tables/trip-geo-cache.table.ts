import { Check, Column, CreateDateColumn, type Generated, PrimaryColumn, Table, Timestamp } from '@immich/sql-tools';
import { TripGeoService } from 'src/trips/enum.js';

// The permanent cache of the geo services' answers (trips DECISIONS-LOG 2026-10-31), travel-album's route_cache and
// geocode_cache in one table. `key` hashes the whole request, base URL included, so pointing a service at another
// server starts a fresh cache. Only answers the caller could read are stored: after an error the next try goes to the
// network again.
@Table('trip_geo_cache')
@Check({
  name: 'trip_geo_cache_service_chk',
  expression: `"service" IN ('valhalla', 'brouter', 'overpass', 'nominatim')`,
})
export class TripGeoCacheTable {
  @PrimaryColumn({ type: 'text' })
  key!: string;

  @Column({ type: 'text' })
  service!: TripGeoService;

  // The request the key hashes (method, URL and body), for whoever reads the table.
  @Column({ type: 'text' })
  request!: string;

  @Column({ type: 'jsonb' })
  response!: unknown;

  @CreateDateColumn()
  createdAt!: Generated<Timestamp>;
}
