import { Body, Controller, Delete, Get, Param, Patch, Post, Put, Query, Req, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Duration } from 'luxon';
import { randomBytes } from 'node:crypto';
import type { Request, Response } from 'express';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import type { LoginDetails } from 'src/services/auth.service.js';
import { Endpoint, HistoryBuilder } from 'src/decorators.js';
import { Permission } from 'src/enum.js';
import { Auth, Authenticated, GetLoginDetails } from 'src/middleware/auth.guard.js';
import {
  TripAssetPointDto,
  TripAssetsCenterDto,
  TripAssetsMoveDto,
  TripCreateDto,
  TripEndDto,
  TripFinishUpdateDto,
  TripGeoPlacesDto,
  TripGeoReverseQueryDto,
  TripGeoSearchDto,
  TripImportDto,
  TripLegModeUpdateDto,
  TripLegParamDto,
  TripLegStationUpdateDto,
  TripLegStationsDto,
  TripLikeDto,
  TripPlaceHintsDto,
  TripPointCreateDto,
  TripPointOrderDto,
  TripResponseDto,
  TripStopCreateDto,
  TripStopParamDto,
  TripStopSplitDto,
  TripStopUpdateDto,
  TripTransitUpdateDto,
} from 'src/trips/dtos/trip.dto.js';
import { TripService } from 'src/trips/services/trip.service.js';
import { UUIDAssetIDParamDto, UUIDParamDto } from 'src/validation.js';

// A guest's browser key for likes, set by the first like (trips DECISIONS-LOG 2026-10-31). httpOnly: the page never
// reads it, so a script cannot swap keys to like again. Imported likes carry `import:` keys, which this never matches.
const VIEWER_COOKIE = 'trips_viewer';
const VIEWER_KEY = /^[\w-]{32}$/;

const viewerKeyOf = (req: Request): string | undefined => {
  const value: unknown = req.cookies?.[VIEWER_COOKIE];
  return typeof value === 'string' && VIEWER_KEY.test(value) ? value : undefined;
};

@ApiTags('Trips')
@Controller('trips')
export class TripController {
  constructor(private service: TripService) {}

  @Get(':id')
  @Authenticated({ permission: Permission.AlbumRead, sharedLink: true })
  @Endpoint({
    summary: 'Retrieve a trip',
    description:
      'Returns the whole trip of an album: stops, places, legs, overlays, likes and where each album asset is filed. The trip has its album’s ID. Responds 404 when the album has no trip or the caller cannot read the album.',
    history: new HistoryBuilder().added('v1').beta('v1'),
  })
  getTrip(@Auth() auth: AuthDto, @Param() { id }: UUIDParamDto, @Req() req: Request): Promise<TripResponseDto> {
    return this.service.get(auth, id, viewerKeyOf(req));
  }

  @Put(':id/likes/:assetId')
  @Authenticated({ permission: Permission.AlbumRead, sharedLink: true })
  @Endpoint({
    summary: 'Like an asset in a trip',
    description:
      'Anyone who can read the trip likes its assets, once each: a user as themselves, a guest through a shared link by a browser key this sets in a cookie. Returns the asset’s likes.',
    history: new HistoryBuilder().added('v1').beta('v1'),
  })
  likeAsset(
    @Auth() auth: AuthDto,
    @Param() { id, assetId }: UUIDAssetIDParamDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @GetLoginDetails() { isSecure }: LoginDetails,
  ): Promise<TripLikeDto> {
    let viewerKey = viewerKeyOf(req);
    if (auth.sharedLink && !viewerKey) {
      viewerKey = randomBytes(24).toString('base64url');
      res.cookie(VIEWER_COOKIE, viewerKey, {
        path: '/',
        sameSite: 'lax',
        httpOnly: true,
        secure: isSecure,
        maxAge: Duration.fromObject({ days: 400 }).toMillis(),
      });
    }
    return this.service.like(auth, id, assetId, viewerKey);
  }

  @Delete(':id/likes/:assetId')
  @Authenticated({ permission: Permission.AlbumRead, sharedLink: true })
  @Endpoint({
    summary: 'Unlike an asset in a trip',
    description: 'Takes back the caller’s like of an asset in a trip. Returns the asset’s likes.',
    history: new HistoryBuilder().added('v1').beta('v1'),
  })
  unlikeAsset(
    @Auth() auth: AuthDto,
    @Param() { id, assetId }: UUIDAssetIDParamDto,
    @Req() req: Request,
  ): Promise<TripLikeDto> {
    return this.service.unlike(auth, id, assetId, viewerKeyOf(req));
  }

