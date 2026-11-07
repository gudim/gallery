import 'dart:async';

import 'package:flutter/material.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:immich_mobile/extensions/build_context_extensions.dart';
import 'package:immich_mobile/generated/translations.g.dart';
import 'package:immich_mobile/trips/trip.provider.dart';
import 'package:immich_mobile/trips/trip_text.dart';
import 'package:immich_mobile/trips/trips_api.repository.dart';
import 'package:immich_mobile/widgets/common/immich_toast.dart';
import 'package:openapi/api.dart';

// Places offered to the Unplaced assets of a Places trip by their likeness to assets with GPS (trips PLAN §2.9), after
// web TripPlaceHints.svelte. A hint moves nothing by itself: "Select" picks its assets in the grid below, where some can
// be dropped before moving the rest, and "Move" files them all.

class TripPlaceHints extends ConsumerStatefulWidget {
  final TripData data;

  /// Picks these assets in the grid
  final void Function(List<String> assetIds) onSelect;

  /// The assets were filed
  final VoidCallback onMoved;

  const TripPlaceHints({super.key, required this.data, required this.onSelect, required this.onMoved});

  @override
  ConsumerState<TripPlaceHints> createState() => _TripPlaceHintsState();
}

class _TripPlaceHintsState extends ConsumerState<TripPlaceHints> {
  TripPlaceHintsDto? _hints;

  /// The trip version the hints were asked for; asked again after every edit, as travel-album's editor did.
  int? _version;

  @override
  void initState() {
    super.initState();
    _load();
  }

  @override
  void didUpdateWidget(TripPlaceHints oldWidget) {
    super.didUpdateWidget(oldWidget);
    _load();
  }

  void _load() {
    final version = widget.data.trip.contentVersion;
    if (version == _version) {
      return;
    }
    _version = version;
    unawaited(
      ref
          .read(tripsApiRepositoryProvider)
          .getPlaceHints(widget.data.view.albumId)
          .then((hints) {
            if (mounted && _version == version) {
              setState(() => _hints = hints);
            }
          })
          // Hints are a convenience; without them the assets are filed by hand.
          .catchError((_) {
            if (mounted && _version == version) {
              setState(() => _hints = null);
            }
          }),
    );
  }

  Future<void> _run(Future<TripResponseDto> Function(TripsApiRepository repository, String albumId) edit) async {
    final message = context.t.trips_edit_failed;
    final repository = ref.read(tripsApiRepositoryProvider);
    final isDone = await ref
        .read(tripDataProvider(widget.data.view.albumId).notifier)
        .run((albumId) => edit(repository, albumId));
    if (!mounted) {
      return;
    }
    if (isDone) {
      widget.onMoved();
    } else {
      ImmichToast.show(context: context, msg: message, toastType: ToastType.error);
    }
  }

  String _titleOf(String stopId) {
    final stop = widget.data.view.stops.where((stop) => stop.id == stopId).firstOrNull;
    return stop == null ? context.t.trips_untitled_stop : tripRowTitle(context.t, stop);
  }

  @override
  Widget build(BuildContext context) {
    final t = context.t;
    final hints = _hints;
    if (hints == null || (hints.places.isEmpty && hints.center.isEmpty)) {
      return const SizedBox.shrink();
    }
    final muted = context.textTheme.bodySmall?.copyWith(color: context.colorScheme.onSurfaceVariant);
    final isBusy = widget.data.isBusy;

    Widget hint(Key key, String label, List<String> assetIds, String action, VoidCallback onMove) => Padding(
      key: key,
      padding: const EdgeInsets.symmetric(vertical: 2),
      child: Row(
        children: [
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(label),
                Text(t.trips_assets_count(count: assetIds.length), style: muted),
              ],
            ),
          ),
          TextButton(onPressed: () => widget.onSelect(assetIds), child: Text(t.select)),
          TextButton(onPressed: isBusy ? null : onMove, child: Text(action)),
        ],
      ),
    );

    return Column(
      key: const ValueKey('trip-place-hints'),
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        const SizedBox(height: 12),
        Text(t.trips_hints_title, style: muted),
        for (final place in hints.places)
          hint(
            ValueKey('trip-hint-${place.stopId}'),
            _titleOf(place.stopId),
            place.assetIds,
            t.move,
            () =>
                unawaited(_run((repository, albumId) => repository.moveAssets(albumId, place.assetIds, place.stopId))),
          ),
        if (hints.center.isNotEmpty)
          hint(
            const ValueKey('trip-hint-center'),
            t.trips_hints_like_none,
            hints.center,
            t.trips_to_center,
            () => unawaited(_run((repository, albumId) => repository.toCenter(albumId, hints.center, null))),
          ),
      ],
    );
  }
}
