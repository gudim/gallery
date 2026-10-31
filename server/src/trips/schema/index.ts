import { TripAssetTable } from 'src/trips/schema/tables/trip-asset.table.js';
import { TripLegTable } from 'src/trips/schema/tables/trip-leg.table.js';
import { TripLikeTable } from 'src/trips/schema/tables/trip-like.table.js';
import { TripOverlayTable } from 'src/trips/schema/tables/trip-overlay.table.js';
import { TripPlaceTable } from 'src/trips/schema/tables/trip-place.table.js';
import { TripStopTable } from 'src/trips/schema/tables/trip-stop.table.js';
import { TripTable } from 'src/trips/schema/tables/trip.table.js';

// Trip tables, spread into ImmichDatabase.tables after Gallery's and merged into DB by src/schema/index.ts.
export const tripTables = [
  TripTable,
  TripPlaceTable,
  TripStopTable,
  TripAssetTable,
  TripLegTable,
  TripOverlayTable,
  TripLikeTable,
];

export interface TripsDB {
  trip: TripTable;
  trip_place: TripPlaceTable;
  trip_stop: TripStopTable;
  trip_asset: TripAssetTable;
  trip_leg: TripLegTable;
  trip_overlay: TripOverlayTable;
  trip_like: TripLikeTable;
}
