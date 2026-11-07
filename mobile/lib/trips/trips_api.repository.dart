import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:immich_mobile/providers/api.provider.dart';
import 'package:immich_mobile/repositories/api.repository.dart';
import 'package:immich_mobile/services/api.service.dart';
import 'package:openapi/api.dart';

final tripsApiRepositoryProvider = Provider((ref) => TripsApiRepository(ref.watch(apiServiceProvider)));

/// Trip data is read from the server and kept nowhere on the phone (trips PLAN §2.9).
class TripsApiRepository extends ApiRepository {
  static const _pageSize = 1000;

  final ApiService _apiService;

  TripsApiRepository(this._apiService);

  // Built on each call from the client every generated Api shares, so `ApiService` needs no trip field and a
  // `setEndpoint` that swaps the client is followed.
  TripsApi get _api => TripsApi(_apiService.albumsApi.apiClient);

  /// The album's trip, or null when the album has none (404, as for an album the caller cannot see).
  Future<TripResponseDto?> getTrip(String albumId) async {
    try {
      return await checkNull(_api.getTrip(albumId));
    } on ApiException catch (error) {
      if (error.code == 404) {
        return null;
      }
      rethrow;
    }
  }

  /// Makes a trip of the album; the server lays it out and names its stops in `language` (web TripCreateModal).
  Future<void> createTrip(String albumId, TripKind kind, String? language) =>
      checkNull(_api.createTrip(TripCreateDto(albumId: albumId, kind: kind, language: Optional.present(language))));

  /// Every asset of the album the caller may see, with exif, oldest first (web trip-data.ts loadAlbumAssets).
  Future<List<AssetResponseDto>> getAlbumAssets(String albumId) async {
    final assets = <AssetResponseDto>[];
    for (int? page = 1; page != null;) {
      final response = await checkNull(
        _apiService.searchApi.searchAssets(
          MetadataSearchDto(
            albumIds: Optional.present([albumId]),
            withExif: const Optional.present(true),
            size: const Optional.present(_pageSize),
            page: Optional.present(page),
            order: const Optional.present(AssetOrder.asc),
          ),
        ),
      );
      assets.addAll(response.assets.items);
      page = int.tryParse(response.assets.nextPage ?? '');
    }
    return assets;
  }

  Future<TripLikeDto> like(String albumId, String assetId) => checkNull(_api.likeAsset(assetId, albumId));

  Future<TripLikeDto> unlike(String albumId, String assetId) => checkNull(_api.unlikeAsset(assetId, albumId));

  // Edits (trips PLAN §2.5): each answers with the whole trip.

  Future<TripResponseDto> updateStop(String albumId, String stopId, TripStopUpdateDto change) =>
      checkNull(_api.updateStop(albumId, stopId, change));

  Future<TripResponseDto> deleteStop(String albumId, String stopId) => checkNull(_api.deleteStop(albumId, stopId));

  Future<TripResponseDto> mergeNextStop(String albumId, String stopId) =>
      checkNull(_api.mergeNextStop(albumId, stopId));

  /// Moves a point added by hand right after `afterStopId`, or right after the start when null.
  Future<TripResponseDto> movePoint(String albumId, String stopId, String? afterStopId) =>
      checkNull(_api.movePoint(albumId, stopId, TripPointOrderDto(afterStopId: afterStopId)));

  Future<TripResponseDto> setTransit(String albumId, List<String> stopIds, bool isTransit) =>
      checkNull(_api.setTransit(albumId, TripTransitUpdateDto(stopIds: stopIds, isTransit: isTransit)));

  Future<TripResponseDto> setFinishAtStart(String albumId) =>
      checkNull(_api.setFinish(albumId, TripFinishUpdateDto(isFinishAtStart: const Optional.present(true))));

  Future<TripResponseDto> removeStart(String albumId) => checkNull(_api.removeStart(albumId));

  Future<TripResponseDto> removeFinish(String albumId) => checkNull(_api.removeFinish(albumId));

  /// Moves a stop's pin; the stop keeps the point by hand until it is pinned back to its assets.
  Future<TripResponseDto> moveStop(String albumId, String stopId, double latitude, double longitude) => checkNull(
    _api.updateStop(
      albumId,
      stopId,
      TripStopUpdateDto(latitude: Optional.present(latitude), longitude: Optional.present(longitude)),
    ),
  );

  /// Sets the route's start; an empty title is left to naming.
  Future<TripResponseDto> setStart(String albumId, TripPoint point) => checkNull(
    _api.setStart(
      albumId,
      TripEndDto(latitude: point.latitude, longitude: point.longitude, title: Optional.present(point.titleOrNull)),
    ),
  );

  Future<TripResponseDto> setFinish(String albumId, TripPoint point) => checkNull(
    _api.setFinish(
      albumId,
      TripFinishUpdateDto(
        latitude: Optional.present(point.latitude),
        longitude: Optional.present(point.longitude),
        title: Optional.present(point.titleOrNull),
      ),
    ),
  );

  /// Adds a point by hand right after `afterStopId`, or right after the start when null.
  Future<TripResponseDto> addPoint(String albumId, TripPoint point, String? afterStopId) => checkNull(
    _api.addPoint(
      albumId,
      TripPointCreateDto(
        latitude: point.latitude,
        longitude: point.longitude,
        title: Optional.present(point.titleOrNull),
        afterStopId: Optional.present(afterStopId),
      ),
    ),
  );

