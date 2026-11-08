import 'package:flutter/material.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:immich_mobile/extensions/build_context_extensions.dart';
import 'package:immich_mobile/generated/translations.g.dart';
import 'package:immich_mobile/trips/trip.provider.dart';
import 'package:immich_mobile/trips/trip_edit.dart';
import 'package:immich_mobile/trips/trip_point.page.dart';
import 'package:immich_mobile/trips/trip_text.dart';
import 'package:immich_mobile/trips/trip_view.dart';
import 'package:immich_mobile/trips/trips_api.repository.dart';
import 'package:immich_mobile/widgets/common/confirm_dialog.dart';
import 'package:immich_mobile/widgets/common/immich_toast.dart';
import 'package:openapi/api.dart';

// What can be done to the assets picked in a stop's grid in edit mode (trips PLAN §2.9), after web
// TripAssetActions.svelte: move them to another stop, make a stop of them, split the stop at one, set or clear one's
// point, on a Places trip file Unplaced ones to the centre, and hide them: they leave the album (trips PLAN D11).

class TripAssetActions extends ConsumerWidget {
  final TripData data;

  /// The stop or item whose grid the assets were picked in
  final TripItem item;

  /// The picked assets, in the grid's order
  final List<String> ids;

  /// The edit went through; `stopId` is the stop the assets went to, or null when they stay
  final void Function(String? stopId) onDone;

  /// Drops the pick
  final VoidCallback onClear;

  const TripAssetActions({
    super.key,
    required this.data,
    required this.item,
    required this.ids,
    required this.onDone,
    required this.onClear,
  });

  TripView get _view => data.view;

  String? get _single => ids.length == 1 ? ids.first : null;

  Future<void> _run(BuildContext context, WidgetRef ref, TripEdit edit, {String? stopId}) async {
    if (await runTripEdit(context, ref, _view.albumId, edit)) {
      onDone(stopId);
    }
  }

  Future<void> _point(BuildContext context, WidgetRef ref, String assetId) async {
    final photo = item.photos.where((photo) => photo.id == assetId).firstOrNull;
    final point = await showTripPointPage(
      context,
      albumId: _view.albumId,
      title: context.t.trips_asset_point,
      initial: photo?.point,
    );
    if (point != null && context.mounted) {
      await _run(context, ref, (repository, albumId) => repository.setAssetPoint(albumId, assetId, point));
    }
  }

  Future<void> _toCenter(BuildContext context, WidgetRef ref) async {
    TripPoint? center;
    if (!_view.stops.any((stop) => stop.isAtCenter)) {
      center = await showTripPointPage(context, albumId: _view.albumId, title: context.t.trips_center, isNamed: true);
      if (center == null || !context.mounted) {
        return;
      }
    }
    await _run(context, ref, (repository, albumId) => repository.toCenter(albumId, ids, center));
  }

  Future<void> _hide(BuildContext context, WidgetRef ref) async {
    final t = context.t;
    final isSure = await showDialog<bool>(
      context: context,
      builder: (_) => ConfirmDialog(
        title: t.trips_hide_from_trip,
        content: t.remove_assets_album_confirmation(count: ids.length),
        ok: t.remove,
      ),
    );
    if (isSure != true || !context.mounted) {
      return;
    }
    await _run(context, ref, (repository, albumId) async {
      final result = await repository.hideAssets(albumId, ids);
      // Told as soon as the server answers, as on the web: once the trip updates, this bar is gone.
      if (context.mounted) {
        ImmichToast.show(
          context: context,
          msg: t.assets_removed_count(count: result.count),
        );
      }
      return result.trip;
    });
  }

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final t = context.t;
    final single = _single;
    final targets = _view.moveTargets(item.id);
    final filing = single == null ? null : data.trip.assets.where((asset) => asset.assetId == single).firstOrNull;
    // The split begins with the picked asset; the first asset of a stop would leave nothing behind.
    final canSplit = item is TripViewStop && single != null && item.photos.firstOrNull?.id != single;
    final hasMap = _view.hasMap;
    final isBusy = data.isBusy;

    Widget button(String key, IconData icon, String tooltip, VoidCallback onPressed) =>
        IconButton(key: ValueKey(key), tooltip: tooltip, icon: Icon(icon), onPressed: isBusy ? null : onPressed);

    return Material(
      key: const ValueKey('trip-asset-actions'),
      elevation: 6,
      color: context.colorScheme.surfaceContainerHigh,
      borderRadius: BorderRadius.circular(28),
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 4, vertical: 2),
        child: Row(
          children: [
            IconButton(tooltip: t.cancel, icon: const Icon(Icons.close), onPressed: onClear),
            Text('${ids.length}', style: context.textTheme.titleMedium),
            const SizedBox(width: 8),
            Expanded(
              child: SingleChildScrollView(
                scrollDirection: Axis.horizontal,
                reverse: true,
                child: Row(
                  children: [
                    if (targets.isNotEmpty)
                      PopupMenuButton<String>(
                        key: const ValueKey('trip-move-to-stop'),
                        tooltip: t.trips_move_to_stop,
                        icon: const Icon(Icons.drive_file_move_outline),
                        enabled: !isBusy,
                        itemBuilder: (_) => [
                          for (final target in targets)
                            PopupMenuItem(value: target.id, child: Text(tripRowTitle(t, target))),
                        ],
                        onSelected: (stopId) => _run(
                          context,
                          ref,
                          (repository, albumId) => repository.moveAssets(albumId, ids, stopId),
                          stopId: stopId,
                        ),
                      ),
                    button(
                      'trip-new-stop',
                      Icons.add_location_alt_outlined,
                      t.trips_new_stop,
                      () => _run(context, ref, (repository, albumId) => repository.createStop(albumId, ids)),
                    ),
                    if (canSplit)
                      button(
                        'trip-split',
                        Icons.call_split,
                        t.trips_split_here,
                        () =>
                            _run(context, ref, (repository, albumId) => repository.splitStop(albumId, item.id, single)),
                      ),
                    if (hasMap && single != null) ...[
                      button(
                        'trip-asset-point',
                        Icons.edit_location_alt_outlined,
                        t.trips_asset_point,
                        () => _point(context, ref, single),
                      ),
                      if (filing?.pointSource == TripPointSource.manual)
                        button(
                          'trip-asset-point-reset',
                          Icons.location_off_outlined,
                          t.trips_asset_point_reset,
                          () =>
                              _run(context, ref, (repository, albumId) => repository.removeAssetPoint(albumId, single)),
                        ),
                    ],
                    if (_view.isPlaces && item is TripUnplaced)
                      button('trip-to-center', Icons.gps_fixed, t.trips_to_center, () => _toCenter(context, ref)),
                    button(
                      'trip-hide',
                      Icons.visibility_off_outlined,
                      t.trips_hide_from_trip,
                      () => _hide(context, ref),
                    ),
                  ],
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}
