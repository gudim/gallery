import { createZodDto } from 'nestjs-zod';
import z from 'zod';
import { TripTextsProblem } from 'src/trips/enum.js';
import { TripLlmKeyState } from 'src/trips/utils/llm-key.js';
import { stringToBool } from 'src/validation.js';

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

// Generating a trip's texts (trips PLAN §2.6, DECISIONS-LOG 2026-11-01): the whole trip or one stop.

const stopIdField = z.uuidv4().optional().describe('Only this stop; omitted for the whole trip with its places');

const TripTextsStartSchema = z
  .object({
    stopId: stopIdField,
    overwrite: z.boolean().default(false).describe('Replace the owner’s own texts too'),
  })
  .meta({ id: 'TripTextsStartDto' });

const TripTextsEstimateQuerySchema = z
  .object({
    stopId: stopIdField,
    overwrite: stringToBool.default(false).describe('Replace the owner’s own texts too'),
  })
  .meta({ id: 'TripTextsEstimateQueryDto' });

const TripTextsProblemSchema = z
  .enum(TripTextsProblem)
  .nullable()
  .describe('Why generation is off, or null')
  .meta({ id: 'TripTextsProblem' });

const TripTextsEstimateSchema = z
  .object({
    calls: z.int32().describe('Model calls the run makes'),
    assets: z.int32().describe('Assets sent to the model'),
    stops: z.int32().describe('Stops that get texts'),
    places: z.int32().describe('Places that get an article'),
    ownTexts: z.int32().describe('The owner’s own texts in scope, kept unless overwrite is set'),
    problem: TripTextsProblemSchema,
  })
  .meta({ id: 'TripTextsEstimateDto' });

const TripTextsProgressSchema = z
  .object({
    pending: z.int32().describe('Stops and places still to write'),
    failed: z
      .array(
        z
          .object({
            stopId: z.string().nullable().describe('Stop ID'),
            placeId: z.string().nullable().describe('Place ID'),
            title: z.string().nullable().describe('Title of the stop or place'),
            error: z.string().describe('Why it failed'),
          })
          .meta({ id: 'TripTextsFailureDto' }),
      )
      .describe('Stops and places that failed after their retries'),
  })
  .meta({ id: 'TripTextsProgressDto' });

export class TripTextsStartDto extends createZodDto(TripTextsStartSchema) {}
export class TripTextsEstimateQueryDto extends createZodDto(TripTextsEstimateQuerySchema) {}
export class TripTextsEstimateDto extends createZodDto(TripTextsEstimateSchema) {}
export class TripTextsProgressDto extends createZodDto(TripTextsProgressSchema) {}
export class TripLlmSettingsUpdateDto extends createZodDto(TripLlmSettingsUpdateSchema) {}
export class TripLlmSettingsResponseDto extends createZodDto(TripLlmSettingsResponseSchema) {}
