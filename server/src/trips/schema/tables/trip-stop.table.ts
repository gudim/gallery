import {
  Check,
  Column,
  ForeignKeyColumn,
  type Generated,
  Index,
  PrimaryGeneratedColumn,
  Table,
  Timestamp,
} from '@immich/sql-tools';
import { TripStopRole } from 'src/trips/enum.js';
import { TripPlaceTable } from 'src/trips/schema/tables/trip-place.table.js';
import { TripTable } from 'src/trips/schema/tables/trip.table.js';

@Table('trip_stop')
@Check({ name: 'trip_stop_role_chk', expression: `"role" IN ('origin', 'finish')` })
@Index({ name: 'trip_stop_albumId_role_idx', columns: ['albumId', 'role'], unique: true, where: '"role" IS NOT NULL' })
@Index({ name: 'trip_stop_albumId_localStart_idx', columns: ['albumId', 'localStart'] })
export class TripStopTable {
  @PrimaryGeneratedColumn()
  id!: Generated<string>;

  @ForeignKeyColumn(() => TripTable, { onDelete: 'CASCADE', onUpdate: 'CASCADE', index: false })
  albumId!: string;

  @ForeignKeyColumn(() => TripPlaceTable, { onDelete: 'SET NULL', onUpdate: 'CASCADE', nullable: true })
  placeId!: string | null;

  @Column({ type: 'double precision', nullable: true })
  latitude!: number | null;

  @Column({ type: 'double precision', nullable: true })
  longitude!: number | null;

  // The owner moved the pin; re-filing keeps it.
  @Column({ type: 'boolean', default: false })
  isPositionManual!: Generated<boolean>;

  // Local wall-clock time stored as if UTC, like asset.localDateTime, which filing compares it with.
  @Column({ type: 'timestamp with time zone', nullable: true })
  localStart!: Timestamp | null;

  @Column({ type: 'timestamp with time zone', nullable: true })
  localEnd!: Timestamp | null;

  // Orders stops that start at the same time, such as manual points set after one stop.
  @Column({ type: 'integer', default: 0 })
  sequence!: Generated<number>;

  @Column({ type: 'text', nullable: true })
  title!: string | null;

  @Column({ type: 'text', nullable: true })
  titleSource!: string | null;

  @Column({ type: 'text', nullable: true })
  story!: string | null;

  @Column({ type: 'text', nullable: true })
  storySource!: string | null;

  @Column({ type: 'text', nullable: true })
  region!: string | null;

  @Column({ type: 'text', nullable: true })
  country!: string | null;

  // A point the owner set by hand, not a cluster of assets.
  @Column({ type: 'boolean', default: false })
  isManualPoint!: Generated<boolean>;

  // Start or finish of a route: a stop without assets.
  @Column({ type: 'text', nullable: true })
  role!: TripStopRole | null;

  @Column({ type: 'boolean', default: false })
  isSameAsOrigin!: Generated<boolean>;

  // Shot on the way: true yes, false the owner declined, null not decided.
  @Column({ type: 'boolean', nullable: true })
  isTransit!: boolean | null;

  // Places trips: "<centre>, no exact place", assets the owner filed to the centre.
  @Column({ type: 'boolean', default: false })
  isAtCenter!: Generated<boolean>;
}
