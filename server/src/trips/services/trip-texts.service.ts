import { Injectable } from '@nestjs/common';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import { TripLlmSettingsResponseDto, TripLlmSettingsUpdateDto } from 'src/trips/dtos/trip-texts.dto.js';
import { TripTextsRepository } from 'src/trips/repositories/trip-texts.repository.js';
import { nextLlmKeyCipher, resolveLlmSecret, tripLlmKeyState } from 'src/trips/utils/llm-key.js';

// LLM texts of trips (trips PLAN §2.6).
@Injectable()
export class TripTextsService {
  private readonly secret = resolveLlmSecret();

  constructor(private tripTextsRepository: TripTextsRepository) {}

  async getSettings(auth: AuthDto): Promise<TripLlmSettingsResponseDto> {
    const settings = await this.tripTextsRepository.getSettings(auth.user.id);
    return {
      url: settings?.url ?? '',
      model: settings?.model ?? '',
      key: tripLlmKeyState(settings?.keyCipher ?? null, this.secret),
      allowUpload: settings?.allowUpload ?? false,
      canStoreKey: !!this.secret,
    };
  }

  async updateSettings(auth: AuthDto, dto: TripLlmSettingsUpdateDto): Promise<TripLlmSettingsResponseDto> {
    const previous = await this.tripTextsRepository.getSettings(auth.user.id);
    await this.tripTextsRepository.upsertSettings({
      userId: auth.user.id,
      url: dto.url,
      model: dto.model,
      keyCipher: nextLlmKeyCipher(previous, dto, this.secret),
      allowUpload: dto.allowUpload,
    });
    return this.getSettings(auth);
  }
}
