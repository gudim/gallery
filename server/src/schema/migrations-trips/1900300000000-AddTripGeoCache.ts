import { Kysely, sql } from 'kysely';

// The geo services' cache and rate limit (trips PLAN §2.5). Both hold only what the network can give again, so down()
// has no data to move back and drops them.

export async function up(db: Kysely<any>): Promise<void> {
  await sql`CREATE TABLE "trip_geo_cache" (
  "key" text NOT NULL,
  "service" text NOT NULL,
  "request" text NOT NULL,
  "response" jsonb NOT NULL,
  "createdAt" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "trip_geo_cache_service_chk" CHECK ("service" IN ('valhalla', 'brouter', 'overpass', 'nominatim')),
  CONSTRAINT "trip_geo_cache_pkey" PRIMARY KEY ("key")
);`.execute(db);
  await sql`CREATE TABLE "trip_geo_host" (
  "host" text NOT NULL,
  "requestAt" timestamp with time zone NOT NULL,
  CONSTRAINT "trip_geo_host_pkey" PRIMARY KEY ("host")
);`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP TABLE "trip_geo_host";`.execute(db);
  await sql`DROP TABLE "trip_geo_cache";`.execute(db);
}