  @Post()
  @Authenticated({ permission: Permission.AlbumUpdate })
  @Endpoint({
    summary: 'Create a trip',
    description:
      'Makes a trip of an album and lays its assets out into stops by the trip kind; assets that fit no stop are Unplaced. A Route trip may take a start and a finish. Only the album owner can make a trip, and only of an album without one (409 otherwise). Returns the whole trip.',
    history: new HistoryBuilder().added('v1').beta('v1'),
  })
  createTrip(@Auth() auth: AuthDto, @Body() dto: TripCreateDto): Promise<TripResponseDto> {
    return this.service.create(auth, dto);
  }

  @Post(':id')
  @Authenticated({ permission: Permission.AlbumUpdate })
  @Endpoint({
    summary: 'Import a trip',
    description:
      'Creates the trip of an album from one document. Only the album owner can import, and only into an album without a trip (409 otherwise). Every asset the document names must be in the album.',
    history: new HistoryBuilder().added('v1').beta('v1'),
  })
  importTrip(
    @Auth() auth: AuthDto,
    @Param() { id }: UUIDParamDto,
    @Body() dto: TripImportDto,
  ): Promise<TripResponseDto> {
    return this.service.import(auth, id, dto);
  }

  @Patch(':id/stops/:stopId')
  @Authenticated({ permission: Permission.AlbumUpdate })
  @Endpoint({
    summary: 'Update a trip stop',
    description:
      'Sets a stop’s title, story, place or pin, or puts the pin back at the mean of its assets. The album owner and editors edit the trip; a viewer gets 403. A blank text is cleared and the title named again. The place must belong to the same trip. A moved pin routes its legs again. Returns the whole trip.',
    history: new HistoryBuilder().added('v1').beta('v1'),
  })
  updateStop(
    @Auth() auth: AuthDto,
    @Param() { id, stopId }: TripStopParamDto,
    @Body() dto: TripStopUpdateDto,
  ): Promise<TripResponseDto> {
    return this.service.updateStop(auth, id, stopId, dto);
  }

  @Post(':id/stops')
  @Authenticated({ permission: Permission.AlbumUpdate })
  @Endpoint({
    summary: 'Create a trip stop',
    description:
      'Makes a new stop of the chosen album assets; it takes its place in the trip by their times. A stop the move would leave without assets is refused. The album owner and editors edit the trip. Returns the whole trip.',
    history: new HistoryBuilder().added('v1').beta('v1'),
  })
  createStop(
    @Auth() auth: AuthDto,
    @Param() { id }: UUIDParamDto,
    @Body() dto: TripStopCreateDto,
  ): Promise<TripResponseDto> {
    return this.service.createStop(auth, id, dto);
  }

  @Post(':id/stops/:stopId/merge-next')
  @Authenticated({ permission: Permission.AlbumUpdate })
  @Endpoint({
    summary: 'Merge a trip stop with the next',
    description:
      'Merges a stop with the next one in trip order: the assets join the first, which keeps its texts and takes the second’s where its own are empty. Not for the start, the finish or a point added by hand. The album owner and editors edit the trip. Returns the whole trip.',
    history: new HistoryBuilder().added('v1').beta('v1'),
  })
  mergeNextStop(@Auth() auth: AuthDto, @Param() { id, stopId }: TripStopParamDto): Promise<TripResponseDto> {
    return this.service.mergeNextStop(auth, id, stopId);
  }

  @Post(':id/stops/:stopId/split')
  @Authenticated({ permission: Permission.AlbumUpdate })
  @Endpoint({
    summary: 'Split a trip stop',
    description:
      'Moves one of a stop’s assets and every later one into a new stop. The album owner and editors edit the trip. Returns the whole trip.',
    history: new HistoryBuilder().added('v1').beta('v1'),
  })
  splitStop(
    @Auth() auth: AuthDto,
    @Param() { id, stopId }: TripStopParamDto,
    @Body() dto: TripStopSplitDto,
  ): Promise<TripResponseDto> {
    return this.service.splitStop(auth, id, stopId, dto);
  }

