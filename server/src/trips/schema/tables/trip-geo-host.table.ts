import { Column, PrimaryColumn, Table, type Timestamp } from '@immich/sql-tools';

// The geo services' rate limit, one row per host: the time given to the newest request to it. The API and
// microservices workers are separate processes, so the limit lives in the database (trips DECISIONS-LOG 2026-10-31).
@Table('trip_geo_host')
export class TripGeoHostTable {
  @PrimaryColumn({ type: 'text' })
  host!: string;

  @Column({ type: 'timestamp with time zone' })
  requestAt!: Timestamp;
}
