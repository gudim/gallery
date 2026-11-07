import 'dart:async';

import 'package:auto_route/auto_route.dart';
import 'package:flutter/material.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:immich_mobile/domain/services/timeline.service.dart';
import 'package:immich_mobile/generated/translations.g.dart';
import 'package:immich_mobile/presentation/widgets/asset_viewer/asset_viewer.page.dart';
import 'package:immich_mobile/providers/asset_viewer/asset_viewer.provider.dart';
import 'package:immich_mobile/providers/infrastructure/current_album.provider.dart';
import 'package:immich_mobile/providers/infrastructure/timeline.provider.dart';
import 'package:immich_mobile/trips/trip.provider.dart';

/// Gallery's asset viewer over a trip's assets, with the trip's like button (web TripPage's `trip-like`).
@RoutePage()
class TripAssetViewerPage extends StatelessWidget {
  final String albumId;
  final int initialIndex;
  final TimelineService timelineService;

  const TripAssetViewerPage({
    super.key,
    required this.albumId,
    required this.initialIndex,
    required this.timelineService,
  });

  @override
  Widget build(BuildContext context) {
    return ProviderScope(
      overrides: [
        timelineServiceProvider.overrideWithValue(timelineService),
        currentRemoteAlbumScopedProvider.overrideWithValue(null),
      ],
      child: Stack(
        children: [
          AssetViewer(initialIndex: initialIndex),
          _TripLikeButton(albumId: albumId),
        ],
      ),
    );
  }
}

class _TripLikeButton extends ConsumerWidget {
  final String albumId;

  const _TripLikeButton({required this.albumId});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final assetId = ref.watch(assetViewerProvider.select((state) => state.currentAsset?.remoteId));
    final isShown = ref.watch(
      assetViewerProvider.select((state) => state.showingControls && !state.showingDetails && !state.isZoomed),
    );
    final like = assetId == null ? null : ref.watch(tripLikesProvider(albumId).select((likes) => likes[assetId]));
    if (assetId == null || like == null || !isShown) {
      return const SizedBox.shrink();
    }
    return Positioned(
      right: 12,
      bottom: MediaQuery.paddingOf(context).bottom + 120,
      child: Material(
        color: Colors.black54,
        shape: const StadiumBorder(),
        child: InkWell(
          customBorder: const StadiumBorder(),
          onTap: like.isBusy ? null : () => unawaited(ref.read(tripLikesProvider(albumId).notifier).toggle(assetId)),
          child: Semantics(
            button: true,
            toggled: like.isLiked,
            label: like.isLiked ? context.t.trips_unlike : context.t.trips_like,
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 8),
              child: Row(
                mainAxisSize: MainAxisSize.min,
                children: [
                  Icon(like.isLiked ? Icons.favorite : Icons.favorite_border, color: Colors.white, size: 20),
                  const SizedBox(width: 6),
                  Text('${like.count}', style: const TextStyle(color: Colors.white)),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}
