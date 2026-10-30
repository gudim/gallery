import { Kysely, sql } from 'kysely';
import { FileMigrationProvider } from 'kysely/migration';
import { readFileSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { ConfigRepository } from 'src/repositories/config.repository.js';
import { DatabaseRepository } from 'src/repositories/database.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { DB } from 'src/schema/index.js';
import { getKyselyDB } from 'test/utils.js';

// The trips ledger (trips PLAN §2.0): trip migrations run after Gallery's, revert first, and the trips block of
// scripts/revert-to-immich.sql drops them. vitest runs with cwd = server/.
const schemaDir = join(process.cwd(), 'src', 'schema');
const sqlPath = join(process.cwd(), '..', 'scripts', 'revert-to-immich.sql');

// A copy of the medium template database, which globalSetup migrated through every ledger. Migrating from scratch here
// would race database-migration.service.spec.ts on cluster-wide catalog rows (ALTER ROLE ... SET jit).
const withDatabase = async (test: (db: Kysely<DB>, repo: DatabaseRepository) => Promise<void>) => {
  const db = await getKyselyDB();
  try {
    await test(db, new DatabaseRepository(db, LoggingRepository.create(), new ConfigRepository()));
  } finally {
    await db.destroy();
  }
};

const fileNames = async (folder: string) => {
  const provider = new FileMigrationProvider({
    fs: { readdir },
    path: { join },
    import: (filePath) => import(filePath),
    migrationFolder: join(schemaDir, folder),
  });
  return Object.keys(await provider.getMigrations()).toSorted();
};

const ledgerNames = async (db: Kysely<DB>, table: string) => {
  const { rows } = await sql<{ name: string }>`SELECT "name" FROM ${sql.table(table)} ORDER BY "name"`.execute(db);
  return rows.map(({ name }) => name);
};

const tableExists = async (db: Kysely<DB>, table: string) => {
  const { rows } = await sql<{ exists: boolean }>`SELECT to_regclass(${table}) IS NOT NULL AS "exists"`.execute(db);
  return rows[0].exists;
};

describe('trips migrations', { timeout: 60_000 }, () => {
  it('records trip migrations in their own ledger and leaves the other two alone', () =>
    withDatabase(async (db, repo) => {
      expect(await ledgerNames(db, 'trips_migrations')).toEqual(await fileNames('migrations-trips'));
      expect(await ledgerNames(db, 'gallery_migrations')).toEqual(await fileNames('migrations-gallery'));
      expect(await ledgerNames(db, 'kysely_migrations')).toEqual(await fileNames('migrations'));
      await expect(repo.runMigrations()).resolves.toBe(0);
    }));

  it('reverts the newest trip migration before any Gallery one, and applies it again', () =>
    withDatabase(async (db, repo) => {
      const trips = await ledgerNames(db, 'trips_migrations');
      const gallery = await ledgerNames(db, 'gallery_migrations');

      await expect(repo.revertLastMigration()).resolves.toBe(trips.at(-1));

      expect(await ledgerNames(db, 'trips_migrations')).toEqual(trips.slice(0, -1));
      expect(await ledgerNames(db, 'gallery_migrations')).toEqual(gallery);
      await expect(repo.runMigrations()).resolves.toBe(1);
      expect(await ledgerNames(db, 'trips_migrations')).toEqual(trips);
    }));

  it('is dropped by the trips block of revert-to-immich.sql', () =>
    withDatabase(async (db) => {
      const script = readFileSync(sqlPath, 'utf8');
      const start = script.indexOf('-- 8t. Drop the trips layer');
      const block = script.slice(start, script.indexOf('-- 9. Report what happened and commit.', start));

      await sql.raw(block).execute(db);

      expect(await tableExists(db, 'trips_migrations')).toBe(false);
      expect(await tableExists(db, 'trips_migrations_lock')).toBe(false);
      expect(await tableExists(db, 'gallery_migrations')).toBe(true);
    }));
});
