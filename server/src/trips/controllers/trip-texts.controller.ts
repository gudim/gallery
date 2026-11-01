import { Body, Controller, Get, Param, Post, Put, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import { Endpoint, HistoryBuilder } from 'src/decorators.js';
import { Permission } from 'src/enum.js';
import { Auth, Authenticated } from 'src/middleware/auth.guard.js';
import {
  TripLlmSettingsResponseDto,
  TripLlmSettingsUpdateDto,
  TripTextsEstimateDto,
  TripTextsEstimateQueryDto,
  TripTextsProgressDto,
  TripTextsStartDto,
} from 'src/trips/dtos/trip-texts.dto.js';
import { TripTextsService } from 'src/trips/services/trip-texts.service.js';
import { UUIDParamDto } from 'src/validation.js';

// LLM texts of trips (trips PLAN §2.6). The settings have their own path: `GET trips/:id` would take
// `trips/llm-settings` as a trip ID.
@ApiTags('Trips')
@Controller()
export class TripTextsController {
  constructor(private service: TripTextsService) {}

  @Get('trip-llm-settings')
  @Authenticated({ permission: Permission.UserPreferenceRead })
  @Endpoint({
    summary: 'Retrieve my LLM settings for trip texts',
    description:
      'Returns the caller’s OpenAI-compatible server for generating trip texts. The key itself is never returned, only whether one is saved and readable.',
    history: new HistoryBuilder().added('v1').beta('v1'),
  })
  getTripLlmSettings(@Auth() auth: AuthDto): Promise<TripLlmSettingsResponseDto> {
    return this.service.getSettings(auth);
  }

  @Put('trip-llm-settings')
  @Authenticated({ permission: Permission.UserPreferenceUpdate })
  @Endpoint({
    summary: 'Update my LLM settings for trip texts',
    description:
      'Saves the caller’s OpenAI-compatible server. A saved key is kept only while the URL stays; a new key needs TRIPS_LLM_SECRET on the server and is stored encrypted.',
    history: new HistoryBuilder().added('v1').beta('v1'),
  })
  updateTripLlmSettings(
    @Auth() auth: AuthDto,
    @Body() dto: TripLlmSettingsUpdateDto,
  ): Promise<TripLlmSettingsResponseDto> {
    return this.service.updateSettings(auth, dto);
  }

  @Get('trips/:id/texts/estimate')
  @Authenticated({ permission: Permission.AlbumUpdate })
  @Endpoint({
    summary: 'Estimate generating a trip’s texts',
    description:
      'Counts the model calls, assets, stops and places a run would take, the owner’s own texts it would keep, and why generation is off if it is. Album owner only.',
    history: new HistoryBuilder().added('v1').beta('v1'),
  })
  estimateTripTexts(
    @Auth() auth: AuthDto,
    @Param() { id }: UUIDParamDto,
    @Query() dto: TripTextsEstimateQueryDto,
  ): Promise<TripTextsEstimateDto> {
    return this.service.estimate(auth, id, dto);
  }

  @Post('trips/:id/texts')
  @Authenticated({ permission: Permission.AlbumUpdate })
  @Endpoint({
    summary: 'Generate a trip’s texts',
    description:
      'Queues generation of stop titles, stories and captions, then place articles, for the whole trip or one stop, replacing any run before it. Empty and generated texts are written; the owner’s own only with overwrite. Album owner only.',
    history: new HistoryBuilder().added('v1').beta('v1'),
  })
  startTripTexts(
    @Auth() auth: AuthDto,
    @Param() { id }: UUIDParamDto,
    @Body() dto: TripTextsStartDto,
  ): Promise<TripTextsProgressDto> {
    return this.service.start(auth, id, dto);
  }

  @Get('trips/:id/texts')
  @Authenticated({ permission: Permission.AlbumUpdate })
  @Endpoint({
    summary: 'Retrieve the progress of a trip’s texts',
    description: 'Returns how many stops and places are still to write and which failed after their retries.',
    history: new HistoryBuilder().added('v1').beta('v1'),
  })
  getTripTextsProgress(@Auth() auth: AuthDto, @Param() { id }: UUIDParamDto): Promise<TripTextsProgressDto> {
    return this.service.getProgress(auth, id);
  }

  @Post('trips/:id/texts/retry')
  @Authenticated({ permission: Permission.AlbumUpdate })
  @Endpoint({
    summary: 'Retry a trip’s failed texts',
    description: 'Sends the stops and places that failed after their retries again.',
    history: new HistoryBuilder().added('v1').beta('v1'),
  })
  retryTripTexts(@Auth() auth: AuthDto, @Param() { id }: UUIDParamDto): Promise<TripTextsProgressDto> {
    return this.service.retry(auth, id);
  }
}
