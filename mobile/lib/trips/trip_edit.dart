import 'package:flutter/widgets.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:immich_mobile/generated/translations.g.dart';
import 'package:immich_mobile/trips/trip.provider.dart';
import 'package:immich_mobile/widgets/common/immich_toast.dart';

/// Runs one edit of the album's trip from a screen, and tells the user when it fails. Returns whether it went through.
Future<bool> runTripEdit(BuildContext context, WidgetRef ref, String albumId, TripEdit edit) async {
  final message = context.t.trips_edit_failed;
  final isDone = await ref.read(tripDataProvider(albumId).notifier).run(edit);
  if (!isDone && context.mounted) {
    ImmichToast.show(context: context, msg: message, toastType: ToastType.error);
  }
  return isDone;
}
