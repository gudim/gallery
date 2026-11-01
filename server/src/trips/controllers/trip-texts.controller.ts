import { Body, Controller, Get, Put } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import { Endpoint, HistoryBuilder } from 'src/decorators.js';
import { Permission } from 'src/enum.js';
import { Auth, Authenticated } from 'src/middleware/auth.guard.js';
import { TripLlmSettingsResponseDto, TripLlmSettingsUpdateDto } from 'src/trips/dtos/trip-texts.dto.js';
import { TripTextsService } from 'src/trips/services/trip-texts.service.js';

// Its own path, not trips/…: `GET trips/:id` would take `trips/llm-settings` as a trip ID.
@ApiTags('Trips')
@Controller('trip-llm-settings')
export class TripTextsController {
  constructor(private service: TripTextsService) {}

  @Get()
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

  @Put()
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
}
