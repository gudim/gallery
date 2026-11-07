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
}
