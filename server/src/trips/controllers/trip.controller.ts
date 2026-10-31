import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import { Endpoint, HistoryBuilder } from 'src/decorators.js';
import { Permission } from 'src/enum.js';
import { Auth, Authenticated } from 'src/middleware/auth.guard.js';
import { TripImportDto, TripResponseDto } from 'src/trips/dtos/trip.dto.js';
import { TripService } from 'src/trips/services/trip.service.js';
import { UUIDParamDto } from 'src/validation.js';

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
  getTrip(@Auth() auth: AuthDto, @Param() { id }: UUIDParamDto): Promise<TripResponseDto> {
    return this.service.get(auth, id);
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
}
