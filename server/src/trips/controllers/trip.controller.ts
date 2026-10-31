import { Body, Controller, Delete, Get, Param, Patch, Post, Put, Req, Res } from '@nestjs/common';
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
  TripCreateDto,
  TripImportDto,
  TripLikeDto,
  TripResponseDto,
  TripStopParamDto,
  TripStopUpdateDto,
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
      'Sets a stop’s title, story or place. The album owner and editors edit the trip; a viewer gets 403. A blank text is cleared. The place must belong to the same trip. Returns the whole trip.',
    history: new HistoryBuilder().added('v1').beta('v1'),
  })
  updateStop(
    @Auth() auth: AuthDto,
    @Param() { id, stopId }: TripStopParamDto,
    @Body() dto: TripStopUpdateDto,
  ): Promise<TripResponseDto> {
    return this.service.updateStop(auth, id, stopId, dto);
  }
}
