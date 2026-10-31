import { TripController } from 'src/trips/controllers/trip.controller.js';
import { TripEditorRepository } from 'src/trips/repositories/trip-editor.repository.js';
import { TripFavoritesRepository } from 'src/trips/repositories/trip-favorites.repository.js';
import { TripGeoRepository } from 'src/trips/repositories/trip-geo.repository.js';
import { TripRepository } from 'src/trips/repositories/trip.repository.js';
import { TripFavoritesService } from 'src/trips/services/trip-favorites.service.js';
import { TripNameService } from 'src/trips/services/trip-name.service.js';
import { TripService } from 'src/trips/services/trip.service.js';

// Register every trip controller, repository and service here (trips PLAN §2.0). Each array is spread once into the
// matching upstream array, after Gallery's, in src/{controllers,repositories,services}/index.ts.
export const tripControllers = [TripController];
export const tripRepositories = [TripRepository, TripGeoRepository, TripEditorRepository, TripFavoritesRepository];
export const tripServices = [TripService, TripNameService, TripFavoritesService];
