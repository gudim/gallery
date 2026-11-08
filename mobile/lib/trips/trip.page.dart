import 'dart:async';

import 'package:auto_route/auto_route.dart';
import 'package:flutter/material.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:immich_mobile/extensions/build_context_extensions.dart';
import 'package:immich_mobile/generated/translations.g.dart';
import 'package:immich_mobile/trips/trip.provider.dart';
import 'package:immich_mobile/trips/trip_asset_actions.dart';
import 'package:immich_mobile/trips/trip_edit.dart';
import 'package:immich_mobile/trips/trip_map.widget.dart';
import 'package:immich_mobile/trips/trip_panel.dart';
import 'package:immich_mobile/trips/trip_view.dart';
import 'package:maplibre_gl/maplibre_gl.dart' show LatLng;

// A trip on the phone (trips PLAN §2.9), after web/src/lib/trips/components/TripPage.svelte and TripPanel.svelte:
// Gallery's map with the route, and the stops in a sheet over it (beside it on a tablet). A stop opens its assets,
// and an asset opens Gallery's viewer over every asset of the trip, with likes.

@RoutePage()
class TripPage extends ConsumerStatefulWidget {
  final String albumId;
  final String title;

  /// The album's owner or an editor (D7): the page offers edit mode.
  final bool canEdit;

  const TripPage({super.key, required this.albumId, required this.title, this.canEdit = false});

  @override
  ConsumerState<TripPage> createState() => _TripPageState();
}

class _TripPageState extends ConsumerState<TripPage> {
  static const _wideWidth = 600.0;

  String? _openId;
  bool _isEditing = false;

  /// The leg opened in edit mode (web TripPage `openLegId`)
  String? _openLegId;

  /// The stop whose pin is being moved, and where the map's centre points now (web TripPage `moving`)
  ({String stopId, LatLng at})? _moving;

  /// Assets picked in the open stop's grid in edit mode (web assetMultiSelectManager)
  Set<String> _picked = const {};

  /// Shows an item, a leg, or the whole trip when both are null; a pin move and picked assets are left behind.
  void _show({String? itemId, String? legId}) => setState(() {
    _openId = itemId;
    _openLegId = legId;
    _moving = null;
    _picked = const {};
  });

  void _open(TripItem item) => _show(itemId: item.id);

  void _openLeg(String legId) => _show(legId: legId);

  void _back() => _show();

  // The open item stays open; a leg is opened in edit mode only.
  void _toggleEditing() {
    setState(() => _isEditing = !_isEditing);
    _show(itemId: _openId);
  }

  void _togglePicked(String assetId) => setState(() {
    _picked = _picked.contains(assetId) ? ({..._picked}..remove(assetId)) : {..._picked, assetId};
  });

  // The assets went to `stopId`, which opens, as on the web; otherwise the stop stays open.
  void _onAssetsDone(String? stopId) => setState(() {
    _picked = const {};
    if (stopId != null) {
      _openId = stopId;
    }
  });

  void _startMoving(TripViewStop stop) {
    final (latitude, longitude) = (stop.latitude, stop.longitude);
    if (latitude != null && longitude != null) {
      setState(() => _moving = (stopId: stop.id, at: LatLng(latitude, longitude)));
    }
  }

  // Written only when the owner saves it, as travel-album's pin move waited for confirmation.
  Future<void> _saveMoving() async {
    final moving = _moving;
    if (moving == null) {
      return;
    }
    final isSaved = await runTripEdit(
      context,
      ref,
      widget.albumId,
      (repository, albumId) => repository.moveStop(albumId, moving.stopId, moving.at.latitude, moving.at.longitude),
    );
    if (isSaved && mounted) {
      setState(() => _moving = null);
    }
  }

  @override
  Widget build(BuildContext context) {
    final data = ref.watch(tripDataProvider(widget.albumId));
    // Keeps the likes alive while the viewer is open over this page.
    ref.watch(tripLikesProvider(widget.albumId));

    return PopScope(
      canPop: _openId == null && _openLegId == null && _moving == null && _picked.isEmpty,
      onPopInvokedWithResult: (didPop, _) {
        if (didPop) {
          return;
        }
        if (_picked.isNotEmpty) {
          setState(() => _picked = const {});
        } else if (_moving != null) {
          setState(() => _moving = null);
        } else {
          _back();
        }
      },
      child: Scaffold(
        appBar: AppBar(
          title: Text(widget.title),
          actions: [
            if (widget.canEdit && data.valueOrNull != null)
              _isEditing
                  ? IconButton.filled(
                      key: const ValueKey('trip-edit-toggle'),
                      tooltip: context.t.done,
                      // The app bar paints its icons in the primary colour, the button's own fill.
                      icon: Icon(Icons.check, color: context.colorScheme.onPrimary),
                      onPressed: _toggleEditing,
                    )
                  : IconButton(
                      key: const ValueKey('trip-edit-toggle'),
                      tooltip: context.t.edit,
                      icon: const Icon(Icons.edit_outlined),
                      onPressed: _toggleEditing,
                    ),
            const SizedBox(width: 8),
          ],
        ),
        body: data.when(
          loading: () => const Center(child: CircularProgressIndicator()),
          error: (_, _) => _Message(
            text: context.t.trips_load_failed,
            onRetry: () => ref.invalidate(tripDataProvider(widget.albumId)),
          ),
          data: (data) => data == null ? _Message(text: context.t.trips_no_trip) : _body(context, data),
        ),
      ),
    );
  }

