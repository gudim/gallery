import { Kysely, sql } from 'kysely';

// The trip model (trips PLAN §2.1). Trips have no earlier home, so down() has no data to move back and drops them.

export async function up(db: Kysely<any>): Promise<void> {
  await sql`CREATE TABLE "trip" (
  "albumId" uuid NOT NULL,
  "kind" text NOT NULL,
  "isFavorites" boolean NOT NULL DEFAULT false,
  "isShowcased" boolean NOT NULL DEFAULT false,
  "isFeatured" boolean NOT NULL DEFAULT false,
  "contentVersion" integer NOT NULL DEFAULT 0,
  "createdAt" timestamp with time zone NOT NULL DEFAULT now(),
  "updatedAt" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "trip_albumId_fkey" FOREIGN KEY ("albumId") REFERENCES "album" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT "trip_kind_chk" CHECK ("kind" IN ('route', 'places', 'plain')),
  CONSTRAINT "trip_pkey" PRIMARY KEY ("albumId")
);`.execute(db);
  await sql`CREATE OR REPLACE TRIGGER "trip_updatedAt"
  BEFORE UPDATE ON "trip"
  FOR EACH ROW
  EXECUTE FUNCTION updated_at();`.execute(db);
  await sql`CREATE TABLE "trip_place" (
  "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
  "albumId" uuid NOT NULL,
  "key" text NOT NULL,
  "title" text,
  "article" text,
  "articleSource" text,
  CONSTRAINT "trip_place_albumId_fkey" FOREIGN KEY ("albumId") REFERENCES "trip" ("albumId") ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT "trip_place_albumId_key_uq" UNIQUE ("albumId", "key"),
  CONSTRAINT "trip_place_pkey" PRIMARY KEY ("id")
);`.execute(db);
  await sql`CREATE TABLE "trip_stop" (
  "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
  "albumId" uuid NOT NULL,
  "placeId" uuid,
  "latitude" double precision,
  "longitude" double precision,
  "isPositionManual" boolean NOT NULL DEFAULT false,
  "localStart" timestamp with time zone,
  "localEnd" timestamp with time zone,
  "sequence" integer NOT NULL DEFAULT 0,
  "title" text,
  "titleSource" text,
  "story" text,
  "storySource" text,
  "region" text,
  "country" text,
  "isAddedByHand" boolean NOT NULL DEFAULT false,
  "role" text,
  "isFinishAtStart" boolean NOT NULL DEFAULT false,
  "isTransit" boolean,
  "isAtCenter" boolean NOT NULL DEFAULT false,
  CONSTRAINT "trip_stop_albumId_fkey" FOREIGN KEY ("albumId") REFERENCES "trip" ("albumId") ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT "trip_stop_placeId_fkey" FOREIGN KEY ("placeId") REFERENCES "trip_place" ("id") ON UPDATE CASCADE ON DELETE SET NULL,
  CONSTRAINT "trip_stop_role_chk" CHECK ("role" IN ('start', 'finish')),
  CONSTRAINT "trip_stop_pkey" PRIMARY KEY ("id")
);`.execute(db);
  await sql`CREATE INDEX "trip_stop_albumId_localStart_idx" ON "trip_stop" ("albumId", "localStart");`.execute(db);
  await sql`CREATE UNIQUE INDEX "trip_stop_albumId_role_idx" ON "trip_stop" ("albumId", "role") WHERE ("role" IS NOT NULL);`.execute(
    db,
  );
  await sql`CREATE INDEX "trip_stop_placeId_idx" ON "trip_stop" ("placeId");`.execute(db);
  await sql`CREATE TABLE "trip_asset" (
  "albumId" uuid NOT NULL,
  "assetId" uuid NOT NULL,
  "stopId" uuid,
  "latitude" double precision,
  "longitude" double precision,
  "pointSource" text,
  CONSTRAINT "trip_asset_albumId_fkey" FOREIGN KEY ("albumId") REFERENCES "trip" ("albumId") ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT "trip_asset_stopId_fkey" FOREIGN KEY ("stopId") REFERENCES "trip_stop" ("id") ON UPDATE CASCADE ON DELETE SET NULL,
  CONSTRAINT "trip_asset_albumId_assetId_fkey" FOREIGN KEY ("albumId", "assetId") REFERENCES "album_asset" ("albumId", "assetId") ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT "trip_asset_point_chk" CHECK (("pointSource" IS NULL) = ("latitude" IS NULL) AND ("latitude" IS NULL) = ("longitude" IS NULL)),
  CONSTRAINT "trip_asset_pointSource_chk" CHECK ("pointSource" IN ('inferred', 'manual')),
  CONSTRAINT "trip_asset_pkey" PRIMARY KEY ("albumId", "assetId")
);`.execute(db);
  await sql`CREATE INDEX "trip_asset_stopId_idx" ON "trip_asset" ("stopId");`.execute(db);
  await sql`CREATE TABLE "trip_generated_caption" (
  "assetId" uuid NOT NULL,
  "text" text NOT NULL,
  CONSTRAINT "trip_generated_caption_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "asset" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT "trip_generated_caption_pkey" PRIMARY KEY ("assetId")
);`.execute(db);
  await sql`CREATE TABLE "trip_leg" (
  "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
  "albumId" uuid NOT NULL,
  "fromStopId" uuid NOT NULL,
  "toStopId" uuid NOT NULL,
  "mode" text NOT NULL,
  "isModeManual" boolean NOT NULL DEFAULT false,
  "status" text NOT NULL DEFAULT 'pending',
  "polyline" text,
  "distance" double precision,
  "duration" double precision,
  "departureName" text,
  "departureLatitude" double precision,
  "departureLongitude" double precision,
  "arrivalName" text,
  "arrivalLatitude" double precision,
  "arrivalLongitude" double precision,
  CONSTRAINT "trip_leg_albumId_fkey" FOREIGN KEY ("albumId") REFERENCES "trip" ("albumId") ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT "trip_leg_fromStopId_fkey" FOREIGN KEY ("fromStopId") REFERENCES "trip_stop" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT "trip_leg_toStopId_fkey" FOREIGN KEY ("toStopId") REFERENCES "trip_stop" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT "trip_leg_status_chk" CHECK ("status" IN ('pending', 'ok', 'attention')),
  CONSTRAINT "trip_leg_mode_chk" CHECK ("mode" IN ('foot', 'driving', 'trail', 'direct', 'flight', 'bicycle', 'bus', 'train', 'boat')),
  CONSTRAINT "trip_leg_pkey" PRIMARY KEY ("id")
);`.execute(db);
  await sql`CREATE INDEX "trip_leg_albumId_idx" ON "trip_leg" ("albumId");`.execute(db);
  await sql`CREATE INDEX "trip_leg_fromStopId_idx" ON "trip_leg" ("fromStopId");`.execute(db);
  await sql`CREATE INDEX "trip_leg_toStopId_idx" ON "trip_leg" ("toStopId");`.execute(db);
  await sql`CREATE TABLE "trip_like" (
  "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
  "albumId" uuid NOT NULL,
  "assetId" uuid NOT NULL,
  "userId" uuid,
  "viewerKey" text,
  "createdAt" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "trip_like_albumId_fkey" FOREIGN KEY ("albumId") REFERENCES "trip" ("albumId") ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT "trip_like_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT "trip_like_albumId_assetId_fkey" FOREIGN KEY ("albumId", "assetId") REFERENCES "album_asset" ("albumId", "assetId") ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT "trip_like_albumId_assetId_viewerKey_uq" UNIQUE ("albumId", "assetId", "viewerKey"),
  CONSTRAINT "trip_like_albumId_assetId_userId_uq" UNIQUE ("albumId", "assetId", "userId"),
  CONSTRAINT "trip_like_liker_chk" CHECK (num_nonnulls("userId", "viewerKey") = 1),
  CONSTRAINT "trip_like_pkey" PRIMARY KEY ("id")
);`.execute(db);
  await sql`CREATE INDEX "trip_like_userId_idx" ON "trip_like" ("userId");`.execute(db);
  await sql`CREATE TABLE "trip_overlay" (
  "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
  "albumId" uuid NOT NULL,
  "kind" text NOT NULL,
  "color" text,
  "geometry" jsonb NOT NULL,
  CONSTRAINT "trip_overlay_albumId_fkey" FOREIGN KEY ("albumId") REFERENCES "trip" ("albumId") ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT "trip_overlay_kind_chk" CHECK ("kind" IN ('trail', 'mask')),
  CONSTRAINT "trip_overlay_pkey" PRIMARY KEY ("id")
);`.execute(db);
  await sql`CREATE INDEX "trip_overlay_albumId_idx" ON "trip_overlay" ("albumId");`.execute(db);
  await sql`INSERT INTO "migration_overrides" ("name", "value") VALUES ('trigger_trip_updatedAt', '{"type":"trigger","name":"trip_updatedAt","sql":"CREATE OR REPLACE TRIGGER \\"trip_updatedAt\\"\\n  BEFORE UPDATE ON \\"trip\\"\\n  FOR EACH ROW\\n  EXECUTE FUNCTION updated_at();"}'::jsonb);`.execute(
    db,
  );
  await sql`INSERT INTO "migration_overrides" ("name", "value") VALUES ('index_trip_stop_albumId_role_idx', '{"type":"index","name":"trip_stop_albumId_role_idx","sql":"CREATE UNIQUE INDEX \\"trip_stop_albumId_role_idx\\" ON \\"trip_stop\\" (\\"albumId\\", \\"role\\") WHERE (\\"role\\" IS NOT NULL);"}'::jsonb);`.execute(
    db,
  );
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP TABLE "trip_generated_caption";`.execute(db);
  await sql`DROP TABLE "trip_like";`.execute(db);
  await sql`DROP TABLE "trip_overlay";`.execute(db);
  await sql`DROP TABLE "trip_leg";`.execute(db);
  await sql`DROP TABLE "trip_asset";`.execute(db);
  await sql`DROP TABLE "trip_stop";`.execute(db);
  await sql`DROP TABLE "trip_place";`.execute(db);
  await sql`DROP TABLE "trip";`.execute(db);
  await sql`DELETE FROM "migration_overrides" WHERE "name" IN ('trigger_trip_updatedAt', 'index_trip_stop_albumId_role_idx');`.execute(
    db,
  );
}
