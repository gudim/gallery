import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:immich_mobile/domain/models/asset/base_asset.model.dart';
import 'package:immich_mobile/extensions/asset_extensions.dart';
import 'package:immich_mobile/trips/trip_view.dart';
import 'package:immich_mobile/trips/trips_api.repository.dart';
import 'package:openapi/api.dart';

/// A trip as the screen shows it: the read, its derived view, and the album's assets for the viewer.
class TripData {
  final TripResponseDto trip;
  final TripView view;
  final Map<String, RemoteAsset> assets;

  const TripData({required this.trip, required this.view, required this.assets});

  /// The viewer's assets for `photos`, in their order.
  List<RemoteAsset> assetsOf(List<TripPhoto> photos) => [for (final photo in photos) ?assets[photo.id]];
}

TripAssetInfo tripAssetInfo(AssetResponseDto asset) {
  final exif = asset.exifInfo.orElse(null);
  return TripAssetInfo(
    id: asset.id,
    localDateTime: asset.localDateTime,
    isVideo: asset.type == AssetTypeEnum.VIDEO,
    latitude: exif?.latitude.orElse(null),
    longitude: exif?.longitude.orElse(null),
  );
}

/// Whether the album has a trip, for the album page's menu. Null while unknown or on failure: the item stays hidden.
final tripExistsProvider = FutureProvider.autoDispose.family<bool, String>((ref, albumId) async {
  return await ref.watch(tripsApiRepositoryProvider).getTrip(albumId) != null;
});

/// The album's trip, or null when it has none. Only a trip album pays for loading every asset (web trip-data.ts).
final tripDataProvider = FutureProvider.autoDispose.family<TripData?, String>((ref, albumId) async {
  final repository = ref.watch(tripsApiRepositoryProvider);
  final trip = await repository.getTrip(albumId);
  if (trip == null) {
    return null;
  }
  final assets = await repository.getAlbumAssets(albumId);
  return TripData(
    trip: trip,
    view: buildTripView(trip, assets.map(tripAssetInfo).toList()),
    assets: {for (final asset in assets) asset.id: asset.toDto()},
  );
});

class TripLike {
  final int count;
  final bool isLiked;
  final bool isBusy;

  const TripLike({this.count = 0, this.isLiked = false, this.isBusy = false});
}

/// Likes of a trip's assets (web trip-likes.svelte.ts): a toggle answers at once and takes the server's numbers when
/// they come, or goes back when the request fails.
class TripLikesNotifier extends AutoDisposeFamilyNotifier<Map<String, TripLike>, String> {
  @override
  Map<String, TripLike> build(String albumId) {
    final view = ref.watch(tripDataProvider(albumId)).valueOrNull?.view;
    return {
      for (final photo in view?.photos ?? const <TripPhoto>[])
        photo.id: TripLike(count: photo.likes, isLiked: photo.isLiked),
    };
  }

  Future<void> toggle(String assetId) async {
    final before = state[assetId] ?? const TripLike();
    if (before.isBusy) {
      return;
    }
    final isLiked = !before.isLiked;
    _set(
      assetId,
      TripLike(count: (before.count + (isLiked ? 1 : -1)).clamp(0, 1 << 31), isLiked: isLiked, isBusy: true),
    );
    try {
      final repository = ref.read(tripsApiRepositoryProvider);
      final result = await (isLiked ? repository.like(arg, assetId) : repository.unlike(arg, assetId));
      _set(assetId, TripLike(count: result.count, isLiked: result.isLiked));
    } catch (_) {
      _set(assetId, TripLike(count: before.count, isLiked: before.isLiked));
    }
  }

  void _set(String assetId, TripLike like) => state = {...state, assetId: like};
}

final tripLikesProvider = NotifierProvider.autoDispose.family<TripLikesNotifier, Map<String, TripLike>, String>(
  TripLikesNotifier.new,
);
