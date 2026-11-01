import { Kysely, sql } from 'kysely';

// Each user's LLM settings for trip texts (trips PLAN §2.6). They have no older home, so down() has nothing to move
// back and drops them; the texts already generated stay.

export async function up(db: Kysely<any>): Promise<void> {
  await sql`CREATE TABLE "trip_llm_settings" (
  "userId" uuid NOT NULL,
  "url" text NOT NULL,
  "model" text NOT NULL,
  "keyCipher" text,
  "allowUpload" boolean NOT NULL DEFAULT false,
  CONSTRAINT "trip_llm_settings_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT "trip_llm_settings_pkey" PRIMARY KEY ("userId")
);`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP TABLE "trip_llm_settings";`.execute(db);
}
