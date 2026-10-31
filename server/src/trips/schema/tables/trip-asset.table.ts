import { Check, Column, ForeignKeyColumn, ForeignKeyConstraint, Table } from '@immich/sql-tools';
import { AlbumAssetTable } from 'src/schema/tables/album-asset.table.js';
import { TripPointSource } from 'src/trips/enum.js';
import { TripStopTable } from 'src/trips/schema/tables/trip-stop.table.js';
import { TripTable } from 'src/trips/schema/tables/trip.table.js';

// Where an album asset is filed in the trip. Keyed to the album_asset row, so removing the asset from the album or
// deleting it for good drops its filing; an asset in the trash keeps it. No row, or no stop: the asset is Unplaced.
@Table('trip_asset')
@ForeignKeyConstraint({
  columns: ['albumId', 'assetId'],
  referenceTable: () => AlbumAssetTable,
  referenceColumns: ['albumId', 'assetId'],
  index: false,
  onUpdate: 'CASCADE',
  onDelete: 'CASCADE',
})
@Check({ name: 'trip_asset_pointSource_chk', expression: `"pointSource" IN ('inferred', 'manual')` })
@Check({
  name: 'trip_asset_point_chk',
  expression: `("pointSource" IS NULL) = ("latitude" IS NULL) AND ("latitude" IS NULL) = ("longitude" IS NULL)`,
})
export class TripAssetTable {
  @ForeignKeyColumn(() => TripTable, { onDelete: 'CASCADE', onUpdate: 'CASCADE', primary: true, index: false })
  albumId!: string;

  @Column({ type: 'uuid', primary: true })
  assetId!: string;

  @ForeignKeyColumn(() => TripStopTable, { onDelete: 'SET NULL', onUpdate: 'CASCADE', nullable: true })
  stopId!: string | null;

  // An inferred or manual point (GLOSSARY.md): it belongs to the trip and is never written to the asset (trips PLAN D10).
  @Column({ type: 'double precision', nullable: true })
  latitude!: number | null;

  @Column({ type: 'double precision', nullable: true })
  longitude!: number | null;

  @Column({ type: 'text', nullable: true })
  pointSource!: TripPointSource | null;
}
