import { Kysely } from 'kysely';
import { FileMigrationProvider, Migrator } from 'kysely/migration';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

// Trip migrations keep their own ledger, so `gallery_migrations` only holds names stock Gallery ships and stock
// Gallery still boots on a trips database (trips DECISIONS-LOG, 2026-10-30). Name them above every Gallery and
// upstream migration (19xxxxxxxxxxx): all folders run in one name order.
export const TRIPS_MIGRATION_TABLE = 'trips_migrations';
export const TRIPS_MIGRATION_FOLDER = 'migrations-trips';

export const createTripsMigrator = (db: Kysely<any>) =>
  new Migrator({
    db,
    migrationLockTableName: 'trips_migrations_lock',
    migrationTableName: TRIPS_MIGRATION_TABLE,
    provider: new FileMigrationProvider({
      fs: { readdir },
      path: { join },
      import: (filePath) => import(filePath),
      migrationFolder: join(import.meta.dirname, '..', 'schema', TRIPS_MIGRATION_FOLDER),
    }),
  });
