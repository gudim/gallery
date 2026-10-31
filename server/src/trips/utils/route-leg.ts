import type {
  BRouterProfile,
  RoutedLine,
  Station,
  StationCandidate,
  ValhallaCosting,
} from 'src/trips/utils/routing.js';
import { TripLegMode, TripLegStatus } from 'src/trips/enum.js';
import { TripGeoError } from 'src/trips/repositories/trip-geo.repository.js';
import {
  BOAT_BEND,
  FLIGHT_BEND,
  FOOT_MAX_M,
  type LatLng,
  arc,
  defaultMode,
  haversineM,
  isPlausible,
} from 'src/trips/utils/geo.js';
import { encodePolyline } from 'src/trips/utils/polyline.js';

// How one leg gets its line (travel-album atlas/geo/valhalla.py `_build`, PLAN §5.11). The services come in through
// `LegRouter`, so the decision is tested without a network.

export type LegRouter = {
  valhalla: (costing: ValhallaCosting, a: LatLng, b: LatLng) => Promise<RoutedLine>;
  brouter: (profile: BRouterProfile, a: LatLng, b: LatLng) => Promise<RoutedLine>;
  stations: (point: LatLng) => Promise<StationCandidate[]>;
};

/** A pending leg as the job reads it: its mode, both stops' points, and a train's stations when it has them. */
export type RoutingLeg = {
  mode: TripLegMode;
  isModeManual: boolean;
  from: LatLng;
  to: LatLng;
  departure: Station | null;
  arrival: Station | null;
};

/** What the job writes. `departure` and `arrival` are the stations a train leg found or kept; absent otherwise. */
export type BuiltLeg = {
  mode: TripLegMode;
  status: TripLegStatus.Ok | TripLegStatus.Attention;
  polyline: string;
  distance: number;
  duration: number | null;
  departure?: Station;
  arrival?: Station;
};

const COSTING = {
  [TripLegMode.Foot]: 'pedestrian',
  [TripLegMode.Driving]: 'auto',
  [TripLegMode.Bicycle]: 'bicycle',
  [TripLegMode.Bus]: 'bus',
} as const satisfies Partial<Record<TripLegMode, ValhallaCosting>>;

/** BRouter's river path counts only when both its ends lie this close to the stops (travel-album `BOAT_SNAP_M`). */
export const BOAT_SNAP_M = 500;

// A service that did not answer, or answered without a route. Anything else is a fault of ours and is thrown on.
const unrouted = async <T>(attempt: () => Promise<T>): Promise<T | null> => {
  try {
    return await attempt();
  } catch (error) {
    if (error instanceof TripGeoError) {
      return null;
    }
    throw error;
  }
};

/**
 * The line of one leg. A leg whose mode the owner did not pick takes the mode its straight length gives. `direct` is
 * a straight line and a flight an arc, both `ok` without a request; a train goes stop → station → rails → station →
 * stop; a boat follows a river BRouter knows, else a gentle arc, `ok` too, since nothing on open water can be fixed;
 * the rest go by Valhalla. Any other failure, or a route too long to believe, leaves a straight line with `attention`.
 */
export const buildLeg = async (leg: RoutingLeg, router: LegRouter, footMaxM = FOOT_MAX_M): Promise<BuiltLeg> => {
  const { from: a, to: b } = leg;
  const straight = haversineM(a, b);
  const mode = leg.isModeManual ? leg.mode : defaultMode(straight, footMaxM);
  const out: BuiltLeg = {
    mode,
    status: TripLegStatus.Attention,
    polyline: encodePolyline([a, b]),
    distance: straight,
    duration: null,
  };

  switch (mode) {
    case TripLegMode.Direct: {
      return { ...out, status: TripLegStatus.Ok };
    }
    case TripLegMode.Flight: {
      return { ...out, status: TripLegStatus.Ok, polyline: encodePolyline(arc(a, b, FLIGHT_BEND)) };
    }
    case TripLegMode.Train: {
      return buildTrain(leg, router, out);
    }
    case TripLegMode.Boat: {
      return buildBoat(a, b, straight, router, out);
    }
    case TripLegMode.Foot:
    case TripLegMode.Driving:
    case TripLegMode.Bicycle:
    case TripLegMode.Bus: {
      return buildRoad(mode, a, b, straight, router, out);
    }
    // A trail is the owner's track from an import; nothing routes it.
    case TripLegMode.Trail: {
      return out;
    }
  }
};

