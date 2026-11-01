import { Reflector } from '@nestjs/core';
import { describe, expect, it } from 'vitest';
import { JobConfig } from 'src/decorators.js';
import { MetadataKey, QueueName } from 'src/enum.js';
import { TripNameService } from 'src/trips/services/trip-name.service.js';
import { TripTextsService } from 'src/trips/services/trip-texts.service.js';
import { TripService } from 'src/trips/services/trip.service.js';

// The jobs that call outside services share one queue of one worker, as travel-album's `net` pool did.
describe('trip network queue', () => {
  it.each([
    ['naming', TripNameService.prototype.handleName],
    ['route legs', TripService.prototype.handleRouteLegs],
    ['texts', TripTextsService.prototype.handleTexts],
  ])('runs the %s job on it', (_, handler) => {
    expect(new Reflector().get<JobConfig>(MetadataKey.JobConfig, handler).queue).toBe(QueueName.TripNetwork);
  });
});
