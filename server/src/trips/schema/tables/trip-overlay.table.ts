import { Check, Column, ForeignKeyColumn, type Generated, PrimaryGeneratedColumn, Table } from '@immich/sql-tools';
import { TripOverlayKind } from 'src/trips/enum.js';
import { TripTable } from 'src/trips/schema/tables/trip.table.js';

// A fixed drawing on the trip map (GLOSSARY.md "Overlay"): a trail line or the mask around visited countries.
@Table('trip_overlay')
@Check({ name: 'trip_overlay_kind_chk', expression: `"kind" IN ('trail', 'mask')` })
export class TripOverlayTable {
  @PrimaryGeneratedColumn()
  id!: Generated<string>;

  @ForeignKeyColumn(() => TripTable, { onDelete: 'CASCADE', onUpdate: 'CASCADE' })
  albumId!: string;

  @Column({ type: 'text' })
  kind!: TripOverlayKind;

  @Column({ type: 'text', nullable: true })
  color!: string | null;

  // GeoJSON geometry.
  @Column({ type: 'jsonb' })
  geometry!: object;
}
