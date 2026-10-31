import { createZodDto } from 'nestjs-zod';
import z from 'zod';
import {
  TripKind,
  TripLegMode,
  TripLegStatus,
  TripOverlayKind,
  TripPointSource,
  TripStationSide,
  TripStopRole,
} from 'src/trips/enum.js';
import { normalizeTripLanguage } from 'src/trips/utils/naming.js';
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

// A language tag such as `de`, `pt-BR` or Gallery's `zh_Hans`, normalised as Nominatim's `accept-language` takes it.
const TripLanguageSchema = z
  .string()
  .transform((value, ctx) => {
    const language = normalizeTripLanguage(value);
    if (language === null) {
      ctx.addIssue({ code: 'custom', message: `Not a language tag: ${value}` });
      return z.NEVER;
    }
    return language;
  })
  .nullable()
  .default(null)
  .describe('Language the trip’s stops are named in; null names them in the server’s default')
  .meta({ example: 'de' });

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
  polyline: text('The line, as an encoded polyline of precision 6 (as Valhalla returns it)'),
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
    language: TripLanguageSchema,
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
    language: z.string().nullable().describe('Language the trip’s stops are named in; null is the server’s default'),
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

// An editor's text: blank clears it, so naming fills the title again (travel-album `editor.update_stop`).
const editedText = (description: string) =>
  z
    .string()
    .nullable()
    .transform((value) => value?.trim() || null)
    .optional()
    .describe(description);

const TripStopUpdateSchema = z
  .object({
    title: editedText('Stop title; blank clears it'),
    story: editedText('Stop story; blank clears it'),
    placeId: z.uuidv4().nullable().optional().describe('Place of the stop, in the same trip; null for none'),
    latitude: latitudeSchema.optional().describe('Where the owner puts the pin; kept until given back to the assets'),
    longitude: longitudeSchema.optional().describe('Where the owner puts the pin; kept until given back to the assets'),
    isPositionManual: z.literal(false).optional().describe('false puts the pin back at the mean of the stop’s assets'),
  })
  .superRefine((dto, ctx) => {
    const issue = (message: string) => ctx.addIssue({ code: 'custom', message });
    if (Object.values(dto).every((value) => value === undefined)) {
      issue('Nothing to change');
    }
    if ((dto.latitude === undefined) !== (dto.longitude === undefined)) {
      issue('A pin takes both a latitude and a longitude');
    }
    if (dto.latitude !== undefined && dto.isPositionManual === false) {
      issue('A pin is either moved or given back to the assets');
    }
  })
  .meta({ id: 'TripStopUpdateDto' });

const assetIdsSchema = z.array(z.uuidv4()).min(1).describe('Album asset IDs, outside the trash');

const TripStopSplitSchema = z
  .object({ assetId: z.uuidv4().describe('The stop’s asset that begins the new stop, with every later one') })
  .meta({ id: 'TripStopSplitDto' });

const TripStopCreateSchema = z.object({ assetIds: assetIdsSchema }).meta({ id: 'TripStopCreateDto' });

const TripAssetsMoveSchema = z
  .object({ assetIds: assetIdsSchema, stopId: z.uuidv4().describe('Stop of the same trip the assets go to') })
  .meta({ id: 'TripAssetsMoveDto' });

const TripEndSchema = z
  .object({
    latitude: latitudeSchema.describe('Latitude'),
    longitude: longitudeSchema.describe('Longitude'),
    title: editedText('Name of the point; blank leaves it to naming through Nominatim'),
  })
  .meta({ id: 'TripEndDto' });

const afterStopIdSchema = z
  .uuidv4()
  .nullable()
  .describe('Stop of the same trip the point goes right after; null puts it right after the start');

const TripPointCreateSchema = TripEndSchema.extend({ afterStopId: afterStopIdSchema.default(null) }).meta({
  id: 'TripPointCreateDto',
});

const TripPointOrderSchema = z.object({ afterStopId: afterStopIdSchema }).meta({ id: 'TripPointOrderDto' });

const TripFinishUpdateSchema = z
  .object({
    latitude: latitudeSchema.optional().describe('Latitude'),
    longitude: longitudeSchema.optional().describe('Longitude'),
    title: editedText('Name of the point; blank leaves it to naming through Nominatim'),
    isFinishAtStart: z
      .boolean()
      .default(false)
      .describe('The route ends where it began, and the finish follows the start'),
  })
  .superRefine((dto, ctx) => {
    const hasPoint = dto.latitude !== undefined && dto.longitude !== undefined;
    if ((dto.latitude === undefined) !== (dto.longitude === undefined) || hasPoint === dto.isFinishAtStart) {
      ctx.addIssue({ code: 'custom', message: 'A finish takes either a point or isFinishAtStart' });
    }
  })
  .meta({ id: 'TripFinishUpdateDto' });

