import { Injectable } from '@nestjs/common';
import { Kysely, RawBuilder, Transaction, sql } from 'kysely';
import { InjectKysely } from 'nestjs-kysely';
import type { Insertable } from 'kysely';
import type { TripLlmSettingsTable } from 'src/trips/schema/tables/trip-llm-settings.table.js';
import { DummyValue, GenerateSql } from 'src/decorators.js';
import { AlbumUserRole, AssetFileType, AssetType, AssetVisibility } from 'src/enum.js';
import { DB } from 'src/schema/index.js';
import { bumpContentVersion } from 'src/trips/repositories/trip.repository.js';
import { TRIP_REPLACEABLE_TEXT_SOURCES, TRIP_TEXT_SOURCE_GENERATED } from 'src/trips/utils/texts.js';
import { asUuid } from 'src/utils/database.js';

/** A text to write and the one it replaces, as read before the model answered. */
export type TripTextWrite = { text: string; seen: string | null };

/** What a run writes; nothing is written once the run's task is gone, replaced by a newer run. */
type TripTextsOfTask = { taskId: string; albumId: string; overwrite: boolean };

export type TripStopTexts = TripTextsOfTask & {
  stopId: string;
  ownerId: string;
  title: TripTextWrite | null;
  story: TripTextWrite | null;
  captions: Array<TripTextWrite & { assetId: string }>;
};

export type TripPlaceText = TripTextsOfTask & { placeId: string; article: TripTextWrite };

/**
 * A text is written while it is still replaceable now, not only when it was read: the owner may have typed one while
 * the model was answering (travel-album P15, DECISIONS-LOG 2026-10-31). "Replace my texts too" also replaces the
 * owner's own text, but only the one that was read: a text typed meanwhile is never overwritten.
 */
const isWritable = (column: string, isGenerated: RawBuilder<unknown>, { seen }: TripTextWrite, overwrite: boolean) => {
  const value = sql`coalesce(${sql.ref(column)}, '')`;
  const unchanged = overwrite ? sql` or ${value} = ${seen ?? ''}` : sql``;
  return sql<boolean>`(${value} = '' or ${isGenerated}${unchanged})`;
};

/** A title, story or article an LLM or Nominatim wrote, by its source column. */
const hasGeneratedSource = (source: string) => sql`${sql.ref(source)} in (${sql.join(TRIP_REPLACEABLE_TEXT_SOURCES)})`;

/** A caption that is still the text an LLM wrote (DECISIONS-LOG 2026-10-31). */
const isGeneratedCaption = sql`"asset_exif"."description" = (select "text" from "trip_generated_caption" where "trip_generated_caption"."assetId" = "asset_exif"."assetId")`;

/** Holds the run's task until the write commits, so a run started meanwhile waits; false when it is already gone. */
const holdTask = async (trx: Transaction<DB>, taskId: string) =>
  !!(await trx
    .selectFrom('trip_text_task')
    .select('id')
    .where('id', '=', asUuid(taskId))
    .forUpdate()
    .executeTakeFirst());

/** Shown for a place whose article waits for a failed stop. */
const PLACE_WAITS_FOR_STOPS = 'Not written while a stop of this place failed; retry writes it after its stops';

/** Holds the trip while its tasks change, so two starts or retries at once do not both queue the same stops. */
const holdTrip = async (trx: Transaction<DB>, albumId: string) => {
  await trx.selectFrom('trip').select('albumId').where('albumId', '=', asUuid(albumId)).forUpdate().execute();
};