  @Delete(':id/stops/:stopId')
  @Authenticated({ permission: Permission.AlbumUpdate })
  @Endpoint({
    summary: 'Delete a trip stop',
    description:
      'Deletes a stop without assets, such as a point added by hand; its neighbours get one leg. The album owner and editors edit the trip. Returns the whole trip.',
    history: new HistoryBuilder().added('v1').beta('v1'),
  })
  deleteStop(@Auth() auth: AuthDto, @Param() { id, stopId }: TripStopParamDto): Promise<TripResponseDto> {
    return this.service.deleteStop(auth, id, stopId);
  }

  @Post(':id/points')
  @Authenticated({ permission: Permission.AlbumUpdate })
  @Endpoint({
    summary: 'Add a point to a trip',
    description:
      'Adds a point by hand to a Route trip, right after a stop of the same trip or right after the start. Without a title, the point is named through Nominatim. The album owner and editors edit the trip. Returns the whole trip.',
    history: new HistoryBuilder().added('v1').beta('v1'),
  })
  addPoint(
    @Auth() auth: AuthDto,
    @Param() { id }: UUIDParamDto,
    @Body() dto: TripPointCreateDto,
  ): Promise<TripResponseDto> {
    return this.service.addPoint(auth, id, dto);
  }

  @Put(':id/stops/:stopId/order')
  @Authenticated({ permission: Permission.AlbumUpdate })
  @Endpoint({
    summary: 'Move a trip point in the order',
    description:
      'Puts a point added by hand right after another stop of the same trip, or right after the start. Stops of assets go by the time their assets were taken. The album owner and editors edit the trip. Returns the whole trip.',
    history: new HistoryBuilder().added('v1').beta('v1'),
  })
  movePoint(
    @Auth() auth: AuthDto,
    @Param() { id, stopId }: TripStopParamDto,
    @Body() dto: TripPointOrderDto,
  ): Promise<TripResponseDto> {
    return this.service.movePoint(auth, id, stopId, dto);
  }

  @Put(':id/start')
  @Authenticated({ permission: Permission.AlbumUpdate })
  @Endpoint({
    summary: 'Set the start of a trip',
    description:
      'Sets or moves where a Route trip begins; a finish at the start follows. Its legs are routed again. The album owner and editors edit the trip. Returns the whole trip.',
    history: new HistoryBuilder().added('v1').beta('v1'),
  })
  setStart(@Auth() auth: AuthDto, @Param() { id }: UUIDParamDto, @Body() dto: TripEndDto): Promise<TripResponseDto> {
    return this.service.setStart(auth, id, dto);
  }

  @Delete(':id/start')
  @Authenticated({ permission: Permission.AlbumUpdate })
  @Endpoint({
    summary: 'Remove the start of a trip',
    description:
      'Removes the start of a Route trip with its leg, and a finish at the start with it. The album owner and editors edit the trip. Returns the whole trip.',
    history: new HistoryBuilder().added('v1').beta('v1'),
  })
  removeStart(@Auth() auth: AuthDto, @Param() { id }: UUIDParamDto): Promise<TripResponseDto> {
    return this.service.setStart(auth, id, null);
  }

  @Put(':id/finish')
  @Authenticated({ permission: Permission.AlbumUpdate })
  @Endpoint({
    summary: 'Set the finish of a trip',
    description:
      'Sets or moves where a Route trip ends, or puts the finish at the start, which it follows from then on. Its legs are routed again. The album owner and editors edit the trip. Returns the whole trip.',
    history: new HistoryBuilder().added('v1').beta('v1'),
  })
  setFinish(
    @Auth() auth: AuthDto,
    @Param() { id }: UUIDParamDto,
    @Body() dto: TripFinishUpdateDto,
  ): Promise<TripResponseDto> {
    return this.service.setFinish(auth, id, dto);
  }

  @Delete(':id/finish')
  @Authenticated({ permission: Permission.AlbumUpdate })
  @Endpoint({
    summary: 'Remove the finish of a trip',
    description:
      'Removes the finish of a Route trip with its leg. The album owner and editors edit the trip. Returns the whole trip.',
    history: new HistoryBuilder().added('v1').beta('v1'),
  })
  removeFinish(@Auth() auth: AuthDto, @Param() { id }: UUIDParamDto): Promise<TripResponseDto> {
    return this.service.setFinish(auth, id, null);
  }

