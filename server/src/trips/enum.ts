// The values the trip tables' check constraints allow (trips PLAN §2.1, GLOSSARY.md).
export enum TripKind {
  Route = 'route',
  Places = 'places',
  Plain = 'plain',
}

export enum TripStopRole {
  Start = 'start',
  Finish = 'finish',
}

export enum TripPointSource {
  Inferred = 'inferred',
  Manual = 'manual',
}

export enum TripLegMode {
  Foot = 'foot',
  Driving = 'driving',
  Trail = 'trail',
  Direct = 'direct',
  Flight = 'flight',
  Bicycle = 'bicycle',
  Bus = 'bus',
  Train = 'train',
  Boat = 'boat',
}

export enum TripLegStatus {
  Pending = 'pending',
  Ok = 'ok',
  Attention = 'attention',
}

// The two stations of a train leg.
export enum TripStationSide {
  Departure = 'departure',
  Arrival = 'arrival',
}

export enum TripOverlayKind {
  Trail = 'trail',
  Mask = 'mask',
}

// The public services routing and naming call (trips DECISIONS-LOG 2026-10-31), as trip_geo_cache.service names them.
export enum TripGeoService {
  Valhalla = 'valhalla',
  BRouter = 'brouter',
  Overpass = 'overpass',
  Nominatim = 'nominatim',
}
