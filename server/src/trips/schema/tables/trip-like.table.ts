import {
  Check,
  Column,
  CreateDateColumn,
  ForeignKeyColumn,
  ForeignKeyConstraint,
  type Generated,
  PrimaryGeneratedColumn,
  Table,
  Timestamp,
  Unique,
} from '@immich/sql-tools';
import { AlbumAssetTable } from 'src/schema/tables/album-asset.table.js';
import { UserTable } from 'src/schema/tables/user.table.js';
import { TripTable } from 'src/trips/schema/tables/trip.table.js';

// One like of an asset in a trip, by a signed-in user or a guest's browser key; one per liker. NULLs never collide
// in a unique constraint, so both pairs are unique without partial indexes. Keyed to the album_asset row, like the
// filing, so it goes when the asset leaves the album.
@Table('trip_like')
@ForeignKeyConstraint({
  columns: ['albumId', 'assetId'],
  referenceTable: () => AlbumAssetTable,
  referenceColumns: ['albumId', 'assetId'],
  index: false,
  onUpdate: 'CASCADE',
  onDelete: 'CASCADE',
})
@Check({ name: 'trip_like_liker_chk', expression: `num_nonnulls("userId", "viewerKey") = 1` })
@Unique({ columns: ['albumId', 'assetId', 'userId'] })
@Unique({ columns: ['albumId', 'assetId', 'viewerKey'] })
export class TripLikeTable {
  @PrimaryGeneratedColumn()
  id!: Generated<string>;

  @ForeignKeyColumn(() => TripTable, { onDelete: 'CASCADE', onUpdate: 'CASCADE', index: false })
  albumId!: string;

  @Column({ type: 'uuid' })
  assetId!: string;

  @ForeignKeyColumn(() => UserTable, { onDelete: 'CASCADE', onUpdate: 'CASCADE', nullable: true })
  userId!: string | null;

  @Column({ type: 'text', nullable: true })
  viewerKey!: string | null;

  @CreateDateColumn()
  createdAt!: Generated<Timestamp>;
}
