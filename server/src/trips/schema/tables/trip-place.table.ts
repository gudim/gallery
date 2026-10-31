import { Column, ForeignKeyColumn, type Generated, PrimaryGeneratedColumn, Table, Unique } from '@immich/sql-tools';
import { TripTable } from 'src/trips/schema/tables/trip.table.js';

// A place of a trip and its article. `key` names the place within the trip, so stops of visits years apart can share it.
@Table('trip_place')
@Unique({ columns: ['albumId', 'key'] })
export class TripPlaceTable {
  @PrimaryGeneratedColumn()
  id!: Generated<string>;

  @ForeignKeyColumn(() => TripTable, { onDelete: 'CASCADE', onUpdate: 'CASCADE', index: false })
  albumId!: string;

  @Column({ type: 'text' })
  key!: string;

  @Column({ type: 'text', nullable: true })
  title!: string | null;

  @Column({ type: 'text', nullable: true })
  article!: string | null;

  // Who wrote the article (the owner, an LLM, ...), so generation never overwrites the owner's text.
  @Column({ type: 'text', nullable: true })
  articleSource!: string | null;
}
