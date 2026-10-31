import { Column, ForeignKeyColumn, Table } from '@immich/sql-tools';
import { AssetTable } from 'src/schema/tables/asset.table.js';

// The caption an LLM last wrote for an asset (trips DECISIONS-LOG 2026-10-31). The caption itself is the Immich
// description (trips ADR 0002); generation may replace it only while it is empty or still equals this text, so an
// edit made anywhere, even in a stock app, is the owner's. Keyed by asset: an asset has one caption in every trip.
@Table('trip_generated_caption')
export class TripGeneratedCaptionTable {
  @ForeignKeyColumn(() => AssetTable, { onDelete: 'CASCADE', onUpdate: 'CASCADE', primary: true, index: false })
  assetId!: string;

  @Column({ type: 'text' })
  text!: string;
}
