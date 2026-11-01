import { Kysely, sql } from 'kysely';

// The texts a run read when it started, so "replace my texts too" replaces only those, also on a later attempt or a
// retry, never a text typed since (trips DECISIONS-LOG 2026-11-01). Work in progress only, so down() drops it.

export async function up(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE "trip_text_task" ADD "seen" jsonb;`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE "trip_text_task" DROP COLUMN "seen";`.execute(db);
}
