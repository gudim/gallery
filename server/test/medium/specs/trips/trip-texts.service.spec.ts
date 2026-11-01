import { Kysely } from 'kysely';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { AccessRepository } from 'src/repositories/access.repository.js';
import { JobRepository } from 'src/repositories/job.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { DB } from 'src/schema/index.js';
import { BaseService } from 'src/services/base.service.js';
import { TripTextsRepository } from 'src/trips/repositories/trip-texts.repository.js';
import { TripTextsService } from 'src/trips/services/trip-texts.service.js';
import { TripLlmKeyState } from 'src/trips/utils/llm-key.js';
import { newMediumService } from 'test/medium.factory.js';
import { factory } from 'test/small.factory.js';
import { getKyselyDB } from 'test/utils.js';

// A user's LLM settings for trip texts (trips PLAN D16, ADR 0003).
let db: Kysely<DB>;

beforeAll(async () => {
  db = await getKyselyDB();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

const setup = async (secret?: string) => {
  vi.stubEnv('TRIPS_LLM_SECRET', secret ?? '');
  const { ctx } = newMediumService(BaseService, { database: db, real: [], mock: [LoggingRepository, JobRepository] });
  const { user } = await ctx.newUser();
  const auth = factory.auth({ user: { id: user.id } });
  return {
    auth,
    user,
    service: new TripTextsService(
      LoggingRepository.create(),
      new AccessRepository(db),
      ctx.getMock(JobRepository),
      new TripTextsRepository(db),
    ),
  };
};

// Public addresses (TEST-NET-3), so a save looks up no name.
const openAi = { url: 'https://203.0.113.10/v1', model: 'gpt-5-mini', allowUpload: true };
const openRouter = 'https://203.0.113.20/api/v1';

describe(TripTextsService.name, () => {
  it('returns empty settings before the first save', async () => {
    const { auth, service } = await setup('secret');
    await expect(service.getSettings(auth)).resolves.toEqual({
      url: '',
      model: '',
      key: TripLlmKeyState.None,
      allowUpload: false,
      canStoreKey: true,
    });
  });

  it('stores the key encrypted and never returns it', async () => {
    const { auth, user, service } = await setup('secret');
    const saved = await service.updateSettings(auth, { ...openAi, key: 'sk-123' });
    expect(saved).toEqual({ ...openAi, key: TripLlmKeyState.Set, canStoreKey: true });
    expect(JSON.stringify(saved)).not.toContain('sk-123');
    const row = await db
      .selectFrom('trip_llm_settings')
      .select('keyCipher')
      .where('userId', '=', user.id)
      .executeTakeFirstOrThrow();
    expect(row.keyCipher).toMatch(/^v1:/);
    expect(row.keyCipher).not.toContain('sk-123');
  });

  it('keeps the key on a save without one, and drops it when the URL changes', async () => {
    const { auth, service } = await setup('secret');
    await service.updateSettings(auth, { ...openAi, key: 'sk-123' });
    await expect(service.updateSettings(auth, { ...openAi, model: 'gpt-5' })).resolves.toMatchObject({
      model: 'gpt-5',
      key: TripLlmKeyState.Set,
    });
    await expect(service.updateSettings(auth, { ...openAi, url: openRouter })).resolves.toMatchObject({
      key: TripLlmKeyState.None,
    });
  });

  it('refuses a key without TRIPS_LLM_SECRET but saves a server without one', async () => {
    const { auth, service } = await setup();
    await expect(service.updateSettings(auth, { ...openAi, key: 'sk-123' })).rejects.toThrow('TRIPS_LLM_SECRET');
    await expect(service.updateSettings(auth, { ...openAi, url: openRouter })).resolves.toMatchObject({
      key: TripLlmKeyState.None,
      canStoreKey: false,
    });
  });

  it('refuses a server inside the server’s network', async () => {
    const { auth, service } = await setup('secret');
    for (const url of ['http://127.0.0.1:11434/v1', 'http://localhost:11434/v1', 'http://10.0.0.5/v1']) {
      await expect(service.updateSettings(auth, { ...openAi, url })).rejects.toThrow("inside the server's network");
    }
    await expect(service.getSettings(auth)).resolves.toMatchObject({ url: '' });
  });

  it('reports a key saved under another secret as unreadable', async () => {
    const first = await setup('secret');
    await first.service.updateSettings(first.auth, { ...openAi, key: 'sk-123' });
    const { service } = await setup('another');
    await expect(service.getSettings(first.auth)).resolves.toMatchObject({ key: TripLlmKeyState.Unreadable });
  });
});
