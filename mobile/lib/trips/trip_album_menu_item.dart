import 'dart:async';

import 'package:auto_route/auto_route.dart';
import 'package:flutter/material.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:immich_mobile/domain/models/album/album.model.dart';
import 'package:immich_mobile/generated/translations.g.dart';
import 'package:immich_mobile/presentation/widgets/action_buttons/base_action_button.widget.dart';
import 'package:immich_mobile/routing/router.dart';
import 'package:immich_mobile/trips/trip.provider.dart';
import 'package:immich_mobile/trips/trip_create_dialog.dart';

/// The album menu's way into the trip (trips PLAN §2.9): "Open the trip" when the album has one; "Make a trip" for the
/// owner of an album with assets and no trip (web TripMapButton.svelte); nothing while it is unknown.
class TripAlbumMenuItem extends ConsumerWidget {
  final RemoteAlbum album;
  final bool isOwner;

  const TripAlbumMenuItem({super.key, required this.album, required this.isOwner});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final hasTrip = ref.watch(tripExistsProvider(album.id)).valueOrNull;
    if (hasTrip == true) {
      return BaseActionButton(
        key: const ValueKey('trip-open'),
        label: context.t.trips_open_trip,
        iconData: Icons.route,
        menuItem: true,
        onPressed: () => unawaited(_open(context)),
      );
    }
    if (hasTrip == false && isOwner && album.assetCount > 0) {
      return BaseActionButton(
        key: const ValueKey('trip-create'),
        label: context.t.trips_create_title,
        iconData: Icons.add_road,
        menuItem: true,
        onPressed: () => unawaited(_create(context)),
      );
    }
    return const SizedBox.shrink();
  }

  Future<void> _open(BuildContext context) => context.pushRoute(TripRoute(albumId: album.id, title: album.name));

  Future<void> _create(BuildContext context) async {
    // The menu closes and unmounts this item while the dialog is open, so take what is needed afterwards now.
    final router = context.router;
    final container = ProviderScope.containerOf(context, listen: false);
    if (!await showTripCreateDialog(context, albumId: album.id)) {
      return;
    }
    container.invalidate(tripExistsProvider(album.id));
    container.invalidate(tripDataProvider(album.id));
    await router.push(TripRoute(albumId: album.id, title: album.name));
  }
}
