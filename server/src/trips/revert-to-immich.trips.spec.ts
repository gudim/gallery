import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// The trips counterpart of src/schema/revert-to-immich.spec.ts, which only reads migrations-gallery. vitest runs with
// cwd = server/.
const serverRoot = process.cwd();
const schemaDir = join(serverRoot, 'src', 'schema');
const tripsDir = join(schemaDir, 'migrations-trips');
const sql = readFileSync(join(serverRoot, '..', 'scripts', 'revert-to-immich.sql'), 'utf8');

const migrations = (folder: string) =>
  readdirSync(join(schemaDir, folder)).filter((file) => file.endsWith('.ts') && !file.endsWith('.spec.ts'));
const tripFiles = migrations('migrations-trips');

const tripTables = new Set(['trips_migrations', 'trips_migrations_lock']);
const tripOverrides = new Set<string>();
for (const file of tripFiles) {
  const content = readFileSync(join(tripsDir, file), 'utf8');
  for (const match of content.matchAll(/INSERT INTO "migration_overrides" \("name", "value"\) VALUES \('([^']+)'/g)) {
    tripOverrides.add(match[1]);
  }
  for (const match of content.matchAll(/CREATE TABLE(?: IF NOT EXISTS)? "?([a-z_]+)"?/g)) {
    tripTables.add(match[1]);
  }
  for (const match of content.matchAll(/\.createTable\('([a-z_]+)'\)/g)) {
    tripTables.add(match[1]);
  }
}

const blockStart = sql.indexOf('-- 8t. Drop the trips layer');
const blockEnd = sql.indexOf('-- 9. Report what happened and commit.', blockStart);
const tripsBlock = sql.slice(blockStart, blockEnd);
const guardStart = tripsBlock.indexOf('tablename IN (');
const guardBlock = tripsBlock.slice(guardStart, tripsBlock.indexOf(');', guardStart));

describe('revert-to-immich.sql, trips layer', () => {
  it('has the trips block after Gallery drops its own objects', () => {
    expect(blockStart).toBeGreaterThan(-1);
    expect(blockEnd).toBeGreaterThan(blockStart);
  });

  it('drops every trip table inside the trips block', () => {
    const missing = [...tripTables].filter(
      (table) =>
        !tripsBlock.includes(`DROP TABLE IF EXISTS "${table}" CASCADE;`) &&
        !tripsBlock.includes(`DROP TABLE IF EXISTS "${table}";`),
    );
    expect(missing).toEqual([]);
  });

  it('lists every trip table in the trips guard', () => {
    const missing = [...tripTables].filter((table) => !guardBlock.includes(`'${table}'`));
    expect(missing).toEqual([]);
  });

  it('deletes every migration_overrides row a trip migration inserts', () => {
    const missing = [...tripOverrides].filter((name) => !tripsBlock.includes(`'${name}'`));
    expect(missing).toEqual([]);
  });

  it('names every trip migration after every Gallery and upstream one', () => {
    const newestOther = [...migrations('migrations'), ...migrations('migrations-gallery')].toSorted().at(-1)!;
    const misplaced = tripFiles.filter((file) => file <= newestOther);
    expect(misplaced).toEqual([]);
  });
});
