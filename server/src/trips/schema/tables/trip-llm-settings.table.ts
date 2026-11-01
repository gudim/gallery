import { Column, ForeignKeyColumn, type Generated, Table } from '@immich/sql-tools';
import { UserTable } from 'src/schema/tables/user.table.js';

// A user's OpenAI-compatible server for trip texts (trips PLAN D16, DECISIONS-LOG 2026-11-01). The key is encrypted
// with TRIPS_LLM_SECRET (trips ADR 0003) and never leaves the server.
@Table('trip_llm_settings')
export class TripLlmSettingsTable {
  @ForeignKeyColumn(() => UserTable, { onDelete: 'CASCADE', onUpdate: 'CASCADE', primary: true, index: false })
  userId!: string;

  @Column({ type: 'text' })
  url!: string;

  @Column({ type: 'text' })
  model!: string;

  @Column({ type: 'text', nullable: true })
  keyCipher!: string | null;

  // The user agreed to send their photos to that server (travel-album's allow_upload).
  @Column({ type: 'boolean', default: false })
  allowUpload!: Generated<boolean>;
}
