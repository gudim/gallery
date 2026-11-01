import { Injectable } from '@nestjs/common';
import { Kysely, sql } from 'kysely';
import { InjectKysely } from 'nestjs-kysely';
import type { Insertable } from 'kysely';
import type { TripLlmSettingsTable } from 'src/trips/schema/tables/trip-llm-settings.table.js';
import { DummyValue, GenerateSql } from 'src/decorators.js';
import { AlbumUserRole, AssetFileType, AssetType, AssetVisibility } from 'src/enum.js';
import { DB } from 'src/schema/index.js';
import { bumpContentVersion } from 'src/trips/repositories/trip.repository.js';
import { TRIP_TEXT_SOURCE_GENERATED } from 'src/trips/utils/texts.js';
import { asUuid } from 'src/utils/database.js';

const REPLACEABLE_SOURCES = [TRIP_TEXT_SOURCE_GENERATED, 'geocoded'];

export type TripStopTexts = {
  stopId: string;
  albumId: string;
  ownerId: string;
  overwrite: boolean;
  title: string | null;
  story: string | null;
  captions: Array<{ assetId: string; text: string }>;
};

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

  /** A stop with what its prompt needs; nothing for a deleted stop or a trip whose album is in the trash. */
  @GenerateSql({ params: [DummyValue.UUID] })
  getStop(stopId: string) {
    return this.db
      .selectFrom('trip_stop')
      .innerJoin('trip', 'trip.albumId', 'trip_stop.albumId')
      .innerJoin('album', 'album.id', 'trip.albumId')
      .innerJoin('album_user', (join) =>
        join.onRef('album_user.albumId', '=', 'album.id').on('album_user.role', '=', AlbumUserRole.Owner),
      )
      .leftJoin('trip_place', 'trip_place.id', 'trip_stop.placeId')
      .select([
        'trip_stop.id',
        'trip_stop.albumId',
        'album_user.userId as ownerId',
        'album.albumName',
        'trip.kind',
        'trip.language',
        'trip_stop.title',
        'trip_stop.titleSource',
        'trip_stop.story',
        'trip_stop.storySource',
        'trip_stop.isAtCenter',
        'trip_stop.region',
        'trip_stop.country',
        'trip_stop.localStart',
        'trip_stop.localEnd',
        'trip_place.title as placeTitle',
        'trip_place.article',
      ])
      .where('trip_stop.id', '=', asUuid(stopId))
      .where('album.deletedAt', 'is', null)
      .executeTakeFirst();
  }

  /**
   * The stop's assets in time order, with their captions and preview files; an asset in the trash or the locked folder
   * is left out, as the trip viewer leaves it out.
   */
  @GenerateSql({ params: [DummyValue.UUID] })
  getStopAssets(stopId: string) {
    return this.db
      .selectFrom('trip_asset')
      .innerJoin('asset', 'asset.id', 'trip_asset.assetId')
      .leftJoin('asset_exif', 'asset_exif.assetId', 'asset.id')
      .leftJoin('trip_generated_caption', 'trip_generated_caption.assetId', 'asset.id')
      .select((eb) => [
        'asset.id',
        'asset.ownerId',
        'asset.localDateTime',
        eb('asset.type', '=', AssetType.Video).$castTo<boolean>().as('isVideo'),
        'asset_exif.description',
        'trip_generated_caption.text as generatedCaption',
        eb
          .selectFrom('asset_file')
          .select('asset_file.path')
          .whereRef('asset_file.assetId', '=', 'asset.id')
          .where('asset_file.type', '=', AssetFileType.Preview)
          .orderBy('asset_file.isEdited', 'desc')
          .limit(1)
          .as('previewPath'),
      ])
      .where('trip_asset.stopId', '=', asUuid(stopId))
      .where('asset.deletedAt', 'is', null)
      .where('asset.visibility', '!=', AssetVisibility.Locked)
      .orderBy('asset.localDateTime')
      .orderBy('asset.id')
      .execute();
  }

  /**
   * Writes a stop's checked texts in one transaction and returns the assets whose caption changed. Each text is
   * written only if it is still replaceable now, not only when it was read: the owner may have typed one while the
   * model was answering (travel-album P15, DECISIONS-LOG 2026-10-31).
   */
  @GenerateSql({
    params: [
      {
        stopId: DummyValue.UUID,
        albumId: DummyValue.UUID,
        ownerId: DummyValue.UUID,
        overwrite: false,
        title: DummyValue.STRING,
        story: DummyValue.STRING,
        captions: [{ assetId: DummyValue.UUID, text: DummyValue.STRING }],
      },
    ],
  })
  writeStop(texts: TripStopTexts) {
    const { stopId, albumId, ownerId, overwrite, title, story, captions } = texts;
    return this.db.transaction().execute(async (trx) => {
      let changed = 0;
      for (const [column, source, value] of [
        ['title', 'titleSource', title],
        ['story', 'storySource', story],
      ] as const) {
        if (!value) {
          continue;
        }
        const result = await trx
          .updateTable('trip_stop')
          .set({ [column]: value, [source]: TRIP_TEXT_SOURCE_GENERATED })
          .where('id', '=', asUuid(stopId))
          .$if(column === 'title', (qb) => qb.where('isAtCenter', '=', false))
          .$if(!overwrite, (qb) =>
            qb.where((eb) =>
              eb.or([eb(eb.fn.coalesce(column, sql.lit('')), '=', ''), eb(source, 'in', REPLACEABLE_SOURCES)]),
            ),
          )
          .executeTakeFirst();
        changed += Number(result.numUpdatedRows);
      }

      const assetIds: string[] = [];
      for (const { assetId, text } of captions) {
        const row = await trx
          .updateTable('asset_exif')
          .set((eb) => ({
            description: text,
            lockedProperties: sql`nullif(array(select distinct unnest(${eb.ref('asset_exif.lockedProperties')} || ${['description']}::text[])), '{}')`,
          }))
          .from('asset')
          .whereRef('asset.id', '=', 'asset_exif.assetId')
          .where('asset_exif.assetId', '=', asUuid(assetId))
          .where('asset.ownerId', '=', asUuid(ownerId))
          .$if(!overwrite, (qb) =>
            qb.where((eb) =>
              eb.or([
                eb(eb.fn.coalesce('asset_exif.description', sql.lit('')), '=', ''),
                eb(
                  'asset_exif.description',
                  '=',
                  eb
                    .selectFrom('trip_generated_caption')
                    .select('trip_generated_caption.text')
                    .whereRef('trip_generated_caption.assetId', '=', 'asset_exif.assetId'),
                ),
              ]),
            ),
          )
          .returning('asset_exif.assetId')
          .executeTakeFirst();
        if (!row) {
          continue;
        }
        await trx
          .insertInto('trip_generated_caption')
          .values({ assetId, text })
          .onConflict((oc) => oc.column('assetId').doUpdateSet({ text }))
          .execute();
        assetIds.push(assetId);
      }

      if (changed + assetIds.length > 0) {
        await bumpContentVersion(trx, albumId);
      }
      return assetIds;
    });
  }

  /** A place with what its prompt needs, and its stops in time order; nothing for a trip in the trash. */
  @GenerateSql({ params: [DummyValue.UUID] })
  async getPlace(placeId: string) {
    const place = await this.db
      .selectFrom('trip_place')
      .innerJoin('trip', 'trip.albumId', 'trip_place.albumId')
      .innerJoin('album', 'album.id', 'trip.albumId')
      .innerJoin('album_user', (join) =>
        join.onRef('album_user.albumId', '=', 'album.id').on('album_user.role', '=', AlbumUserRole.Owner),
      )
      .select([
        'trip_place.id',
        'trip_place.albumId',
        'trip_place.key',
        'trip_place.title',
        'trip_place.article',
        'trip_place.articleSource',
        'album_user.userId as ownerId',
        'album.albumName',
        'trip.kind',
        'trip.language',
      ])
      .where('trip_place.id', '=', asUuid(placeId))
      .where('album.deletedAt', 'is', null)
      .executeTakeFirst();
    if (!place) {
      return;
    }
    const stops = await this.db
      .selectFrom('trip_stop')
      .select(['title', 'story', 'region', 'country', 'localStart', 'localEnd'])
      .where('placeId', '=', asUuid(placeId))
      .orderBy('localStart', sql`asc nulls first`)
      .orderBy('sequence')
      .orderBy('id')
      .execute();
    return { ...place, stops };
  }

  /** Writes a place's article while it is still replaceable; true when it was written. */
  @GenerateSql({ params: [DummyValue.UUID, DummyValue.UUID, DummyValue.STRING, false] })
  writePlace(placeId: string, albumId: string, article: string, overwrite: boolean) {
    return this.db.transaction().execute(async (trx) => {
      const result = await trx
        .updateTable('trip_place')
        .set({ article, articleSource: TRIP_TEXT_SOURCE_GENERATED })
        .where('id', '=', asUuid(placeId))
        .$if(!overwrite, (qb) =>
          qb.where((eb) =>
            eb.or([
              eb(eb.fn.coalesce('article', sql.lit('')), '=', ''),
              eb('articleSource', 'in', REPLACEABLE_SOURCES),
            ]),
          ),
        )
        .executeTakeFirst();
      if (Number(result.numUpdatedRows) === 0) {
        return false;
      }
      await bumpContentVersion(trx, albumId);
      return true;
    });
  }
}
