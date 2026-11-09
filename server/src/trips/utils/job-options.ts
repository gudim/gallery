import { JobsOptions } from 'bullmq';
import { JobName } from 'src/enum.js';

/** The trip jobs deduplicated per trip; `JobRepository.getJobOptions` lists the same names as its `case` labels. */
export const tripDedupJobs = [JobName.TripFile, JobName.TripName, JobName.TripRouteLegs] as const;
export type TripDedupJobName = (typeof tripDedupJobs)[number];

/**
 * Options of the trip jobs that work on a whole trip (filing, naming, routing). Each run reads the trip afresh, so a
 * burst of events (a backup of 500 photos into the album) needs one waiting job, not one per asset. An event during a
 * run is not dropped: BullMQ keeps it and queues one more run after the active one, so runs of one trip never overlap
 * and nothing the event changed waits for the nightly sweep. A failed run is removed, which also releases the key.
 */
export const tripJobOptions = (name: TripDedupJobName, albumId: string): JobsOptions => ({
  deduplication: { id: `${name}/${albumId}`, keepLastIfActive: true },
  removeOnComplete: true,
  removeOnFail: true,
});
