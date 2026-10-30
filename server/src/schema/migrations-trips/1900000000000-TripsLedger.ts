import { Kysely } from 'kysely';

// Creates nothing: running it creates the `trips_migrations` ledger (trips PLAN §2.0).
export async function up(_db: Kysely<any>): Promise<void> {}

export async function down(_db: Kysely<any>): Promise<void> {}
