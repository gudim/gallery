import 'dart:async';

import 'package:flutter/material.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:immich_mobile/generated/translations.g.dart';
import 'package:immich_mobile/trips/trip.provider.dart';
import 'package:immich_mobile/trips/trip_clock.page.dart';
import 'package:immich_mobile/trips/trip_edit.dart';
import 'package:immich_mobile/trips/trip_text.dart';
import 'package:immich_mobile/trips/trip_view.dart';
import 'package:maplibre_gl/maplibre_gl.dart' show LatLng;
import 'package:openapi/api.dart';

// The trip's own actions in edit mode (trips PLAN §2.9), after web TripPanel.svelte: a route's missing start or
// finish, a point added by hand, the camera clocks, and a retry of the legs that need attention.

class TripRouteActions extends ConsumerWidget {
  final TripData data;

  const TripRouteActions({super.key, required this.data});

  TripView get _view => data.view;

  /// Where the point picker opens: the first stop with a position.
  LatLng? get _firstPoint => _view.stops.map((stop) => stop.point).nonNulls.firstOrNull;

  Future<void> _setEnd(BuildContext context, WidgetRef ref, TripStopRole role) {
    return pickTripEnd(context, ref, _view.albumId, role, near: _firstPoint);
  }

  /// A point from the overview goes right after the start; its own card moves it after any stop.
  Future<void> _addPoint(BuildContext context, WidgetRef ref) {
    return pickTripPoint(context, ref, _view.albumId, null, near: _firstPoint);
  }

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final t = context.t;
    final isRoute = _view.isRoute;
    final roles = {for (final stop in _view.stops) stop.role};
    final attentionCount = data.trip.legs.where((leg) => leg.status == TripLegStatus.attention).length;

    Widget action(String key, String label, IconData icon, VoidCallback? onPressed) =>
        TripActionButton(key: ValueKey(key), label: label, icon: icon, onPressed: onPressed);
    VoidCallback? edit(Future<void> Function() run) => data.isBusy ? null : () => unawaited(run());

    return Wrap(
      key: const ValueKey('trip-route-actions'),
      spacing: 8,
      runSpacing: 4,
      children: [
        if (isRoute && !roles.contains(TripStopRole.start))
          action(
            'trip-set-start',
            t.trips_set_start,
            Icons.home_outlined,
            edit(() => _setEnd(context, ref, TripStopRole.start)),
          ),
        if (isRoute && !roles.contains(TripStopRole.finish))
          action(
            'trip-set-finish',
            t.trips_set_finish,
            Icons.sports_score,
            edit(() => _setEnd(context, ref, TripStopRole.finish)),
          ),
        if (isRoute)
          action(
            'trip-add-route-point',
            t.trips_add_point,
            Icons.add_location_alt_outlined,
            edit(() => _addPoint(context, ref)),
          ),
        action(
          'trip-clock',
          t.trips_clock,
          Icons.more_time,
          () => unawaited(showTripClockPage(context, _view.albumId)),
        ),
        if (attentionCount > 0)
          action(
            'trip-retry-legs',
            t.trips_retry_legs(count: attentionCount),
            Icons.refresh,
            edit(
              () => runTripEdit(context, ref, _view.albumId, (repository, albumId) => repository.retryLegs(albumId)),
            ),
          ),
      ],
    );
  }
}
