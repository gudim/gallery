import { Kysely } from 'kysely';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { AlbumUserRole, AssetFileType, JobName, JobStatus } from 'src/enum.js';
import { AccessRepository } from 'src/repositories/access.repository.js';
import { JobRepository } from 'src/repositories/job.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { DB } from 'src/schema/index.js';
import { BaseService } from 'src/services/base.service.js';
import { StorageService } from 'src/services/storage.service.js';
import { TripKind } from 'src/trips/enum.js';
import { TripTextsRepository } from 'src/trips/repositories/trip-texts.repository.js';
import { TRIP_TEXTS_ATTEMPTS, TripTextsService } from 'src/trips/services/trip-texts.service.js';
import { newMediumService } from 'test/medium.factory.js';
import { factory } from 'test/small.factory.js';
import { getKyselyDB } from 'test/utils.js';

// Generating trip texts (trips PLAN §2.6) against an OpenAI-compatible server stubbed with fetch: no test reaches the
// network.
let db: Kysely<DB>;
const previews = mkdtempSync(join(tmpdir(), 'trip-texts-'));

beforeAll(async () => {
  db = await getKyselyDB();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

type Body = { messages: Array<{ content: string | Array<{ type: string; text?: string }> }> };

const prompt = (body: Body) => (body.messages[1].content as Array<{ text?: string }>)[0].text!;

const photoCount = (body: Body) =>
  (body.messages[1].content as Array<{ type: string }>).filter((part) => part.type === 'image_url').length;

/** A server that captions every photo it is sent, writing title and story on the first call of a stop. */
const stubServer = (options: { onCall?: (call: number, body: Body) => Promise<void> | void; answer?: object } = {}) => {
  let call = 0;
  const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
    call++;
    const body = JSON.parse(init!.body as string) as Body;
    await options.onCall?.(call, body);
    const count = photoCount(body);
    const answer =
      options.answer ??
      (count === 0
        ? { article: 'First.\n\nSecond.' }
        : {
            title: `Title ${call}`,
            story: `Story ${call}`,
            captions: Array.from({ length: count }, (_, index) => ({
              photo: index + 1,
              caption: `Caption ${call}.${index + 1}`,
              long_caption: index === 0 ? 'Long.' : null,
            })),
          });
    return Response.json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(answer) } }] });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
};

const setup = async () => {
  vi.stubEnv('TRIPS_LLM_SECRET', 'secret');
  // The storage backends are set up at bootstrap, which a medium test does not run; previews are plain files here.
  vi.spyOn(StorageService, 'backendFor').mockReturnValue({ readAll: (path: string) => readFile(path) } as never);
  const { ctx } = newMediumService(BaseService, { database: db, real: [], mock: [LoggingRepository, JobRepository] });
  const job = ctx.getMock(JobRepository);
  job.queueAll.mockResolvedValue();
  const sut = new TripTextsService(
    LoggingRepository.create(),
    new AccessRepository(db),
    job,
    new TripTextsRepository(db),
  );
  const { user: owner } = await ctx.newUser();
  const auth = factory.auth({ user: { id: owner.id } });
  await sut.updateSettings(auth, { url: 'https://llm.example/v1', model: 'small', key: 'sk-1', allowUpload: true });

  // A route trip with one stop holding `count` photos a minute apart, each with a preview on disk.
  const newStop = async (count: number, options: { ownerId?: string } = {}) => {
    const assetIds: string[] = [];
    for (let index = 0; index < count; index++) {
      const { asset } = await ctx.newAsset({
        ownerId: options.ownerId ?? owner.id,
        localDateTime: new Date(Date.UTC(2026, 3, 12, 10, index)),
      });
      await ctx.newExif({ assetId: asset.id, description: '' });
      const path = join(previews, `${asset.id}.jpeg`);
      writeFileSync(path, `jpeg ${index}`);
      await ctx.newAssetFile({ assetId: asset.id, type: AssetFileType.Preview, path });
      assetIds.push(asset.id);
    }
    const { album } = await ctx.newAlbum({ ownerId: owner.id, albumName: 'Lithuania 2026' }, assetIds);
    await db.insertInto('trip').values({ albumId: album.id, kind: TripKind.Route, language: 'ru' }).execute();
    const place = await db
      .insertInto('trip_place')
      .values({ albumId: album.id, key: 'birzai', title: 'Biržai' })
      .returning('id')
      .executeTakeFirstOrThrow();
    const stop = await db
      .insertInto('trip_stop')
      .values({ albumId: album.id, placeId: place.id, title: 'Biržai', titleSource: 'geocoded' })
      .returning('id')
      .executeTakeFirstOrThrow();
    await db
      .insertInto('trip_asset')
      .values(assetIds.map((assetId) => ({ albumId: album.id, assetId, stopId: stop.id })))
      .execute();
    return { albumId: album.id, stopId: stop.id, placeId: place.id, assetIds };
  };

  return { ctx, job, sut, owner, auth, newStop };
};