// LLM texts of trips (trips PLAN §2.6): the users' settings, the texts' sources and writes, and the tasks of a run.
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

  /** Trips outside the trash, with their album's owner, whose settings and assets generation uses. */
  private ownedTrips() {
    return this.db
      .selectFrom('trip')
      .innerJoin('album', 'album.id', 'trip.albumId')
      .innerJoin('album_user', (join) =>
        join.onRef('album_user.albumId', '=', 'album.id').on('album_user.role', '=', AlbumUserRole.Owner),
      )
      .where('album.deletedAt', 'is', null);
  }

  private stops() {
    return this.ownedTrips()
      .innerJoin('trip_stop', 'trip_stop.albumId', 'trip.albumId')
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
      ]);
  }

  /** A stop with what its prompt needs; nothing for a deleted stop or a trip whose album is in the trash. */
  @GenerateSql({ params: [DummyValue.UUID] })
  getStop(stopId: string) {
    return this.stops().where('trip_stop.id', '=', asUuid(stopId)).executeTakeFirst();
  }

  /** The trip's stops with assets (not a start or finish), or the one stop of the trip that `stopId` names. */
  @GenerateSql({ params: [DummyValue.UUID, DummyValue.UUID] })
  getStops(albumId: string, stopId?: string) {
    return this.stops()
      .where('trip_stop.albumId', '=', asUuid(albumId))
      .where('trip_stop.role', 'is', null)
      .$if(!!stopId, (qb) => qb.where('trip_stop.id', '=', asUuid(stopId!)))
      .orderBy('trip_stop.localStart', sql`asc nulls first`)
      .orderBy('trip_stop.sequence')
      .execute();
  }

  @GenerateSql({ params: [DummyValue.UUID] })
  async hasTrip(albumId: string) {
    const trip = await this.db
      .selectFrom('trip')
      .select('albumId')
      .where('albumId', '=', asUuid(albumId))
      .executeTakeFirst();
    return !!trip;
  }

  /** The trip's places, for the estimate. */
  @GenerateSql({ params: [DummyValue.UUID] })
  getPlaceIds(albumId: string) {
    return this.db
      .selectFrom('trip_place')
      .select('id')
      .where('albumId', '=', asUuid(albumId))
      .orderBy('key')
      .execute()
      .then((rows) => rows.map((row) => row.id));
  }

  /**
   * The stop's assets in time order, with their captions and preview files; an asset in the trash or the locked folder
   * is left out, as the trip viewer leaves it out, and so is one without a preview yet: it cannot go to the model.
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
      .where((eb) =>
        eb.exists(
          eb
            .selectFrom('asset_file')
            .select('asset_file.id')
            .whereRef('asset_file.assetId', '=', 'asset.id')
            .where('asset_file.type', '=', AssetFileType.Preview),
        ),
      )
      .$narrowType<{ previewPath: string }>()
      .orderBy('asset.localDateTime')
      .orderBy('asset.id')
      .execute();
  }

  /** Writes a stop's checked texts in one transaction (see isWritable) and returns the assets whose caption changed. */
  @GenerateSql({
    params: [
      {
        taskId: DummyValue.UUID,
        stopId: DummyValue.UUID,
        albumId: DummyValue.UUID,
        ownerId: DummyValue.UUID,
        overwrite: true,
        title: { text: DummyValue.STRING, seen: DummyValue.STRING },
        story: { text: DummyValue.STRING, seen: null },
        captions: [{ assetId: DummyValue.UUID, text: DummyValue.STRING, seen: DummyValue.STRING }],
      },
    ],
  })
  writeStop(texts: TripStopTexts) {
    const { taskId, stopId, albumId, ownerId, overwrite, title, story, captions } = texts;
    return this.db.transaction().execute(async (trx) => {
      if (!(await holdTask(trx, taskId))) {
        return [];
      }
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
          .set({ [column]: value.text, [source]: TRIP_TEXT_SOURCE_GENERATED })
          .where('id', '=', asUuid(stopId))
          .$if(column === 'title', (qb) => qb.where('isAtCenter', '=', false))
          .where(isWritable(column, hasGeneratedSource(source), value, overwrite))
          .executeTakeFirst();
        changed += Number(result.numUpdatedRows);
      }

      const assetIds: string[] = [];
      for (const { assetId, text, seen } of captions) {
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
          .where(isWritable('asset_exif.description', isGeneratedCaption, { text, seen }, overwrite))
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
    const place = await this.ownedTrips()
      .innerJoin('trip_place', 'trip_place.albumId', 'trip.albumId')
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

  /** Writes a place's article (see isWritable); true when it was written. */
  @GenerateSql({
    params: [
      {
        taskId: DummyValue.UUID,
        placeId: DummyValue.UUID,
        albumId: DummyValue.UUID,
        overwrite: false,
        article: { text: DummyValue.STRING, seen: null },
      },
    ],
  })
  writePlace({ taskId, placeId, albumId, overwrite, article }: TripPlaceText) {
    return this.db.transaction().execute(async (trx) => {
      if (!(await holdTask(trx, taskId))) {
        return false;
      }
      const result = await trx
        .updateTable('trip_place')
        .set({ article: article.text, articleSource: TRIP_TEXT_SOURCE_GENERATED })
        .where('id', '=', asUuid(placeId))
        .where(isWritable('article', hasGeneratedSource('articleSource'), article, overwrite))
        .executeTakeFirst();
      if (Number(result.numUpdatedRows) === 0) {
        return false;
      }
      await bumpContentVersion(trx, albumId);
      return true;
    });
  }

  /**
   * Starts a run: replaces every task of the trip, stops queued at once and places waiting for them. Returns the stop
   * tasks to queue.
   */
  @GenerateSql({ params: [DummyValue.UUID, [DummyValue.UUID], [DummyValue.UUID], false] })
  replaceTasks(albumId: string, stopIds: string[], placeIds: string[], overwrite: boolean) {
    return this.db.transaction().execute(async (trx) => {
      await holdTrip(trx, albumId);
      await trx.deleteFrom('trip_text_task').where('albumId', '=', asUuid(albumId)).execute();
      const rows = [
        ...stopIds.map((stopId) => ({ albumId, stopId, overwrite, isQueued: true })),
        ...placeIds.map((placeId) => ({ albumId, placeId, overwrite })),
      ];
      if (rows.length === 0) {
        return [];
      }
      const tasks = await trx.insertInto('trip_text_task').values(rows).returning(['id', 'stopId']).execute();
      return tasks.filter((task) => task.stopId !== null).map((task) => task.id);
    });
  }

  @GenerateSql({ params: [DummyValue.UUID] })
  getTask(id: string) {
    return this.db
      .selectFrom('trip_text_task')
      .select(['id', 'albumId', 'stopId', 'placeId', 'overwrite', 'attempt', 'error'])
      .where('id', '=', asUuid(id))
      .executeTakeFirst();
  }

  @GenerateSql({ params: [DummyValue.UUID] })
  async finishTask(id: string) {
    await this.db.deleteFrom('trip_text_task').where('id', '=', asUuid(id)).execute();
  }

  @GenerateSql({ params: [DummyValue.UUID, 2] })
  async setTaskAttempt(id: string, attempt: number) {
    await this.db.updateTable('trip_text_task').set({ attempt }).where('id', '=', asUuid(id)).execute();
  }

  @GenerateSql({ params: [DummyValue.UUID, DummyValue.STRING] })
  async failTask(id: string, error: string) {
    await this.db.updateTable('trip_text_task').set({ error }).where('id', '=', asUuid(id)).execute();
  }

  /**
   * Marks the trip's waiting places queued once no stop is pending, and returns them. Each row is returned once even
   * when two stops finish together: the update takes it. A place with a failed stop fails too instead of being
   * written without that stop's story; "retry" sends both, and the place runs after its stops.
   */
  @GenerateSql({ params: [DummyValue.UUID] })
  takePlaceTasks(albumId: string) {
    return this.db
      .updateTable('trip_text_task')
      .set((eb) => {
        const hasFailedStop = eb.exists(
          eb
            .selectFrom('trip_text_task as stop_task')
            .innerJoin('trip_stop', 'trip_stop.id', 'stop_task.stopId')
            .select('stop_task.id')
            .whereRef('trip_stop.placeId', '=', 'trip_text_task.placeId')
            .where('stop_task.error', 'is not', null),
        );
        return {
          isQueued: eb.not(hasFailedStop).$castTo<boolean>(),
          error: eb.case().when(hasFailedStop).then(PLACE_WAITS_FOR_STOPS).else(null).end(),
        };
      })
      .where('albumId', '=', asUuid(albumId))
      .where('placeId', 'is not', null)
      .where('isQueued', '=', false)
      .where('error', 'is', null)
      .where(({ not, exists, selectFrom }) =>
        not(
          exists(
            selectFrom('trip_text_task as stop_task')
              .select('stop_task.id')
              .where('stop_task.albumId', '=', asUuid(albumId))
              .where('stop_task.stopId', 'is not', null)
              .where('stop_task.error', 'is', null),
          ),
        ),
      )
      .returning(['id', 'isQueued'])
      .execute()
      .then((rows) => rows.filter((row) => row.isQueued).map((row) => row.id));
  }

  /** Sends the trip's failed tasks again from the first attempt; returns the stop tasks to queue. */
  @GenerateSql({ params: [DummyValue.UUID] })
  retryTasks(albumId: string) {
    return this.db.transaction().execute(async (trx) => {
      await holdTrip(trx, albumId);
      const rows = await trx
        .updateTable('trip_text_task')
        .set((eb) => ({ error: null, attempt: 1, isQueued: eb('stopId', 'is not', null).$castTo<boolean>() }))
        .where('albumId', '=', asUuid(albumId))
        .where('error', 'is not', null)
        .returning(['id', 'stopId'])
        .execute();
      return rows.filter((row) => row.stopId !== null).map((row) => row.id);
    });
  }

  /** The trip's tasks with the titles to show for them. */
  @GenerateSql({ params: [DummyValue.UUID] })
  getTasks(albumId: string) {
    return this.db
      .selectFrom('trip_text_task')
      .leftJoin('trip_stop', 'trip_stop.id', 'trip_text_task.stopId')
      .leftJoin('trip_place', 'trip_place.id', 'trip_text_task.placeId')
      .select([
        'trip_text_task.stopId',
        'trip_text_task.placeId',
        'trip_text_task.error',
        (eb) => eb.fn.coalesce('trip_stop.title', 'trip_place.title', 'trip_place.key').as('title'),
      ])
      .where('trip_text_task.albumId', '=', asUuid(albumId))
      .orderBy('trip_text_task.createdAt')
      .orderBy('trip_text_task.id')
      .execute();
  }
}
