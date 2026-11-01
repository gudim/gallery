import { Injectable } from '@nestjs/common';
import { Kysely } from 'kysely';
import { InjectKysely } from 'nestjs-kysely';
import type { Insertable } from 'kysely';
import type { TripLlmSettingsTable } from 'src/trips/schema/tables/trip-llm-settings.table.js';
import { DummyValue, GenerateSql } from 'src/decorators.js';
import { DB } from 'src/schema/index.js';
import { asUuid } from 'src/utils/database.js';

// LLM texts of trips (trips PLAN §2.6): the users' settings and, later, the generation it drives.
@Injectable()
export class TripTextsRepository {
  constructor(@InjectKysely() private db: Kysely<DB>) {}

  @GenerateSql({ params: [DummyValue.UUID] })
  getSettings(userId: string) {
    return this.db
      .selectFrom('trip_llm_settings')
      .select(['url', 'model', 'keyCipher', 'allowUpload'])
      .where('userId', '=', asUuid(userId))
      .executeTakeFirst();
  }

  @GenerateSql({
    params: [
      { userId: DummyValue.UUID, url: DummyValue.STRING, model: DummyValue.STRING, keyCipher: null, allowUpload: true },
    ],
  })
  async upsertSettings(settings: Insertable<TripLlmSettingsTable>) {
    await this.db
      .insertInto('trip_llm_settings')
      .values(settings)
      .onConflict((oc) =>
        oc.column('userId').doUpdateSet((eb) => ({
          url: eb.ref('excluded.url'),
          model: eb.ref('excluded.model'),
          keyCipher: eb.ref('excluded.keyCipher'),
          allowUpload: eb.ref('excluded.allowUpload'),
        })),
      )
      .execute();
  }
}
