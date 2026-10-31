import { Kysely, sql } from 'kysely';

// The asset's local time when the trip last placed it, so filing sees a time changed since, by the clock-offset
// wizard or any date edit, and lets the trip follow (trips PLAN D9, DECISIONS-LOG 2026-10-31). It is read again from
// the asset, so down() has nothing to move back.

export async function up(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE "trip_asset" ADD "localDateTime" timestamp with time zone;`.execute(db);
  await sql`
    UPDATE "trip_asset" SET "localDateTime" = "asset"."localDateTime"
    FROM "asset" WHERE "asset"."id" = "trip_asset"."assetId";
  `.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE "trip_asset" DROP COLUMN "localDateTime";`.execute(db);
}