  // Asset edits (web TripAssetActions.svelte).

  Future<TripResponseDto> moveAssets(String albumId, List<String> assetIds, String stopId) =>
      checkNull(_api.moveAssets(albumId, TripAssetsMoveDto(assetIds: assetIds, stopId: stopId)));

  /// Makes a new stop of the assets.
  Future<TripResponseDto> createStop(String albumId, List<String> assetIds) =>
      checkNull(_api.createStop(albumId, TripStopCreateDto(assetIds: assetIds)));

  /// Splits the stop so that a new stop begins with the asset.
  Future<TripResponseDto> splitStop(String albumId, String stopId, String assetId) =>
      checkNull(_api.splitStop(albumId, stopId, TripStopSplitDto(assetId: assetId)));

  /// Files assets of a Places trip to its centre; `center` makes the centre when the trip has none.
  Future<TripResponseDto> toCenter(String albumId, List<String> assetIds, TripPoint? center) => checkNull(
    _api.toCenter(
      albumId,
      TripAssetsCenterDto(
        assetIds: assetIds,
        center: center == null
            ? const Optional.absent()
            : Optional.present(
                TripEndDto(
                  latitude: center.latitude,
                  longitude: center.longitude,
                  title: Optional.present(center.titleOrNull),
                ),
              ),
      ),
    ),
  );

  /// Sets an asset's point by hand.
  Future<TripResponseDto> setAssetPoint(String albumId, String assetId, TripPoint point) => checkNull(
    _api.setAssetPoint(assetId, albumId, TripAssetPointDto(latitude: point.latitude, longitude: point.longitude)),
  );

  /// Gives an asset back the point of its own location.
  Future<TripResponseDto> removeAssetPoint(String albumId, String assetId) =>
      checkNull(_api.removeAssetPoint(assetId, albumId));

  /// Hides assets from the trip: they leave the album (trips PLAN D11). Answers the trip read again and how many left.
  Future<({TripResponseDto trip, int count})> hideAssets(String albumId, List<String> assetIds) async {
    final results = await checkNull(_apiService.albumsApi.removeAssetFromAlbum(albumId, BulkIdsDto(ids: assetIds)));
    final trip = await checkNull(_api.getTrip(albumId));
    return (trip: trip, count: results.where((result) => result.success).length);
  }

  // Leg edits (web TripLegEdit.svelte).

  /// Sets the leg's mode by hand; null returns it to the mode its distance gives.
  Future<TripResponseDto> setLegMode(String albumId, String legId, TripLegMode? mode) =>
      checkNull(_api.setLegMode(albumId, legId, TripLegModeUpdateDto(mode: mode)));

  /// Railway stations near both ends of a train leg, nearest first.
  Future<TripLegStationsDto> getLegStations(String albumId, String legId) =>
      checkNull(_api.getLegStations(albumId, legId));

  Future<TripResponseDto> setLegStation(String albumId, String legId, TripStationSide side, TripStationDto station) =>
      checkNull(
        _api.setLegStation(
          albumId,
          legId,
          TripLegStationUpdateDto(
            side: side,
            latitude: station.latitude,
            longitude: station.longitude,
            name: station.name,
          ),
        ),
      );

  Future<TripResponseDto> retryLeg(String albumId, String legId) => checkNull(_api.retryLeg(albumId, legId));

  /// Routes again every leg that could not be routed.
  Future<TripResponseDto> retryLegs(String albumId) => checkNull(_api.retryLegs(albumId));

  /// The album's cameras, with a suggested clock shift for those without GPS (trips PLAN D9).
  Future<List<TripCameraDto>> getCameras(String albumId) async =>
      (await checkNull(_api.getTripCameras(albumId))).cameras;

  /// Shifts the dates of the caller's own assets by whole minutes, through Immich's bulk asset update.
  Future<void> shiftDates(List<String> assetIds, int minutes) => _apiService.assetsApi.updateAssets(
    AssetBulkUpdateDto(ids: assetIds, dateTimeRelative: Optional.present(minutes)),
  );

  /// Places offered to the Unplaced assets of a Places trip.
  Future<TripPlaceHintsDto> getPlaceHints(String albumId) => checkNull(_api.getTripPlaceHints(albumId));

  /// Places Nominatim finds for `query`, in the trip's language.
  Future<List<TripGeoPlaceDto>> searchPlaces(String albumId, String query) async =>
      (await checkNull(_api.searchTripPlaces(albumId, query))).places;

  /// The place at a point, in the trip's language.
  Future<List<TripGeoPlaceDto>> reversePlace(String albumId, double latitude, double longitude) async =>
      (await checkNull(_api.reverseTripPlace(albumId, latitude, longitude))).places;
}

/// A point picked for a trip: a stop's place, or an asset's point by hand (web TripPointModal `TripPoint`).
class TripPoint {
  final double latitude;
  final double longitude;
  final String title;

  const TripPoint({required this.latitude, required this.longitude, this.title = ''});

  String? get titleOrNull => title.isEmpty ? null : title;
}
