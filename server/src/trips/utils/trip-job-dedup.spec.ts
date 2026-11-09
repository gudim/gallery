import { ModuleRef } from '@nestjs/core';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { QueueName } from 'src/enum.js';
import { ConfigRepository } from 'src/repositories/config.repository.js';
import { EventRepository } from 'src/repositories/event.repository.js';
import { JobRepository } from 'src/repositories/job.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { tripDedupJobs } from 'src/trips/utils/job-options.js';
import { JobItem } from 'src/types.js';

describe('trip job deduplication', () => {
  it.each(tripDedupJobs)('reach BullMQ for %s through JobRepository', async (name) => {
    const queue = { add: vi.fn().mockResolvedValue({}), addBulk: vi.fn().mockResolvedValue([]) };
    const moduleRef = { get: vi.fn().mockReturnValue(queue) } as unknown as ModuleRef;
    const sut = new JobRepository(
      moduleRef,
      {} as ConfigRepository,
      {} as EventRepository,
      {
        setContext: vi.fn(),
      } as unknown as LoggingRepository,
    );
    (sut as unknown as { handlers: Record<string, { queueName: QueueName }> }).handlers = {
      [name]: { queueName: QueueName.BackgroundTask },
    };

    await sut.queueAll([
      { name, data: { id: 'album-1' } },
      { name, data: { id: 'album-1' } },
    ] as JobItem[]);

    expect(queue.addBulk).not.toHaveBeenCalled();
    expect(queue.add).toHaveBeenCalledTimes(2);
    expect(queue.add).toHaveBeenCalledWith(
      name,
      { id: 'album-1' },
      {
        deduplication: { id: `${name}/album-1`, keepLastIfActive: true },
        removeOnComplete: true,
        removeOnFail: true,
      },
    );
  });

  // An older BullMQ ignores the option, and the adds made during a run are then dropped (package.json allows ^5.51).
  it('needs a BullMQ that keeps an add made while its job is active', () => {
    const root = dirname(createRequire(import.meta.url).resolve('bullmq/package.json'));
    const script = readFileSync(join(root, 'dist/esm/commands/includes/storeDeduplicatedNextJob.lua'), 'utf8');

    expect(script).toContain("deduplicationOpts['keepLastIfActive']");
  });
});
