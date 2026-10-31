import { Check, Column, ForeignKeyColumn, type Generated, PrimaryGeneratedColumn, Table } from '@immich/sql-tools';
import { TripLegMode, TripLegStatus } from 'src/trips/enum.js';
import { TripStopTable } from 'src/trips/schema/tables/trip-stop.table.js';
import { TripTable } from 'src/trips/schema/tables/trip.table.js';

@Table('trip_leg')
@Check({
  name: 'trip_leg_mode_chk',
  expression: `"mode" IN ('foot', 'driving', 'trail', 'direct', 'flight', 'bicycle', 'bus', 'train', 'boat')`,
})
@Check({ name: 'trip_leg_status_chk', expression: `"status" IN ('pending', 'ok', 'attention')` })
export class TripLegTable {
  @PrimaryGeneratedColumn()
  id!: Generated<string>;

  @ForeignKeyColumn(() => TripTable, { onDelete: 'CASCADE', onUpdate: 'CASCADE' })
  albumId!: string;

  @ForeignKeyColumn(() => TripStopTable, { onDelete: 'CASCADE', onUpdate: 'CASCADE' })
  fromStopId!: string;

  @ForeignKeyColumn(() => TripStopTable, { onDelete: 'CASCADE', onUpdate: 'CASCADE' })
  toStopId!: string;

  @Column({ type: 'text' })
  mode!: TripLegMode;

  // The owner picked the mode; the default by distance no longer replaces it.
  @Column({ type: 'boolean', default: false })
  isModeManual!: Generated<boolean>;

  @Column({ type: 'text', default: TripLegStatus.Pending })
  status!: Generated<TripLegStatus>;

  // Encoded polyline of the drawn line.
  @Column({ type: 'text', nullable: true })
  polyline!: string | null;

  // Metres and seconds.
  @Column({ type: 'double precision', nullable: true })
  distance!: number | null;

  @Column({ type: 'double precision', nullable: true })
  duration!: number | null;

  // Train legs: the stations. Empty until found, or picked by the owner.
  @Column({ type: 'text', nullable: true })
  departureName!: string | null;

  @Column({ type: 'double precision', nullable: true })
  departureLatitude!: number | null;

  @Column({ type: 'double precision', nullable: true })
  departureLongitude!: number | null;

  @Column({ type: 'text', nullable: true })
  arrivalName!: string | null;

  @Column({ type: 'double precision', nullable: true })
  arrivalLatitude!: number | null;

  @Column({ type: 'double precision', nullable: true })
  arrivalLongitude!: number | null;
}
