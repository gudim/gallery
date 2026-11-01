import { createZodDto } from 'nestjs-zod';
import z from 'zod';
import { TripLlmKeyState } from 'src/trips/utils/llm-key.js';

// A user's OpenAI-compatible server for trip texts (trips PLAN D16, DECISIONS-LOG 2026-11-01).

const TripLlmSettingsUpdateSchema = z
  .object({
    url: z
      .url({ protocol: /^https?$/ })
      .describe('Base URL of an OpenAI-compatible API, such as https://api.openai.com/v1'),
    model: z.string().trim().min(1).describe('Model name'),
    key: z
      .string()
      .trim()
      .min(1)
      .nullable()
      .optional()
      .describe('API key: a new key, null to clear it, omitted to keep the saved one while the URL stays'),
    allowUpload: z.boolean().describe('The user agrees to send their photos to that server'),
  })
  .meta({ id: 'TripLlmSettingsUpdateDto' });

const TripLlmSettingsResponseSchema = z
  .object({
    url: z.string().describe('Base URL of an OpenAI-compatible API; empty when not set'),
    model: z.string().describe('Model name; empty when not set'),
    key: z.enum(TripLlmKeyState).describe('Whether a key is saved and readable').meta({ id: 'TripLlmKeyState' }),
    allowUpload: z.boolean().describe('The user agrees to send their photos to that server'),
    canStoreKey: z.boolean().describe('The server has TRIPS_LLM_SECRET set, so a key can be saved'),
  })
  .meta({ id: 'TripLlmSettingsResponseDto' });

export class TripLlmSettingsUpdateDto extends createZodDto(TripLlmSettingsUpdateSchema) {}
export class TripLlmSettingsResponseDto extends createZodDto(TripLlmSettingsResponseSchema) {}