const descriptions = async (assetIds: string[]) => {
  const rows = await db
    .selectFrom('asset_exif')
    .select(['assetId', 'description', 'lockedProperties'])
    .where('assetId', 'in', assetIds)
    .execute();
  return assetIds.map((id) => rows.find((row) => row.assetId === id)!);
};

const captionsOf = (assetIds: string[]) => descriptions(assetIds).then((rows) => rows.map((row) => row.description));

const stopRow = (stopId: string) =>
  db
    .selectFrom('trip_stop')
    .select(['title', 'titleSource', 'story', 'storySource'])
    .where('id', '=', stopId)
    .executeTakeFirstOrThrow();

describe(TripTextsService.name, () => {
  it('captions a stop of 70 photos in 3 calls, each after the previous captions', async () => {
    const { sut, job, newStop } = await setup();
    const fetchMock = stubServer();
    const { stopId, assetIds } = await newStop(70);

    await sut.generateStop(stopId, false);

    const bodies = fetchMock.mock.calls.map(([, init]) => JSON.parse(init!.body as string) as Body);
    expect(bodies.map((body) => photoCount(body))).toEqual([30, 30, 10]);
    expect(prompt(bodies[0])).toContain("Write the stop's title");
    expect(prompt(bodies[1])).toContain('Title: Title 1');
    expect(prompt(bodies[1])).toContain('Caption 1.30');
    expect(prompt(bodies[2])).toContain('Caption 2.30');
    expect(bodies[0].messages[0].content).toContain('Write in Russian');

    await expect(stopRow(stopId)).resolves.toEqual({
      title: 'Title 1',
      titleSource: 'generated',
      story: 'Story 1',
      storySource: 'generated',
    });
    const rows = await descriptions(assetIds);
    expect(rows[0]).toEqual({
      assetId: assetIds[0],
      description: 'Caption 1.1\n\nLong.',
      lockedProperties: ['description'],
    });
    expect(rows[31].description).toBe('Caption 2.2');
    expect(rows[69].description).toBe('Caption 3.10');
    const generated = await db
      .selectFrom('trip_generated_caption')
      .select('text')
      .where('assetId', '=', assetIds[69])
      .executeTakeFirstOrThrow();
    expect(generated.text).toBe('Caption 3.10');
    expect(job.queueAll).toHaveBeenCalledWith(assetIds.map((id) => ({ name: JobName.SidecarWrite, data: { id } })));
  });

  it('never overwrites the owner’s texts without "replace my texts too", and replaces its own', async () => {
    const { sut, ctx, newStop } = await setup();
    const { stopId, assetIds } = await newStop(3);
    await db.updateTable('trip_stop').set({ story: 'Mine.', storySource: 'manual' }).where('id', '=', stopId).execute();
    await ctx.newExif({ assetId: assetIds[0], description: 'My caption.' });
    await ctx.newExif({ assetId: assetIds[1], description: 'Old generated.' });
    await db.insertInto('trip_generated_caption').values({ assetId: assetIds[1], text: 'Old generated.' }).execute();
    stubServer();

    await sut.generateStop(stopId, false);

    await expect(stopRow(stopId)).resolves.toMatchObject({ title: 'Title 1', story: 'Mine.', storySource: 'manual' });
    expect(await captionsOf(assetIds)).toEqual(['My caption.', 'Caption 1.2', 'Caption 1.3']);

    stubServer();
    await sut.generateStop(stopId, true);
    await expect(stopRow(stopId)).resolves.toMatchObject({ story: 'Story 1', storySource: 'generated' });
    await expect(captionsOf(assetIds)).resolves.toEqual(['Caption 1.1\n\nLong.', 'Caption 1.2', 'Caption 1.3']);
  });

  it('never overwrites a caption typed while the model was answering', async () => {
    const { sut, newStop } = await setup();
    const { stopId, assetIds } = await newStop(2);
    stubServer({
      onCall: async () => {
        await db
          .updateTable('asset_exif')
          .set({ description: 'Typed meanwhile.' })
          .where('assetId', '=', assetIds[1])
          .execute();
      },
    });

    await sut.generateStop(stopId, false);

    expect(await captionsOf(assetIds)).toEqual(['Caption 1.1\n\nLong.', 'Typed meanwhile.']);
    const generated = await db
      .selectFrom('trip_generated_caption')
      .select('assetId')
      .where('assetId', 'in', assetIds)
      .execute();
    expect(generated.map((row) => row.assetId)).toEqual([assetIds[0]]);
  });

  it('writes nothing when an answer names other photos', async () => {
    const { sut, newStop } = await setup();
    const { stopId, assetIds } = await newStop(2);
    stubServer({
      answer: {
        title: 'T',
        story: 'S',
        captions: [
          { photo: 1, caption: 'A', long_caption: null },
          { photo: 7, caption: 'B', long_caption: null },
        ],
      },
    });

    await expect(sut.generateStop(stopId, false)).rejects.toThrow('do not match');

    await expect(stopRow(stopId)).resolves.toMatchObject({ title: 'Biržai', titleSource: 'geocoded', story: null });
    expect(await captionsOf(assetIds)).toEqual(['', '']);
  });

  it('captions only the owner’s own assets', async () => {
    const { sut, ctx, newStop } = await setup();
    const { user: other } = await ctx.newUser();
    const { stopId, assetIds } = await newStop(1, { ownerId: other.id });
    const fetchMock = stubServer();

    await sut.generateStop(stopId, false);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    await expect(captionsOf(assetIds)).resolves.toEqual(['']);
    await expect(stopRow(stopId)).resolves.toMatchObject({ title: 'Title 1' });
  });

  it('calls nothing when every text is the owner’s', async () => {
    const { sut, ctx, newStop } = await setup();
    const { stopId, assetIds } = await newStop(1);
    await db
      .updateTable('trip_stop')
      .set({ titleSource: 'manual', story: 'Mine.', storySource: 'manual' })
      .where('id', '=', stopId)
      .execute();
    await ctx.newExif({ assetId: assetIds[0], description: 'Mine.' });
    const fetchMock = stubServer();

    await sut.generateStop(stopId, false);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses without consent to send photos, as a settings error that is not retried', async () => {
    const { sut, auth, newStop } = await setup();
    await sut.updateSettings(auth, { url: 'https://llm.example/v1', model: 'small', allowUpload: false });
    const { stopId } = await newStop(1);
    const fetchMock = stubServer();

    await expect(sut.generateStop(stopId, false)).rejects.toMatchObject({ isRetryable: false });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('writes a place’s article from its stops and leaves the owner’s article alone', async () => {
    const { sut, newStop } = await setup();
    const { stopId, placeId } = await newStop(1);
    await db.updateTable('trip_stop').set({ story: 'A story.' }).where('id', '=', stopId).execute();
    const fetchMock = stubServer();

    await sut.generatePlace(placeId, false);

    const body = JSON.parse(fetchMock.mock.calls[0][1]!.body as string) as Body;
    expect(prompt(body)).toContain('Stop: Biržai\nA story.');
    const place = () =>
      db
        .selectFrom('trip_place')
        .select(['article', 'articleSource'])
        .where('id', '=', placeId)
        .executeTakeFirstOrThrow();
    await expect(place()).resolves.toEqual({ article: 'First.\n\nSecond.', articleSource: 'generated' });

    await db
      .updateTable('trip_place')
      .set({ article: 'Mine.', articleSource: 'manual' })
      .where('id', '=', placeId)
      .execute();
    await sut.generatePlace(placeId, false);
    await expect(place()).resolves.toEqual({ article: 'Mine.', articleSource: 'manual' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

// The TripTexts jobs queued since the last call, as the queue would hand them to the worker.
const queued = (job: Awaited<ReturnType<typeof setup>>['job']) => {
  const items = job.queueAll.mock.calls.flatMap(([batch]) => batch);
  job.queueAll.mockClear();
  return items
    .filter((item) => item.name === JobName.TripTexts)
    .map((item) => item.data as { id: string; delay?: number });
};

describe('a run of trip texts', () => {
  it('estimates calls, assets and the owner’s texts, and runs stops before places', async () => {
    const { sut, auth, job, newStop } = await setup();
    const { albumId, stopId, assetIds } = await newStop(31);
    await db.updateTable('asset_exif').set({ description: 'Mine.' }).where('assetId', '=', assetIds[0]).execute();
    const fetchMock = stubServer();

    await expect(sut.estimate(auth, albumId, { overwrite: false })).resolves.toEqual({
      calls: 3,
      assets: 31,
      stops: 1,
      places: 1,
      ownTexts: 1,
      problem: null,
    });
    await expect(sut.estimate(auth, albumId, { stopId, overwrite: false })).resolves.toMatchObject({
      calls: 2,
      places: 0,
    });

    await expect(sut.start(auth, albumId, { overwrite: false })).resolves.toEqual({ pending: 2, failed: [] });
    const [stopTask, ...rest] = queued(job);
    expect(rest).toEqual([]);
    await expect(sut.handleTexts(stopTask)).resolves.toBe(JobStatus.Success);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const [placeTask] = queued(job);
    await expect(sut.handleTexts(placeTask)).resolves.toBe(JobStatus.Success);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    await expect(sut.getProgress(auth, albumId)).resolves.toEqual({ pending: 0, failed: [] });
    const place = await db
      .selectFrom('trip_place')
      .select('article')
      .where('albumId', '=', albumId)
      .executeTakeFirstOrThrow();
    expect(place.article).toBe('First.\n\nSecond.');
  });

  it('retries a failed stop on its own with a growing delay, then gives up until "retry"', async () => {
    const { sut, auth, job, newStop } = await setup();
    const { albumId, stopId } = await newStop(1);
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(new Response('busy', { status: 503 })));

    await sut.start(auth, albumId, { stopId, overwrite: false });
    let [task] = queued(job);
    const delays = [];
    for (let attempt = 1; attempt < TRIP_TEXTS_ATTEMPTS; attempt++) {
      await expect(sut.handleTexts(task)).resolves.toBe(JobStatus.Failed);
      [task] = queued(job);
      delays.push(task.delay);
    }
    expect(delays).toEqual([60_000, 120_000]);
    await expect(sut.handleTexts(task)).resolves.toBe(JobStatus.Failed);
    expect(queued(job)).toEqual([]);
    await expect(sut.getProgress(auth, albumId)).resolves.toEqual({
      pending: 0,
      failed: [{ stopId, placeId: null, title: 'Biržai', error: expect.stringContaining('HTTP 503') }],
    });

    stubServer();
    await expect(sut.retry(auth, albumId)).resolves.toMatchObject({ pending: 1, failed: [] });
    [task] = queued(job);
    expect(task.delay).toBeUndefined();
    await expect(sut.handleTexts(task)).resolves.toBe(JobStatus.Success);
    await expect(stopRow(stopId)).resolves.toMatchObject({ title: 'Title 1' });
  });

  it('does not retry a settings error', async () => {
    const { sut, auth, job, newStop } = await setup();
    const { albumId, stopId } = await newStop(1);
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(new Response('bad key', { status: 401 })));

    await sut.start(auth, albumId, { stopId, overwrite: false });
    const [task] = queued(job);
    await expect(sut.handleTexts(task)).resolves.toBe(JobStatus.Failed);
    expect(queued(job)).toEqual([]);
    await expect(sut.getProgress(auth, albumId)).resolves.toMatchObject({ pending: 0, failed: [{ stopId }] });
  });

  it('lets a new run replace the old one, whose queued jobs then do nothing', async () => {
    const { sut, auth, job, newStop } = await setup();
    const { albumId, stopId } = await newStop(1);
    const fetchMock = stubServer();

    await sut.start(auth, albumId, { stopId, overwrite: false });
    const [old] = queued(job);
    await sut.start(auth, albumId, { stopId, overwrite: false });
    await expect(sut.handleTexts(old)).resolves.toBe(JobStatus.Skipped);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('is for the album owner only, and refused without settings', async () => {
    const { sut, ctx, auth, newStop } = await setup();
    const { albumId } = await newStop(1);
    const { user: editor } = await ctx.newUser();
    await ctx.newAlbumUser({ albumId, userId: editor.id, role: AlbumUserRole.Editor });
    const editorAuth = factory.auth({ user: { id: editor.id } });
    const { user: stranger } = await ctx.newUser();

    await expect(sut.estimate(editorAuth, albumId, { overwrite: false })).rejects.toThrow('Only the album owner');
    await expect(sut.start(editorAuth, albumId, { overwrite: false })).rejects.toThrow('Only the album owner');
    await expect(sut.getProgress(factory.auth({ user: { id: stranger.id } }), albumId)).rejects.toThrow(
      'Trip not found',
    );

    await sut.updateSettings(auth, { url: 'https://llm.example/v1', model: 'small', allowUpload: false });
    await expect(sut.estimate(auth, albumId, { overwrite: false })).resolves.toMatchObject({ problem: 'noConsent' });
    await expect(sut.start(auth, albumId, { overwrite: false })).rejects.toThrow('not allowed');
  });
});
