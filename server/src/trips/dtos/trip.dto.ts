import { createZodDto } from 'nestjs-zod';
import z from 'zod';
import {
  TripKind,
  TripLegMode,
  TripLegStatus,
  TripOverlayKind,
  TripPointSource,
  TripStopRole,
} from 'src/trips/enum.js';
import { latitudeSchema, longitudeSchema } from 'src/validation.js';

// The trip document (trips PLAN §2.1): what an import takes and, with server ids in place of document keys, what a
// read returns. A stop's local times are wall-clock times written as UTC, like an asset's localDateTime.

const TripKindSchema = z.enum(TripKind).describe('Trip kind').meta({ id: 'TripKind' });
const TripStopRoleSchema = z.enum(TripStopRole).describe('Start or finish of a route').meta({ id: 'TripStopRole' });
const TripPointSourceSchema = z
  .enum(TripPointSource)
  .describe('Where the point of an asset in the trip comes from')
  .meta({ id: 'TripPointSource' });
const TripLegModeSchema = z.enum(TripLegMode).describe('Leg mode').meta({ id: 'TripLegMode' });
const TripLegStatusSchema = z.enum(TripLegStatus).describe('Leg status').meta({ id: 'TripLegStatus' });
const TripOverlayKindSchema = z.enum(TripOverlayKind).describe('Overlay kind').meta({ id: 'TripOverlayKind' });

const text = (description: string) => z.string().nullable().describe(description);
const double = (description: string) => z.number().meta({ format: 'double' }).nullable().describe(description);
const localTime = (description: string) => z.string().meta({ format: 'date-time' }).nullable().describe(description);

// Wall-clock time: `Z` or no offset, both read as that wall-clock time. Any other offset would shift it, so it is refused.
const localTimeToDate = z
  .codec(
    z.iso.datetime({
      local: true,
      error: (iss) =>
        `Invalid input: expected a local ISO 8601 datetime without an offset, received ${String(iss.input)}`,
    }),
    z.date(),
    {
      decode: (isoString) => new Date(isoString.endsWith('Z') ? isoString : `${isoString}Z`),
      encode: (date) => date.toISOString(),
    },
  )
  .meta({ example: '2026-05-01T10:00:00.000Z' });

const placeFields = {
  key: z.string().min(1).describe('Name of the place within the trip'),
  title: text('Place title'),
  article: text('Place article'),
  articleSource: text('Who wrote the article'),
};

const stopFields = {
  latitude: latitudeSchema.nullable().describe('Stop latitude'),
  longitude: longitudeSchema.nullable().describe('Stop longitude'),
  isPositionManual: z.boolean().describe('The owner moved the pin'),
  sequence: z.int32().describe('Order among stops that start at the same time'),
  title: text('Stop title'),
  titleSource: text('Who wrote the title'),
  story: text('Stop story'),
  storySource: text('Who wrote the story'),
  region: text('Region'),
  country: text('Country'),
  isAddedByHand: z.boolean().describe('A stop the owner added by hand, not made from assets'),
  role: TripStopRoleSchema.nullable(),
  isFinishAtStart: z.boolean().describe('The finish is the same place as the start'),
  isTransit: z.boolean().nullable().describe('Shot on the way: true yes, false declined, null not decided'),
  isAtCenter: z.boolean().describe('Places trip: assets filed to the centre, no exact place'),
};

const assetPointFields = {
  latitude: latitudeSchema.nullable().describe('Inferred or manual latitude, in the trip only'),
  longitude: longitudeSchema.nullable().describe('Inferred or manual longitude, in the trip only'),
  pointSource: TripPointSourceSchema.nullable(),
};

const legFields = {
  mode: TripLegModeSchema,
  isModeManual: z.boolean().describe('The owner picked the mode'),
  status: TripLegStatusSchema,
  polyline: text('Encoded polyline of the line'),
  distance: double('Length in metres'),
  duration: double('Duration in seconds'),
  departureName: text('Train departure station'),
  departureLatitude: latitudeSchema.nullable().describe('Train departure latitude'),
  departureLongitude: longitudeSchema.nullable().describe('Train departure longitude'),
  arrivalName: text('Train arrival station'),
  arrivalLatitude: latitudeSchema.nullable().describe('Train arrival latitude'),
  arrivalLongitude: longitudeSchema.nullable().describe('Train arrival longitude'),
};

const overlayFields = {
  kind: TripOverlayKindSchema,
  color: text('Line colour'),
  geometry: z.record(z.string(), z.unknown()).describe('GeoJSON geometry'),
};

const likeCountSchema = z.int32().min(1).describe('Number of likes');

const unique = (values: string[]) => values.length === new Set(values).size;