const TripTransitUpdateSchema = z
  .object({
    stopIds: z.array(z.uuidv4()).min(1).describe('Stops of the same trip, of assets'),
    isTransit: z
      .boolean()
      .nullable()
      .describe('Shot on the way; false declines the suggestion for good, null leaves it undecided'),
  })
  .meta({ id: 'TripTransitUpdateDto' });

const TripAssetPointSchema = z
  .object({ latitude: latitudeSchema.describe('Latitude'), longitude: longitudeSchema.describe('Longitude') })
  .meta({ id: 'TripAssetPointDto' });

const TripAssetsCenterSchema = z
  .object({
    assetIds: assetIdsSchema,
    centre: TripEndSchema.nullable()
      .default(null)
      .describe(
        'Where the centre stop is made, when the trip has none yet; its title, such as “Kraków, no exact place”',
      ),
  })
  .meta({ id: 'TripAssetsCenterDto' });

const TripGeoSearchSchema = z
  .object({ query: z.string().trim().min(1).max(300).describe('Address or name of a place') })
  .meta({ id: 'TripGeoSearchDto' });

const TripGeoReverseSchema = z
  .object({
    latitude: z.coerce.number().pipe(latitudeSchema).describe('Latitude'),
    longitude: z.coerce.number().pipe(longitudeSchema).describe('Longitude'),
  })
  .meta({ id: 'TripGeoReverseQueryDto' });

const TripGeoPlaceSchema = z
  .object({
    label: z.string().describe('Name of the place'),
    region: text('City, town, village or county'),
    district: text('Part of the city, when it is not the city itself'),
    country: text('Country'),
    latitude: z.number().meta({ format: 'double' }).describe('Latitude'),
    longitude: z.number().meta({ format: 'double' }).describe('Longitude'),
  })
  .meta({ id: 'TripGeoPlaceDto' });

const TripGeoPlacesSchema = z
  .object({ places: z.array(TripGeoPlaceSchema).describe('Places found, at most five') })
  .meta({ id: 'TripGeoPlacesDto' });

const TripPlaceHintSchema = z
  .object({
    stopId: z.string().describe('Stop ID of the place'),
    assetIds: z.array(z.string()).describe('Unplaced asset IDs like an asset of the place, most similar first'),
  })
  .meta({ id: 'TripPlaceHintDto' });

const TripPlaceHintsSchema = z
  .object({
    places: z.array(TripPlaceHintSchema).describe('Places offered, the one with most assets first'),
    center: z.array(z.string()).describe('Unplaced asset IDs like no asset of a place, offered the centre'),
  })
  .meta({ id: 'TripPlaceHintsDto' });

const TripCameraSchema = z
  .object({
    make: z.string().nullable().describe('EXIF make'),
    model: z.string().nullable().describe('EXIF model'),
    isVideo: z.boolean().describe('Videos are a camera of their own'),
    assetCount: z.int().describe('Assets of the camera in the album'),
    gpsCount: z.int().describe('Of them, assets with their own GPS'),
    isReference: z.boolean().describe('At least half of its assets have GPS; its stops time the other cameras'),
    ownAssetIds: z.array(z.string()).describe('The caller’s assets of the camera, the only ones they may shift'),
    suggestion: z
      .object({
        offsetMinutes: z.int().describe('Minutes to add to the camera’s times'),
        current: z.number().describe('Share of its assets in a reference stop as they are'),
        best: z.number().describe('Share of its assets in a reference stop after the shift'),
      })
      .nullable()
      .describe('A shift worth applying, or null'),
  })
  .meta({ id: 'TripCameraDto' });

const TripCamerasSchema = z
  .object({ cameras: z.array(TripCameraSchema).describe('Cameras of the album, most assets first') })
  .meta({ id: 'TripCamerasDto' });

