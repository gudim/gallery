import { Job, Queue, QueueEvents, Worker } from 'bullmq';
import { randomUUID } from 'node:crypto';
import { GenericContainer, StartedTestContainer } from 'testcontainers';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { JobName } from 'src/enum.js';
import { tripJobOptions } from 'src/trips/utils/job-options.js';

const gate = () => {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => (open = resolve));
  return { open, opened };
};

// What the trip jobs' options do in a real BullMQ: the behaviour rests on BullMQ's deduplication, not on our code.
describe('trip job deduplication', () => {
  let redis: StartedTestContainer;
  let connection: { host: string; port: number };
  const closers: Array<{ close: () => Promise<unknown> }> = [];

  beforeAll(async () => {
    redis = await new GenericContainer(
      'docker.io/valkey/valkey:9@sha256:c123e3715db63d06d4ad6964884037aa0d5d4d703939b9929954112889708e1d',
    )
      .withExposedPorts(6379)
      .start();
    connection = { host: redis.getHost(), port: redis.getMappedPort(6379) };
  }, 120_000);

  afterEach(async () => {
    for (const closer of closers.splice(0).toReversed()) {
      await closer.close();
    }
  });

  afterAll(async () => {
    await redis?.stop();
  });

  const setup = async (processor: (job: Job) => Promise<void>) => {
    const name = `trips-${randomUUID()}`;
    const queue = new Queue(name, { connection, defaultJobOptions: { attempts: 1, removeOnFail: false } });
    const events = new QueueEvents(name, { connection });
    closers.push(queue, events);
    await events.waitUntilReady();
    const start = () => {
      const worker = new Worker(name, processor, { connection, concurrency: 4 });
      closers.push(worker);
      return worker;
    };
    const add = (jobName: JobName, albumId: string) =>
      queue.add(jobName, { id: albumId }, tripJobOptions(jobName, albumId));
    const finished = (count: number) =>
      new Promise<void>((resolve) => {
        let seen = 0;
        const onFinished = () => {
          if (++seen < count) {
            return;
          }
          events.off('completed', onFinished);
          events.off('failed', onFinished);
          resolve();
        };
        events.on('completed', onFinished);
        events.on('failed', onFinished);
      });
    return { queue, start, add, finished };
  };

  it('keeps one waiting job per trip for a burst of events', async () => {
    const { queue, add } = await setup(async () => {});

    for (let i = 0; i < 20; i++) {
      await add(JobName.TripFile, 'album-1');
    }

    expect(await queue.getJobCounts('waiting')).toMatchObject({ waiting: 1 });
  });

  it('keeps the jobs of other trips and other job names apart', async () => {
    const { queue, add } = await setup(async () => {});

    await add(JobName.TripFile, 'album-1');
    await add(JobName.TripFile, 'album-2');
    await add(JobName.TripName, 'album-1');
    await add(JobName.TripRouteLegs, 'album-1');

    expect(await queue.getJobCounts('waiting')).toMatchObject({ waiting: 4 });
  });

  it('runs once more after a run that events arrived during, and never in parallel for one trip', async () => {
    const first = gate();
    const started = gate();
    let running = 0;
    let overlapped = false;
    let runs = 0;
    const { queue, start, add, finished } = await setup(async () => {
      running++;
      overlapped ||= running > 1;
      runs++;
      if (runs === 1) {
        started.open();
        await first.opened;
      }
      running--;
    });
    const done = finished(2);
    await add(JobName.TripFile, 'album-1');
    start();
    await started.opened;

    // An asset's metadata is read while the first filing runs.
    for (let i = 0; i < 5; i++) {
      await add(JobName.TripFile, 'album-1');
    }
    first.open();
    await done;

    expect(runs).toBe(2);
    expect(overlapped).toBe(false);
    expect(await queue.getJobCounts('waiting', 'active', 'delayed', 'completed', 'failed')).toMatchObject({
      waiting: 0,
      active: 0,
      delayed: 0,
      completed: 0,
      failed: 0,
    });
  });

  it('does not let a failed run block the next one for the same trip', async () => {
    let runs = 0;
    const { queue, start, add, finished } = await setup(() => {
      runs++;
      return runs === 1 ? Promise.reject(new Error('Nominatim is down')) : Promise.resolve();
    });
    start();

    const failed = finished(1);
    await add(JobName.TripName, 'album-1');
    await failed;
    expect(await queue.getJobCounts('failed')).toEqual({ failed: 0 });

    const completed = finished(1);
    await add(JobName.TripName, 'album-1');
    await completed;
    expect(runs).toBe(2);
  });
});
