import {
  Check,
  Column,
  CreateDateColumn,
  ForeignKeyColumn,
  type Generated,
  PrimaryGeneratedColumn,
  Table,
  Timestamp,
} from '@immich/sql-tools';
import { TripPlaceTable } from 'src/trips/schema/tables/trip-place.table.js';
import { TripStopTable } from 'src/trips/schema/tables/trip-stop.table.js';
import { TripTable } from 'src/trips/schema/tables/trip.table.js';

// One stop or place of a text generation run (trips PLAN §2.6) until its texts are written: pending while `error` is
// null, failed for good after it. A new run of the trip replaces every row, so a job whose row is gone does nothing.
@Table('trip_text_task')
@Check({ name: 'trip_text_task_target_chk', expression: `num_nonnulls("stopId", "placeId") = 1` })
export class TripTextTaskTable {
  @PrimaryGeneratedColumn()
  id!: Generated<string>;

  @ForeignKeyColumn(() => TripTable, { onDelete: 'CASCADE', onUpdate: 'CASCADE' })
  albumId!: string;

  @ForeignKeyColumn(() => TripStopTable, { onDelete: 'CASCADE', onUpdate: 'CASCADE', nullable: true })
  stopId!: string | null;

  @ForeignKeyColumn(() => TripPlaceTable, { onDelete: 'CASCADE', onUpdate: 'CASCADE', nullable: true })
  placeId!: string | null;

  // Replace the owner's texts too ("replace my texts too").
  @Column({ type: 'boolean', default: false })
  overwrite!: Generated<boolean>;

  @Column({ type: 'integer', default: 1 })
  attempt!: Generated<number>;

  // A place waits for the stops: its article is written from their stories.
  @Column({ type: 'boolean', default: false })
  isQueued!: Generated<boolean>;

  @Column({ type: 'text', nullable: true })
  error!: string | null;

  @CreateDateColumn()
  createdAt!: Generated<Timestamp>;
}
