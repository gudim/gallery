import 'package:flutter/widgets.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:immich_mobile/generated/translations.g.dart';
import 'package:immich_mobile/trips/trip.provider.dart';
import 'package:immich_mobile/trips/trip_point.page.dart';
import 'package:immich_mobile/trips/trip_text.dart';
import 'package:immich_mobile/widgets/common/immich_toast.dart';
import 'package:maplibre_gl/maplibre_gl.dart' show LatLng;
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

/// Picks a point for the route's start or finish on the point page, opened at `near`, and sets it there.
Future<void> pickTripEnd(BuildContext context, WidgetRef ref, String albumId, TripStopRole role, {LatLng? near}) async {
  final point = await showTripPointPage(
    context,
    albumId: albumId,
    title: tripEndLabel(context.t, role),
    initial: near,
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

/// Picks a point on the point page, opened at `near`, and adds it to the route after the stop `afterStopId`;
/// null puts it right after the start.
Future<void> pickTripPoint(
  BuildContext context,
  WidgetRef ref,
  String albumId,
  String? afterStopId, {
  LatLng? near,
}) async {
  final point = await showTripPointPage(
    context,
    albumId: albumId,
    title: context.t.trips_add_point,
    initial: near,
    isNamed: true,
  );
  if (point != null && context.mounted) {
    await runTripEdit(context, ref, albumId, (repository, albumId) => repository.addPoint(albumId, point, afterStopId));
  }
}
