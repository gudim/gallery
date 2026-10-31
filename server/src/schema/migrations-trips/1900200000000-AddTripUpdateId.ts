import { Kysely, sql } from 'kysely';

// `updated_at()`, the trigger on "trip", also stamps "updateId", which the table lacked: every UPDATE of a trip failed.
// The column only holds that stamp, so down() has nothing to move back.

export async function up(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE "trip" ADD "updateId" uuid NOT NULL DEFAULT immich_uuid_v7();`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE "trip" DROP COLUMN "updateId";`.execute(db);
}
