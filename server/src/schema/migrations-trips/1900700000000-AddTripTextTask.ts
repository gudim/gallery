import { Kysely, sql } from 'kysely';

// The stops and places of a text generation run until their texts are written (trips PLAN §2.6). They hold no text,
// only work in progress, so down() has no data to move back and drops them; the texts already written stay.

export async function up(db: Kysely<any>): Promise<void> {
  await sql`CREATE TABLE "trip_text_task" (
  "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
  "albumId" uuid NOT NULL,
  "stopId" uuid,
  "placeId" uuid,
  "overwrite" boolean NOT NULL DEFAULT false,
  "attempt" integer NOT NULL DEFAULT 1,
  "isQueued" boolean NOT NULL DEFAULT false,
  "error" text,
  "createdAt" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "trip_text_task_albumId_fkey" FOREIGN KEY ("albumId") REFERENCES "trip" ("albumId") ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT "trip_text_task_stopId_fkey" FOREIGN KEY ("stopId") REFERENCES "trip_stop" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT "trip_text_task_placeId_fkey" FOREIGN KEY ("placeId") REFERENCES "trip_place" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT "trip_text_task_target_chk" CHECK (num_nonnulls("stopId", "placeId") = 1),
  CONSTRAINT "trip_text_task_pkey" PRIMARY KEY ("id")
);`.execute(db);
  await sql`CREATE INDEX "trip_text_task_albumId_idx" ON "trip_text_task" ("albumId");`.execute(db);
  await sql`CREATE INDEX "trip_text_task_stopId_idx" ON "trip_text_task" ("stopId");`.execute(db);
  await sql`CREATE INDEX "trip_text_task_placeId_idx" ON "trip_text_task" ("placeId");`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP TABLE "trip_text_task";`.execute(db);
}