  Widget _body(BuildContext context, TripData data) {
    final openItem = _openId == null ? null : data.view.itemById(_openId!);
    final picked = openItem == null || !_isEditing
        ? const <String>[]
        : [
            for (final photo in openItem.photos)
              if (_picked.contains(photo.id)) photo.id,
          ];
    final layout = _layout(context, data, openItem, picked);
    if (openItem == null || picked.isEmpty) {
      return layout;
    }
    return Stack(
      children: [
        Positioned.fill(child: layout),
        Positioned(
          left: 8,
          right: 8,
          bottom: 16,
          child: SafeArea(
            child: TripAssetActions(
              data: data,
              item: openItem,
              ids: picked,
              onDone: _onAssetsDone,
              onClear: () => setState(() => _picked = const {}),
            ),
          ),
        ),
      ],
    );
  }

  Widget _layout(BuildContext context, TripData data, TripItem? openItem, List<String> picked) {
    final view = data.view;

    final openLeg = _isEditing ? data.trip.legs.where((leg) => leg.id == _openLegId).firstOrNull : null;
    Widget panel(ScrollController? controller) => TripPanel(
      data: data,
      openItem: openItem,
      openLeg: openLeg,
      onOpenLeg: _openLeg,
      isEditing: _isEditing,
      picking: TripPicking(
        ids: picked,
        toggle: _togglePicked,
        only: (ids) => setState(() => _picked = ids.toSet()),
        clear: () => setState(() => _picked = const {}),
      ),
      controller: controller,
      onOpen: _open,
      onBack: _back,
      onMovePin: _startMoving,
    );

    final moving = _moving;
    Widget map({double bottomPadding = 0}) => TripMap(
      view: view,
      onOpen: _open,
      focused: openItem,
      openLegId: _isEditing ? _openLegId : null,
      onOpenLeg: _isEditing ? _openLeg : null,
      bottomPadding: moving == null ? bottomPadding : 0,
      pin: moving?.at,
      onPinMoved: (at) {
        final current = _moving;
        if (current != null) {
          setState(() => _moving = (stopId: current.stopId, at: at));
        }
      },
    );
    Widget withPinBar(Widget map) => moving == null
        ? map
        : Stack(
            children: [
              Positioned.fill(child: map),
              Positioned(
                left: 16,
                right: 16,
                bottom: 24,
                child: SafeArea(
                  child: _PinBar(
                    isBusy: data.isBusy,
                    onCancel: () => setState(() => _moving = null),
                    onSave: _saveMoving,
                  ),
                ),
              ),
            ],
          );

    if (!view.hasMap) {
      return panel(null);
    }

    return LayoutBuilder(
      builder: (context, constraints) {
        if (constraints.maxWidth >= _wideWidth) {
          return Row(
            children: [
              Expanded(flex: 2, child: withPinBar(map())),
              const VerticalDivider(width: 1),
              Expanded(child: panel(null)),
            ],
          );
        }
        // In edit mode the stop's fields take two thirds of the screen, as on the web.
        final initialSize = _isEditing ? 0.67 : 0.45;
        // While a pin moves, the map takes the whole screen.
        if (moving != null) {
          return withPinBar(map());
        }
        return Stack(
          children: [
            Positioned.fill(child: map(bottomPadding: constraints.maxHeight * initialSize)),
            DraggableScrollableSheet(
              key: ValueKey(_isEditing),
              initialChildSize: initialSize,
              minChildSize: 0.15,
              maxChildSize: 0.95,
              snap: true,
              snapSizes: [initialSize],
              builder: (context, controller) => Material(
                color: context.colorScheme.surface,
                elevation: 8,
                borderRadius: const BorderRadius.vertical(top: Radius.circular(20)),
                clipBehavior: Clip.antiAlias,
                child: panel(controller),
              ),
            ),
          ],
        );
      },
    );
  }
}

class _PinBar extends StatelessWidget {
  final bool isBusy;
  final VoidCallback onCancel;
  final VoidCallback onSave;

  const _PinBar({required this.isBusy, required this.onCancel, required this.onSave});

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Material(
        key: const ValueKey('trip-pin-bar'),
        elevation: 6,
        color: context.colorScheme.surfaceContainerHigh,
        borderRadius: BorderRadius.circular(28),
        child: Padding(
          padding: const EdgeInsets.fromLTRB(20, 6, 6, 6),
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              Flexible(child: Text(context.t.trips_pan_to_pin)),
              const SizedBox(width: 8),
              TextButton(onPressed: onCancel, child: Text(context.t.cancel)),
              FilledButton(
                key: const ValueKey('trip-pin-save'),
                onPressed: isBusy ? null : onSave,
                child: Text(context.t.save),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _Message extends StatelessWidget {
  final String text;
  final VoidCallback? onRetry;

  const _Message({required this.text, this.onRetry});

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(32),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Text(text, textAlign: TextAlign.center),
            if (onRetry != null) ...[
              const SizedBox(height: 12),
              TextButton(onPressed: onRetry, child: Text(context.t.retry)),
            ],
          ],
        ),
      ),
    );
  }
}
