import { Injectable } from '@nestjs/common';
import { Kysely, NotNull, sql } from 'kysely';
import { InjectKysely } from 'nestjs-kysely';
import { DummyValue, GenerateSql } from 'src/decorators.js';
import { DB } from 'src/schema/index.js';
import { TripKind } from 'src/trips/enum.js';
import { bumpContentVersion, lockTrip, stopOrder } from 'src/trips/repositories/trip.repository.js';
import { TRIP_TITLE_SOURCE_GEOCODED } from 'src/trips/utils/naming.js';
import { asUuid } from 'src/utils/database.js';

/**
 * A name for a stop, with the point and title source the stop had when it was read: the write is skipped if either
 * changed while Nominatim was asked.
 */
export type TripStopName = {
  id: string;
  latitude: number;
  longitude: number;
  titleSource: string | null;
  title: string;
  region: string | null;
  country: string | null;
};

// Names stops through Nominatim (trips PLAN D13).
@Injectable()
export class TripNameRepository {
  constructor(@InjectKysely() private db: Kysely<DB>) {}

  /** The trip's kind, language and stops with a point, in trip order, for naming; nothing for a trip in the trash. */
  @GenerateSql({ params: [DummyValue.UUID] })
  async getStopsToName(albumId: string) {
    const id = asUuid(albumId);
    const trip = await this.db
      .selectFrom('trip')
      .innerJoin('album', 'album.id', 'trip.albumId')
      .select(['trip.kind', 'trip.language'])
      .where('trip.albumId', '=', id)
      .where('album.deletedAt', 'is', null)
      .executeTakeFirst();
    if (!trip) {
      return;
    }
    const stops = await this.db
      .selectFrom('trip_stop')
      .select([
        'trip_stop.id',
        'trip_stop.role',
        'trip_stop.isFinishAtStart',
        'trip_stop.latitude',
        'trip_stop.longitude',
        'trip_stop.title',
        'trip_stop.titleSource',
        'trip_stop.region',
        'trip_stop.country',
      ])
      .where('trip_stop.albumId', '=', id)
      .where('trip_stop.latitude', 'is not', null)
      .where('trip_stop.longitude', 'is not', null)
      .orderBy(stopOrder('trip_stop'))
      .$narrowType<{ latitude: NotNull; longitude: NotNull }>()
      .execute();
    return { ...trip, stops };
  }

  /**
   * Writes the names Nominatim gave (trips PLAN D13), each only if its stop still has no title, and the point and the
   * title source it was read with: a stop someone named or moved meanwhile keeps what they did. Bumps `contentVersion`
   * when a stop was named. Returns how many were.
   */
  @GenerateSql({
    params: [
      DummyValue.UUID,
      [
        {
          id: DummyValue.UUID,
          latitude: 54.68,
          longitude: 25.28,
          titleSource: null,
          title: DummyValue.STRING,
          region: DummyValue.STRING,
          country: DummyValue.STRING,
        },
      ],
    ],
  })
  nameStops(albumId: string, names: TripStopName[]): Promise<number> {
    const id = asUuid(albumId);
    return this.db.transaction().execute(async (trx) => {
      if (!(await lockTrip(trx, albumId))) {
        return 0;
      }
      let named = 0;
      for (const name of names) {
        const { numUpdatedRows } = await trx
          .updateTable('trip_stop')
          .set({
            title: name.title,
            titleSource: TRIP_TITLE_SOURCE_GEOCODED,
            region: name.region,
            country: name.country,
          })
          .where('id', '=', asUuid(name.id))
          .where('albumId', '=', id)
          .where(sql`coalesce(btrim("title"), '')`, '=', '')
          .where('titleSource', 'is not distinct from', name.titleSource)
          .where('latitude', '=', name.latitude)
          .where('longitude', '=', name.longitude)
          .executeTakeFirst();
        named += Number(numUpdatedRows);
      }
      if (named > 0) {
        await bumpContentVersion(trx, albumId);
      }
      return named;
    });
  }

  /** Trips with a map, outside the trash, with a stop that has a point and no title: naming's nightly retry. */
  @GenerateSql()
  async getAlbumIdsToName(): Promise<string[]> {
    const rows = await this.db
      .selectFrom('trip')
      .innerJoin('album', 'album.id', 'trip.albumId')
      .select('trip.albumId')
      .where('album.deletedAt', 'is', null)
      .where('trip.kind', '!=', TripKind.Plain)
      .where((eb) =>
        eb.exists(
          eb
            .selectFrom('trip_stop')
            .select('trip_stop.id')
            .whereRef('trip_stop.albumId', '=', 'trip.albumId')
            .where('trip_stop.latitude', 'is not', null)
            .where('trip_stop.longitude', 'is not', null)
            .where(sql`coalesce(btrim("trip_stop"."title"), '')`, '=', ''),
        ),
      )
      .execute();
    return rows.map(({ albumId }) => albumId);
  }
}