const TripCreateSchema = z
  .object({
    albumId: z.uuidv4().describe('Album ID; the trip takes it'),
    kind: TripKindSchema,
    start: TripEndSchema.nullable().default(null).describe('Where a route begins'),
    finish: TripEndSchema.nullable().default(null).describe('Where a route ends'),
    isFinishAtStart: z.boolean().default(false).describe('The route ends where it began'),
    language: TripLanguageSchema,
  })
  .superRefine((trip, ctx) => {
    const issue = (message: string) => ctx.addIssue({ code: 'custom', message });
    if ((trip.start || trip.finish || trip.isFinishAtStart) && trip.kind !== TripKind.Route) {
      issue('Only a Route trip has a start and a finish');
    }
    if (trip.isFinishAtStart && (!trip.start || trip.finish)) {
      issue('A finish at the start needs a start and no finish of its own');
    }
  })
  .meta({ id: 'TripCreateDto' });

const TripStopParamSchema = z.object({
  id: z.uuidv4(),
  stopId: z.uuidv4(),
});

const TripLegParamSchema = z.object({
  id: z.uuidv4(),
  legId: z.uuidv4(),
});

// Leg editing (travel-album `set_leg_mode`, `set_leg_station`): a trail comes only from an import, so it is not offered.
const TripLegModeUpdateSchema = z
  .object({
    mode: TripLegModeSchema.nullable().describe(
      'The owner’s mode, kept from now on; null returns to the default by distance',
    ),
  })
  .refine(({ mode }) => mode !== TripLegMode.Trail, { error: 'A trail comes only from an import' })
  .meta({ id: 'TripLegModeUpdateDto' });

const TripStationSideSchema = z.enum(TripStationSide).describe('End of a train leg').meta({ id: 'TripStationSide' });

const stationFields = {
  name: z.string().describe('Station name, as OpenStreetMap has it; may be empty'),
  latitude: latitudeSchema.describe('Station latitude'),
  longitude: longitudeSchema.describe('Station longitude'),
};

const TripStationSchema = z
  .object({ ...stationFields, distance: z.int32().describe('Metres from the stop') })
  .meta({ id: 'TripStationDto' });

const TripLegStationsSchema = z
  .object({
    departure: z.array(TripStationSchema).describe('Stations near the stop the leg leaves, nearest first'),
    arrival: z.array(TripStationSchema).describe('Stations near the stop the leg reaches, nearest first'),
  })
  .meta({ id: 'TripLegStationsDto' });

const TripLegStationUpdateSchema = z
  .object({ side: TripStationSideSchema, ...stationFields })
  .meta({ id: 'TripLegStationUpdateDto' });

export class TripImportDto extends createZodDto(TripImportSchema) {}
export class TripCreateDto extends createZodDto(TripCreateSchema) {}
export class TripEndDto extends createZodDto(TripEndSchema) {}
export class TripStopUpdateDto extends createZodDto(TripStopUpdateSchema) {}
export class TripPointCreateDto extends createZodDto(TripPointCreateSchema) {}
export class TripPointOrderDto extends createZodDto(TripPointOrderSchema) {}
export class TripFinishUpdateDto extends createZodDto(TripFinishUpdateSchema) {}
export class TripTransitUpdateDto extends createZodDto(TripTransitUpdateSchema) {}
export class TripAssetPointDto extends createZodDto(TripAssetPointSchema) {}
export class TripAssetsCenterDto extends createZodDto(TripAssetsCenterSchema) {}
export class TripGeoSearchDto extends createZodDto(TripGeoSearchSchema) {}
export class TripGeoReverseQueryDto extends createZodDto(TripGeoReverseSchema) {}
export class TripGeoPlacesDto extends createZodDto(TripGeoPlacesSchema) {}
export class TripPlaceHintsDto extends createZodDto(TripPlaceHintsSchema) {}
export class TripCamerasDto extends createZodDto(TripCamerasSchema) {}
export class TripStopSplitDto extends createZodDto(TripStopSplitSchema) {}
export class TripStopCreateDto extends createZodDto(TripStopCreateSchema) {}
export class TripAssetsMoveDto extends createZodDto(TripAssetsMoveSchema) {}
export class TripStopParamDto extends createZodDto(TripStopParamSchema) {}
export class TripLegParamDto extends createZodDto(TripLegParamSchema) {}
export class TripLegModeUpdateDto extends createZodDto(TripLegModeUpdateSchema) {}
export class TripLegStationsDto extends createZodDto(TripLegStationsSchema) {}
export class TripLegStationUpdateDto extends createZodDto(TripLegStationUpdateSchema) {}
export class TripResponseDto extends createZodDto(TripResponseSchema) {}
export class TripLikeDto extends createZodDto(TripLikeSchema) {}