  @Put(':id/transit')
  @Authenticated({ permission: Permission.AlbumUpdate })
  @Endpoint({
    summary: 'Mark trip stops as shot on the way',
    description:
      'Marks stops of assets of a Route trip as shot on the way, not (the suggestion is not made again), or undecided. A stop on the way lies on the leg between the stops around it; that leg becomes a flight unless its mode was set, when a leg it replaces was a flight or the way was faster than 300 km/h. The album owner and editors edit the trip. Returns the whole trip.',
    history: new HistoryBuilder().added('v1').beta('v1'),
  })
  setTransit(
    @Auth() auth: AuthDto,
    @Param() { id }: UUIDParamDto,
    @Body() dto: TripTransitUpdateDto,
  ): Promise<TripResponseDto> {
    return this.service.setTransit(auth, id, dto);
  }

  @Put(':id/assets/stop')
  @Authenticated({ permission: Permission.AlbumUpdate })
  @Endpoint({
    summary: 'Move assets to a trip stop',
    description:
      'Files the chosen album assets into a stop of the same trip. A stop the move would leave without assets is refused: merge it instead. The album owner and editors edit the trip. Returns the whole trip.',
    history: new HistoryBuilder().added('v1').beta('v1'),
  })
  moveAssets(
    @Auth() auth: AuthDto,
    @Param() { id }: UUIDParamDto,
    @Body() dto: TripAssetsMoveDto,
  ): Promise<TripResponseDto> {
    return this.service.moveAssets(auth, id, dto);
  }

  @Put(':id/assets/center')
  @Authenticated({ permission: Permission.AlbumUpdate })
  @Endpoint({
    summary: 'File assets to the centre of a trip',
    description:
      'Files Unplaced assets of a Places trip into its centre stop, “<centre>, no exact place”. The first call makes that stop at the centre it gives; later ones leave it out. The album owner and editors edit the trip. Returns the whole trip.',
    history: new HistoryBuilder().added('v1').beta('v1'),
  })
  toCenter(
    @Auth() auth: AuthDto,
    @Param() { id }: UUIDParamDto,
    @Body() dto: TripAssetsCenterDto,
  ): Promise<TripResponseDto> {
    return this.service.toCenter(auth, id, dto);
  }

  @Put(':id/assets/:assetId/point')
  @Authenticated({ permission: Permission.AlbumUpdate })
  @Endpoint({
    summary: 'Set the point of an asset in a trip',
    description:
      'Sets where an asset was taken, for this trip only: the asset itself keeps its coordinates. Assets without GPS are placed again around it. The album owner and editors edit the trip. Returns the whole trip.',
    history: new HistoryBuilder().added('v1').beta('v1'),
  })
  setAssetPoint(
    @Auth() auth: AuthDto,
    @Param() { id, assetId }: UUIDAssetIDParamDto,
    @Body() dto: TripAssetPointDto,
  ): Promise<TripResponseDto> {
    return this.service.setAssetPoint(auth, id, assetId, dto);
  }

  @Delete(':id/assets/:assetId/point')
  @Authenticated({ permission: Permission.AlbumUpdate })
  @Endpoint({
    summary: 'Remove the point of an asset in a trip',
    description:
      'Removes the point set by hand for an asset in a trip, which goes back to its own GPS or a point inferred from its neighbours. The album owner and editors edit the trip. Returns the whole trip.',
    history: new HistoryBuilder().added('v1').beta('v1'),
  })
  removeAssetPoint(@Auth() auth: AuthDto, @Param() { id, assetId }: UUIDAssetIDParamDto): Promise<TripResponseDto> {
    return this.service.setAssetPoint(auth, id, assetId, null);
  }

  @Get(':id/geo/search')
  @Authenticated({ permission: Permission.AlbumUpdate })
  @Endpoint({
    summary: 'Search places for a trip',
    description:
      'Finds up to five places by address or name through Nominatim, named in the trip’s language, for picking a point. Responds 502 when the search does not answer. The album owner and editors only.',
    history: new HistoryBuilder().added('v1').beta('v1'),
  })
  searchTripPlaces(
    @Auth() auth: AuthDto,
    @Param() { id }: UUIDParamDto,
    @Query() dto: TripGeoSearchDto,
  ): Promise<TripGeoPlacesDto> {
    return this.service.searchPlaces(auth, id, dto);
  }

