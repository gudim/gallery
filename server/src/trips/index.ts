import { TripTextsController } from 'src/trips/controllers/trip-texts.controller.js';
import { TripController } from 'src/trips/controllers/trip.controller.js';
import { TripEditorRepository } from 'src/trips/repositories/trip-editor.repository.js';
import { TripFavoritesRepository } from 'src/trips/repositories/trip-favorites.repository.js';
import { TripFilingRepository } from 'src/trips/repositories/trip-filing.repository.js';
import { TripGeoRepository } from 'src/trips/repositories/trip-geo.repository.js';
import { TripNameRepository } from 'src/trips/repositories/trip-name.repository.js';
import { TripRouteRepository } from 'src/trips/repositories/trip-route.repository.js';
import { TripTextsRepository } from 'src/trips/repositories/trip-texts.repository.js';
import { TripRepository } from 'src/trips/repositories/trip.repository.js';
import { TripFavoritesService } from 'src/trips/services/trip-favorites.service.js';
import { TripNameService } from 'src/trips/services/trip-name.service.js';
import { TripTextsService } from 'src/trips/services/trip-texts.service.js';
import { TripService } from 'src/trips/services/trip.service.js';

// Register every trip controller, repository and service here (trips PLAN §2.0). Each array is spread once into the
// matching upstream array, after Gallery's, in src/{controllers,repositories,services}/index.ts.
export const tripControllers = [TripController, TripTextsController];
export const tripRepositories = [
  TripRepository,
  TripFilingRepository,
  TripRouteRepository,
  TripNameRepository,
  TripGeoRepository,
  TripEditorRepository,
  TripFavoritesRepository,
  TripTextsRepository,
];
export const tripServices = [TripService, TripNameService, TripFavoritesService, TripTextsService];