const TripImportSchema = z
  .object({
    kind: TripKindSchema,
    isFavorites: z.boolean().default(false).describe('The owner’s Favorites trip; Places only'),
    isShowcased: z.boolean().default(false).describe('Marked for the owner’s showcase'),
    places: z.array(z.object(placeFields)).default([]),
    stops: z
      .array(
        z.object({
          key: z.string().min(1).describe('Name of the stop within the document'),
          placeKey: z.string().nullable().describe('Key of the stop’s place'),
          ...stopFields,
          localStart: localTimeToDate.nullable().describe('Local start time'),
          localEnd: localTimeToDate.nullable().describe('Local end time'),
        }),
      )
      .default([]),
    assets: z
      .array(
        z.object({
          assetId: z.uuidv4().describe('Asset ID; the asset must be in the album'),
          stopKey: z.string().nullable().describe('Key of the asset’s stop; null is Unplaced'),
          ...assetPointFields,
          generatedCaption: z
            .string()
            .min(1)
            .nullable()
            .default(null)
            .describe('The caption an LLM wrote, when the asset description is still that text'),
        }),
      )
      .default([]),
    legs: z
      .array(
        z.object({
          fromStopKey: z.string().describe('Key of the stop the leg leaves'),
          toStopKey: z.string().describe('Key of the stop the leg reaches'),
          ...legFields,
        }),
      )
      .default([]),
    overlays: z.array(z.object(overlayFields)).default([]),
    likes: z
      .array(z.object({ assetId: z.uuidv4().describe('Asset ID'), count: likeCountSchema }))
      .default([])
      .describe('Like counts carried over from elsewhere'),
  })
  .superRefine((trip, ctx) => {
    const issue = (message: string) => ctx.addIssue({ code: 'custom', message });
    const placeKeys = new Set(trip.places.map(({ key }) => key));
    const stopKeys = new Set(trip.stops.map(({ key }) => key));
    if (!unique(trip.places.map(({ key }) => key))) {
      issue('Place keys must be unique');
    }
    if (!unique(trip.stops.map(({ key }) => key))) {
      issue('Stop keys must be unique');
    }
    if (!unique(trip.assets.map(({ assetId }) => assetId))) {
      issue('Assets must be unique');
    }
    if (!unique(trip.likes.map(({ assetId }) => assetId))) {
      issue('Like assets must be unique');
    }
    for (const role of Object.values(TripStopRole)) {
      if (trip.stops.filter((stop) => stop.role === role).length > 1) {
        issue(`At most one stop can be the ${role}`);
      }
    }
    if (trip.isFavorites && trip.kind !== TripKind.Places) {
      issue('A Favorites trip is a Places trip');
    }
    const endStopKeys = new Set(trip.stops.filter(({ role }) => role !== null).map(({ key }) => key));
    if (endStopKeys.size > 0 && trip.kind !== TripKind.Route) {
      issue('Only a Route trip has a start and a finish');
    }
    for (const stop of trip.stops) {
      if (stop.placeKey !== null && !placeKeys.has(stop.placeKey)) {
        issue(`Stop ${stop.key} names an unknown place ${stop.placeKey}`);
      }
      if (stop.localStart && stop.localEnd && stop.localEnd < stop.localStart) {
        issue(`Stop ${stop.key} ends before it starts`);
      }
    }
    for (const asset of trip.assets) {
      if (asset.stopKey !== null && !stopKeys.has(asset.stopKey)) {
        issue(`Asset ${asset.assetId} names an unknown stop ${asset.stopKey}`);
      }
      if (asset.stopKey !== null && endStopKeys.has(asset.stopKey)) {
        issue(`Asset ${asset.assetId} is filed to a start or finish, which has no assets`);
      }
      if (
        (asset.pointSource === null) !== (asset.latitude === null) ||
        (asset.latitude === null) !== (asset.longitude === null)
      ) {
        issue(`Asset ${asset.assetId} needs latitude, longitude and pointSource together`);
      }
    }
    for (const leg of trip.legs) {
      if (!stopKeys.has(leg.fromStopKey) || !stopKeys.has(leg.toStopKey)) {
        issue(`Leg ${leg.fromStopKey} → ${leg.toStopKey} names an unknown stop`);
      }
      if (leg.fromStopKey === leg.toStopKey) {
        issue(`Leg ${leg.fromStopKey} → ${leg.toStopKey} leaves and reaches the same stop`);
      }
    }
  })
  .meta({ id: 'TripImportDto' });

const TripLikeSchema = z
  .object({
    assetId: z.string().describe('Asset ID'),
    count: z.int32().min(0).describe('Number of likes'),
    isLiked: z.boolean().describe('The caller liked the asset: a user, or a guest by their browser key'),
  })
  .meta({ id: 'TripLikeDto' });

const TripResponseSchema = z
  .object({
    albumId: z.string().describe('Album ID; a trip has its album’s ID'),
    kind: TripKindSchema,
    isFavorites: z.boolean().describe('The owner’s Favorites trip'),
    isShowcased: z.boolean().describe('Marked for the owner’s showcase'),
    isFeatured: z.boolean().describe('Picked by an admin for the home page'),
    contentVersion: z.int32().describe('Bumped by every change a guest can see'),
    places: z.array(z.object({ id: z.string().describe('Place ID'), ...placeFields }).meta({ id: 'TripPlaceDto' })),
    stops: z
      .array(
        z
          .object({
            id: z.string().describe('Stop ID'),
            placeId: z.string().nullable().describe('Place ID'),
            ...stopFields,
            localStart: localTime('Local start time'),
            localEnd: localTime('Local end time'),
          })
          .meta({ id: 'TripStopDto' }),
      )
      .describe('Stops in trip order'),
    assets: z
      .array(
        z
          .object({
            assetId: z.string().describe('Asset ID'),
            stopId: z.string().nullable().describe('Stop ID; null is Unplaced'),
            ...assetPointFields,
          })
          .meta({ id: 'TripAssetDto' }),
      )
      .describe('Every album asset outside the trash, in time order'),
    legs: z.array(
      z
        .object({
          id: z.string().describe('Leg ID'),
          fromStopId: z.string().describe('Stop the leg leaves'),
          toStopId: z.string().describe('Stop the leg reaches'),
          ...legFields,
        })
        .meta({ id: 'TripLegDto' }),
    ),
    overlays: z.array(
      z.object({ id: z.string().describe('Overlay ID'), ...overlayFields }).meta({ id: 'TripOverlayDto' }),
    ),
    likes: z.array(TripLikeSchema).describe('Like counts of liked assets'),
  })
  .meta({ id: 'TripResponseDto' });

export class TripImportDto extends createZodDto(TripImportSchema) {}
export class TripResponseDto extends createZodDto(TripResponseSchema) {}
export class TripLikeDto extends createZodDto(TripLikeSchema) {}
