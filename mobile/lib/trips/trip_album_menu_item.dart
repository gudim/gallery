import 'dart:async';

import 'package:auto_route/auto_route.dart';
import 'package:flutter/material.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:immich_mobile/domain/models/album/album.model.dart';
import 'package:immich_mobile/generated/translations.g.dart';
import 'package:immich_mobile/presentation/widgets/action_buttons/base_action_button.widget.dart';
import 'package:immich_mobile/routing/router.dart';
import 'package:immich_mobile/trips/trip.provider.dart';

/// The album menu's way into the trip (trips PLAN §2.9): "Open the trip" when the album has one, nothing otherwise.
class TripAlbumMenuItem extends ConsumerWidget {
  final RemoteAlbum album;

  const TripAlbumMenuItem({super.key, required this.album});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final hasTrip = ref.watch(tripExistsProvider(album.id)).valueOrNull ?? false;
    if (!hasTrip) {
      return const SizedBox.shrink();
    }
    return BaseActionButton(
      key: const ValueKey('trip-open'),
      label: context.t.trips_open_trip,
      iconData: Icons.route,
      menuItem: true,
      onPressed: () => unawaited(context.pushRoute(TripRoute(albumId: album.id, title: album.name))),
    );
  }
}
