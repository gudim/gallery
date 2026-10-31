import { Kysely, sql } from 'kysely';

// The language a trip's stops are named in (trips PLAN D13, DECISIONS-LOG 2026-10-31). It has no older home, so down()
// has nothing to move back; the stops keep the names it gave.

export async function up(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE "trip" ADD "language" text;`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE "trip" DROP COLUMN "language";`.execute(db);
}
