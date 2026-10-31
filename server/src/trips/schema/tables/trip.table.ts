import {
  Check,
  Column,
  CreateDateColumn,
  ForeignKeyColumn,
  type Generated,
  Table,
  Timestamp,
  UpdateDateColumn,
} from '@immich/sql-tools';
import { UpdateIdColumn, UpdatedAtTrigger } from 'src/decorators.js';
import { AlbumTable } from 'src/schema/tables/album.table.js';
import { TripKind } from 'src/trips/enum.js';

// A trip is an overlay on an Immich album (trips ADR 0001): its id is the album's, and deleting the album deletes it.
@Table('trip')
@UpdatedAtTrigger('trip_updatedAt')
@Check({ name: 'trip_kind_chk', expression: `"kind" IN ('route', 'places', 'plain')` })
export class TripTable {
  @ForeignKeyColumn(() => AlbumTable, { onDelete: 'CASCADE', onUpdate: 'CASCADE', primary: true, index: false })
  albumId!: string;

  @Column({ type: 'text' })
  kind!: TripKind;

  // The album owner's Favorites trip (trips PLAN D15): a Places trip, at most one per owner.
  @Column({ type: 'boolean', default: false })
  isFavorites!: Generated<boolean>;

  // Marked for the owner's showcase, and picked by an admin for the home page (trips PLAN D14).
  @Column({ type: 'boolean', default: false })
  isShowcased!: Generated<boolean>;

  @Column({ type: 'boolean', default: false })
  isFeatured!: Generated<boolean>;

  // The language its stops are named in (trips PLAN D13): the owner's locale when the trip was made. Null: the
  // instance's first naming language.
  @Column({ type: 'text', nullable: true })
  language!: string | null;

  // Bumped by every change a guest can see, so viewers can cache by it.
  @Column({ type: 'integer', default: 0 })
  contentVersion!: Generated<number>;

  @CreateDateColumn()
  createdAt!: Generated<Timestamp>;

  @UpdateDateColumn()
  updatedAt!: Generated<Timestamp>;

  @UpdateIdColumn()
  updateId!: Generated<string>;
}
