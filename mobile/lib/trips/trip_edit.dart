import 'package:flutter/widgets.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:immich_mobile/generated/translations.g.dart';
import 'package:immich_mobile/trips/trip.provider.dart';
import 'package:immich_mobile/trips/trip_point.page.dart';
import 'package:immich_mobile/trips/trip_text.dart';
import 'package:immich_mobile/widgets/common/immich_toast.dart';
import 'package:openapi/api.dart';

/// Runs one edit of the album's trip from a screen, and tells the user when it fails. Returns whether it went through.
Future<bool> runTripEdit(BuildContext context, WidgetRef ref, String albumId, TripEdit edit) async {
  final message = context.t.trips_edit_failed;
  final isDone = await ref.read(tripDataProvider(albumId).notifier).run(edit);
  if (!isDone && context.mounted) {
    ImmichToast.show(context: context, msg: message, toastType: ToastType.error);
  }
  return isDone;
}

/// Picks a point for the route's start or finish on the point page, opened at the given point, and sets it there.
Future<void> pickTripEnd(
  BuildContext context,
  WidgetRef ref,
  String albumId,
  TripStopRole role, {
  double? latitude,
  double? longitude,
}) async {
  final point = await showTripPointPage(
    context,
    albumId: albumId,
    title: tripEndLabel(context.t, role),
    latitude: latitude,
    longitude: longitude,
    isNamed: true,
  );
  if (point != null && context.mounted) {
    await runTripEdit(
      context,
      ref,
      albumId,
      (repository, albumId) =>
          role == TripStopRole.start ? repository.setStart(albumId, point) : repository.setFinish(albumId, point),
    );
  }
}

/// Picks a point on the point page, opened at the given point, and adds it to the route after the stop `afterStopId`;
/// null puts it right after the start.
Future<void> pickTripPoint(
  BuildContext context,
  WidgetRef ref,
  String albumId,
  String? afterStopId, {
  double? latitude,
  double? longitude,
}) async {
  final point = await showTripPointPage(
    context,
    albumId: albumId,
    title: context.t.trips_add_point,
    latitude: latitude,
    longitude: longitude,
    isNamed: true,
  );
  if (point != null && context.mounted) {
    await runTripEdit(context, ref, albumId, (repository, albumId) => repository.addPoint(albumId, point, afterStopId));
  }
}