// Valhalla has no bus route where buses do run now and then; such a bus goes along car roads.
const buildRoad = async (
  mode: TripLegMode.Foot | TripLegMode.Driving | TripLegMode.Bicycle | TripLegMode.Bus,
  a: LatLng,
  b: LatLng,
  straight: number,
  router: LegRouter,
  out: BuiltLeg,
): Promise<BuiltLeg> => {
  const route = await unrouted(async () => {
    const found = await unrouted(() => router.valhalla(COSTING[mode], a, b));
    return found ?? (mode === TripLegMode.Bus ? router.valhalla(COSTING[TripLegMode.Driving], a, b) : null);
  });
  if (!route || !isPlausible(route.distance, straight)) {
    return out;
  }
  return {
    ...out,
    status: TripLegStatus.Ok,
    polyline: encodePolyline(route.points),
    distance: route.distance,
    duration: route.duration,
  };
};

// The station the owner picked or the job found before, else the nearest one to the stop.
const stationAt = async (picked: Station | null, point: LatLng, router: LegRouter): Promise<Station | null> => {
  if (picked) {
    return picked;
  }
  const [nearest] = await router.stations(point);
  return nearest ? { name: nearest.name, latitude: nearest.latitude, longitude: nearest.longitude } : null;
};

// Without both stations or without rails the line stays straight with `attention`, and the stations found are still
// written, so the editor shows what was looked for. The first and last pieces of the line are the walks to stations.
const buildTrain = async (leg: RoutingLeg, router: LegRouter, out: BuiltLeg): Promise<BuiltLeg> => {
  const { from: a, to: b } = leg;
  const stations = await unrouted(async () => ({
    departure: await stationAt(leg.departure, a, router),
    arrival: await stationAt(leg.arrival, b, router),
  }));
  if (!stations) {
    return out;
  }
  const { departure, arrival } = stations;
  const found: BuiltLeg = {
    ...out,
    ...(departure && { departure }),
    ...(arrival && { arrival }),
  };
  if (!departure || !arrival) {
    return found;
  }
  const rails = await unrouted(() => router.brouter('rail', departure, arrival));
  if (!rails) {
    return found;
  }
  const walk = haversineM(a, departure) + haversineM(arrival, b);
  return {
    ...found,
    status: TripLegStatus.Ok,
    polyline: encodePolyline([a, departure, ...rails.points, arrival, b]),
    distance: rails.distance + walk,
    duration: rails.duration,
  };
};

// BRouter snaps both ends to the nearest water, which may be another channel a kilometre from the pier; such a path
// is not this leg's, so its ends must lie within BOAT_SNAP_M of the stops.
const buildBoat = async (
  a: LatLng,
  b: LatLng,
  straight: number,
  router: LegRouter,
  out: BuiltLeg,
): Promise<BuiltLeg> => {
  const river = await unrouted(() => router.brouter('river', a, b));
  if (river) {
    const near = Math.max(haversineM(a, river.points[0]), haversineM(b, river.points.at(-1)!));
    if (near <= BOAT_SNAP_M && isPlausible(river.distance, straight)) {
      return {
        ...out,
        status: TripLegStatus.Ok,
        polyline: encodePolyline([a, ...river.points, b]),
        distance: river.distance,
        duration: river.duration,
      };
    }
  }
  return { ...out, status: TripLegStatus.Ok, polyline: encodePolyline(arc(a, b, BOAT_BEND)) };
};
