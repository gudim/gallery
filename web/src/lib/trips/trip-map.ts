import { TripLegMode } from '@immich/sdk';
import { mdiAirplane, mdiBike, mdiBus, mdiCar, mdiFerry, mdiHiking, mdiTrain, mdiVectorLine, mdiWalk } from '@mdi/js';

// What the trip's map and panel share: the leg modes' icons, and which map sources and layers are the trip's.

export const MODE_ICONS: Record<TripLegMode, string> = {
  [TripLegMode.Foot]: mdiWalk,
  [TripLegMode.Driving]: mdiCar,
  [TripLegMode.Trail]: mdiHiking,
  [TripLegMode.Direct]: mdiVectorLine,
  [TripLegMode.Flight]: mdiAirplane,
  [TripLegMode.Bicycle]: mdiBike,
  [TripLegMode.Bus]: mdiBus,
  [TripLegMode.Train]: mdiTrain,
  [TripLegMode.Boat]: mdiFerry,
};

/** Modes whose legs carry a badge on the map; a straight line and a trail are not a way of travelling. */
export const BADGE_MODES = new Set<TripLegMode>([
  TripLegMode.Foot,
  TripLegMode.Driving,
  TripLegMode.Bicycle,
  TripLegMode.Bus,
  TripLegMode.Train,
  TripLegMode.Boat,
  TripLegMode.Flight,
]);

/** The trip's sources and layers, which Gallery's map carries over when the theme switches its style. */
export const isTripMapSource = (id: string | undefined) => !!id?.startsWith('trip-');