  @Get(':id/geo/reverse')
  @Authenticated({ permission: Permission.AlbumUpdate })
  @Endpoint({
    summary: 'Name a point for a trip',
    description:
      'Names a point on the map through Nominatim in the trip’s language: one place, or none where Nominatim knows none. Responds 502 when the service does not answer. The album owner and editors only.',
    history: new HistoryBuilder().added('v1').beta('v1'),
  })
  reverseTripPlace(
    @Auth() auth: AuthDto,
    @Param() { id }: UUIDParamDto,
    @Query() dto: TripGeoReverseQueryDto,
  ): Promise<TripGeoPlacesDto> {
    return this.service.reversePlace(auth, id, dto);
  }

  @Get(':id/place-hints')
  @Authenticated({ permission: Permission.AlbumUpdate })
  @Endpoint({
    summary: 'Get place hints for a trip',
    description:
      'Offers each Unplaced asset of a Places trip the place of the asset most like it by CLIP among those with their own GPS or a point set by hand, and the centre to those like none of them when the trip has a centre. Nothing is moved. Other kinds get no hints. The album owner and editors only.',
    history: new HistoryBuilder().added('v1').beta('v1'),
  })
  getTripPlaceHints(@Auth() auth: AuthDto, @Param() { id }: UUIDParamDto): Promise<TripPlaceHintsDto> {
    return this.service.getPlaceHints(auth, id);
  }

  @Put(':id/legs/:legId/mode')
  @Authenticated({ permission: Permission.AlbumUpdate })
  @Endpoint({
    summary: 'Set a trip leg mode',
    description:
      'Sets how a leg was travelled; the mode is kept from then on. A null mode gives the leg back to the default by distance. The leg is routed again, and a train leg forgets its stations. The album owner and editors edit the trip; a viewer gets 403. Returns the whole trip.',
    history: new HistoryBuilder().added('v1').beta('v1'),
  })
  setLegMode(
    @Auth() auth: AuthDto,
    @Param() { id, legId }: TripLegParamDto,
    @Body() dto: TripLegModeUpdateDto,
  ): Promise<TripResponseDto> {
    return this.service.setLegMode(auth, id, legId, dto);
  }

  @Get(':id/legs/:legId/stations')
  @Authenticated({ permission: Permission.AlbumUpdate })
  @Endpoint({
    summary: 'List stations of a trip leg',
    description:
      'Lists up to five railway stations within 3 km of each end of a leg, nearest first, from OpenStreetMap. Responds 502 when the station search does not answer. The album owner and editors only.',
    history: new HistoryBuilder().added('v1').beta('v1'),
  })
  getLegStations(@Auth() auth: AuthDto, @Param() { id, legId }: TripLegParamDto): Promise<TripLegStationsDto> {
    return this.service.getLegStations(auth, id, legId);
  }

  @Put(':id/legs/:legId/station')
  @Authenticated({ permission: Permission.AlbumUpdate })
  @Endpoint({
    summary: 'Set a trip leg station',
    description:
      'Picks the departure or arrival station of a train leg among those the station list offers at that end; the leg is routed again. The album owner and editors edit the trip. Returns the whole trip.',
    history: new HistoryBuilder().added('v1').beta('v1'),
  })
  setLegStation(
    @Auth() auth: AuthDto,
    @Param() { id, legId }: TripLegParamDto,
    @Body() dto: TripLegStationUpdateDto,
  ): Promise<TripResponseDto> {
    return this.service.setLegStation(auth, id, legId, dto);
  }

  @Post(':id/legs/:legId/retry')
  @Authenticated({ permission: Permission.AlbumUpdate })
  @Endpoint({
    summary: 'Retry a trip leg',
    description:
      'Routes a leg that needs attention again, with its mode unchanged. The album owner and editors edit the trip. Returns the whole trip.',
    history: new HistoryBuilder().added('v1').beta('v1'),
  })
  retryLeg(@Auth() auth: AuthDto, @Param() { id, legId }: TripLegParamDto): Promise<TripResponseDto> {
    return this.service.retryLeg(auth, id, legId);
  }

  @Post(':id/legs/retry')
  @Authenticated({ permission: Permission.AlbumUpdate })
  @Endpoint({
    summary: 'Retry trip legs',
    description:
      'Routes every leg of the trip that needs attention again. The album owner and editors edit the trip. Returns the whole trip.',
    history: new HistoryBuilder().added('v1').beta('v1'),
  })
  retryLegs(@Auth() auth: AuthDto, @Param() { id }: UUIDParamDto): Promise<TripResponseDto> {
    return this.service.retryLegs(auth, id);
  }
}
