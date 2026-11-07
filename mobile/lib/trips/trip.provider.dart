import 'dart:async';

import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:immich_mobile/domain/models/asset/base_asset.model.dart';
import 'package:immich_mobile/extensions/asset_extensions.dart';
import 'package:immich_mobile/trips/trip_view.dart';
import 'package:immich_mobile/trips/trips_api.repository.dart';
import 'package:openapi/api.dart';

/// One edit of a trip: it acts on the album's trip and answers with the whole trip.
typedef TripEdit = Future<TripResponseDto> Function(TripsApiRepository repository, String albumId);

/// A trip as the screen shows it: the read, its derived view, and the album's assets for the viewer.
class TripData {
  final TripResponseDto trip;
  final TripView view;
  final Map<String, RemoteAsset> assets;

  /// An edit is on its way to the server.
  final bool isBusy;

  const TripData({required this.trip, required this.view, required this.assets, this.isBusy = false});

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
///
/// It is also the editor's state (web trip-editor.svelte.ts): every edit answers with the whole trip, which replaces
/// the view. While the server still names stops or routes legs, the trip is read again every few seconds and shown anew
/// when its content changed; the assets are not read again.
class TripDataNotifier extends AutoDisposeFamilyAsyncNotifier<TripData?, String> {
  static const pollInterval = Duration(seconds: 4);

  /// Reads after a clock shift, while the assets' metadata is read again: about two minutes (web FOLLOW_POLLS).
  static const followPolls = 30;

  Timer? _timer;
  int _followPolls = 0;

  /// The assets' dates moved since they were read, so the next changed trip reads them again.
  bool _isAssetsStale = false;
  bool _isDisposed = false;
  List<TripAssetInfo> _infos = const [];
  Map<String, RemoteAsset> _assets = const {};

  @override
  Future<TripData?> build(String albumId) async {
    ref.onDispose(() {
      _isDisposed = true;
      _timer?.cancel();
    });
    final repository = ref.watch(tripsApiRepositoryProvider);
    final trip = await repository.getTrip(albumId);
    if (trip == null) {
      return null;
    }
    await _readAssets(repository);
    _schedule(trip);
    return _show(trip);
  }

  Future<void> _readAssets(TripsApiRepository repository) async {
    final assets = await repository.getAlbumAssets(arg);
    _infos = assets.map(tripAssetInfo).toList();
    _assets = {for (final asset in assets) asset.id: asset.toDto()};
  }

  /// Reads the trip again for a while after a change it learns of later, such as the dates a clock shift moved; the
  /// assets are read again with the first trip that changed.
  void follow() {
    _followPolls = followPolls;
    _isAssetsStale = true;
    final trip = state.valueOrNull?.trip;
    if (trip != null) {
      _schedule(trip);
    }
  }

  TripData _show(TripResponseDto trip, {bool isBusy = false}) =>
      TripData(trip: trip, view: buildTripView(trip, _infos), assets: _assets, isBusy: isBusy);

  bool get _isBusy => state.valueOrNull?.isBusy ?? false;

  /// Runs one edit; on success the trip it answers replaces the view. Returns whether the edit went through; the caller
  /// tells the user when it did not.
  Future<bool> run(TripEdit edit) async {
    final shown = state.valueOrNull;
    if (shown == null) {
      return false;
    }
    state = AsyncData(TripData(trip: shown.trip, view: shown.view, assets: shown.assets, isBusy: true));
    try {
      final trip = await edit(ref.read(tripsApiRepositoryProvider), arg);
      if (!_isDisposed) {
        state = AsyncData(_show(trip));
        _schedule(trip);
      }
      return true;
    } catch (_) {
      if (!_isDisposed) {
        final current = state.valueOrNull ?? shown;
        state = AsyncData(_show(current.trip));
      }
      return false;
    }
  }

  void _schedule(TripResponseDto trip) {
    _timer?.cancel();
    final isRouting = trip.legs.any((leg) => leg.status == TripLegStatus.pending);
    if (isRouting || trip.isNaming || _followPolls > 0) {
      _timer = Timer(pollInterval, () => unawaited(_poll(trip)));
    }
  }

  Future<void> _poll(TripResponseDto polled) async {
    var next = polled;
    _followPolls = _followPolls > 0 ? _followPolls - 1 : 0;
    try {
      final repository = ref.read(tripsApiRepositoryProvider);
      final trip = await repository.getTrip(arg);
      if (_isDisposed) {
        return;
      }
      // An edit that answered meanwhile is newer than this read, and one still running will answer newer.
      final shown = state.valueOrNull?.trip ?? polled;
      next = shown;
      if (trip != null && !_isBusy) {
        if (trip.contentVersion != shown.contentVersion) {
          if (_isAssetsStale) {
            await _readAssets(repository);
            _isAssetsStale = false;
            if (_isDisposed) {
              return;
            }
            // An edit started meanwhile answers with a newer trip, shown with these assets.
            if (_isBusy) {
              _schedule(trip);
              return;
            }
          }
          state = AsyncData(_show(trip));
        }
        next = trip;
      }
    } catch (_) {
      // A failed read waits for the next one.
    }
    if (!_isDisposed) {
      _schedule(next);
    }
  }
}

/// How the album's Places trip lists its places; kept while the trip is open, across edit mode and layouts.
final tripPlaceSortProvider = StateProvider.autoDispose.family<TripPlaceSort, String>(
  (ref, albumId) => TripPlaceSort.frames,
);

final tripDataProvider = AsyncNotifierProvider.autoDispose.family<TripDataNotifier, TripData?, String>(
  TripDataNotifier.new,
);

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
