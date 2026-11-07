import 'dart:async';

import 'package:auto_route/auto_route.dart';
import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:immich_mobile/domain/services/timeline.service.dart';
import 'package:immich_mobile/extensions/build_context_extensions.dart';
import 'package:immich_mobile/generated/translations.g.dart';
import 'package:immich_mobile/presentation/widgets/asset_viewer/asset_viewer.page.dart';
import 'package:immich_mobile/presentation/widgets/images/thumbnail_tile.widget.dart';
import 'package:immich_mobile/providers/infrastructure/timeline.provider.dart';
import 'package:immich_mobile/routing/router.dart';
import 'package:immich_mobile/trips/trip.provider.dart';
import 'package:immich_mobile/trips/trip_asset_actions.dart';
import 'package:immich_mobile/trips/trip_clock.page.dart';
import 'package:immich_mobile/trips/trip_leg_edit.dart';
import 'package:immich_mobile/trips/trip_map.widget.dart';
import 'package:immich_mobile/trips/trip_place_hints.dart';
import 'package:immich_mobile/trips/trip_stop_edit.dart';
import 'package:immich_mobile/trips/trip_text.dart';
import 'package:immich_mobile/trips/trip_view.dart';
import 'package:immich_mobile/trips/trips_api.repository.dart';
import 'package:immich_mobile/widgets/common/immich_toast.dart';
import 'package:maplibre_gl/maplibre_gl.dart' show LatLng;
import 'package:openapi/api.dart';

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

  void _open(TripItem item) => setState(() {
    _openId = item.id;
    _openLegId = null;
    _moving = null;
    _picked = const {};
  });

  void _openLeg(String legId) => setState(() {
    _openId = null;
    _openLegId = legId;
    _moving = null;
    _picked = const {};
  });

  void _back() => setState(() {
    _openId = null;
    _openLegId = null;
    _moving = null;
    _picked = const {};
  });

  void _toggleEditing() => setState(() {
    _isEditing = !_isEditing;
    _openLegId = null;
    _moving = null;
    _picked = const {};
  });

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
    final message = context.t.trips_edit_failed;
    final repository = ref.read(tripsApiRepositoryProvider);
    final isSaved = await ref
        .read(tripDataProvider(widget.albumId).notifier)
        .run((albumId) => repository.moveStop(albumId, moving.stopId, moving.at.latitude, moving.at.longitude));
    if (!mounted) {
      return;
    }
    if (isSaved) {
      setState(() => _moving = null);
    } else {
      ImmichToast.show(context: context, msg: message, toastType: ToastType.error);
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
    final openItem = _openId == null ? null : _find(data.view, _openId!);
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
    Widget panel(ScrollController? controller) => _TripPanel(
      data: data,
      openItem: openItem,
      openLeg: openLeg,
      onOpenLeg: _openLeg,
      isEditing: _isEditing,
      picked: picked,
      onPick: _togglePicked,
      onPickAll: (ids) => setState(() => _picked = ids.toSet()),
      onClearPicked: () => setState(() => _picked = const {}),
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

    if (view.kind == TripKind.plain) {
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

  static TripItem? _find(TripView view, String id) {
    for (final item in view.order) {
      if (item.id == id) {
        return item;
      }
    }
    for (final stop in view.stops) {
      if (stop.id == id) {
        return stop;
      }
    }
    return null;
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

class _TripPanel extends ConsumerWidget {
  final TripData data;
  final TripItem? openItem;

  /// The leg opened in edit mode
  final TripLegDto? openLeg;
  final void Function(String legId) onOpenLeg;
  final bool isEditing;

  /// Assets picked in the open stop's grid
  final List<String> picked;
  final void Function(String assetId) onPick;

  /// Picks just these assets, as a place hint's "Select" does
  final void Function(List<String> assetIds) onPickAll;
  final VoidCallback onClearPicked;
  final ScrollController? controller;
  final void Function(TripItem item) onOpen;
  final VoidCallback onBack;
  final void Function(TripViewStop stop) onMovePin;

  const _TripPanel({
    required this.data,
    required this.openItem,
    required this.openLeg,
    required this.onOpenLeg,
    required this.isEditing,
    required this.picked,
    required this.onPick,
    required this.onPickAll,
    required this.onClearPicked,
    required this.controller,
    required this.onOpen,
    required this.onBack,
    required this.onMovePin,
  });

  TripView get view => data.view;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final t = context.t;
    final lang = context.locale.toLanguageTag();
    final item = openItem;
    final muted = context.textTheme.bodySmall?.copyWith(color: context.colorScheme.onSurfaceVariant);
    final isSheet = controller != null;
    final leg = openLeg;
    final attentionCount = data.trip.legs.where((leg) => leg.status == TripLegStatus.attention).length;

    return CustomScrollView(
      controller: controller,
      slivers: [
        if (isSheet) const SliverToBoxAdapter(child: _Handle()),
        if (leg != null)
          SliverToBoxAdapter(
            key: const ValueKey('trip-leg'),
            child: Padding(
              padding: const EdgeInsets.fromLTRB(8, 4, 16, 24),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  TextButton.icon(
                    onPressed: onBack,
                    icon: const Icon(Icons.arrow_back, size: 18),
                    label: Text(t.trips_back_route),
                  ),
                  Padding(
                    padding: const EdgeInsets.only(left: 8),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.stretch,
                      children: [
                        Text(
                          '${_stopName(t, leg.fromStopId)} → ${_stopName(t, leg.toStopId)}',
                          style: context.textTheme.titleMedium,
                        ),
                        Text(tripLegLine(t, leg), style: muted),
                        const SizedBox(height: 16),
                        TripLegEdit(data: data, leg: leg),
                      ],
                    ),
                  ),
                ],
              ),
            ),
          )
        else if (item != null) ...[
          SliverToBoxAdapter(
            key: const ValueKey('trip-stop'),
            child: Padding(
              padding: const EdgeInsets.fromLTRB(8, 4, 16, 12),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  TextButton.icon(
                    onPressed: onBack,
                    icon: const Icon(Icons.arrow_back, size: 18),
                    label: Text(view.kind == TripKind.places ? t.trips_back_places : t.trips_back_route),
                  ),
                  Padding(
                    padding: const EdgeInsets.only(left: 8),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(tripItemTitle(t, item, view, lang), style: context.textTheme.titleLarge),
                        Text(tripItemMeta(t, item, view, lang).join(' · '), style: muted),
                        if (isEditing && item is! TripUnplaced) ...[
                          const SizedBox(height: 12),
                          TripStopEdit(data: data, item: item, onGone: onBack, onMovePin: onMovePin),
                        ] else if (item is TripViewStop && item.story.isNotEmpty) ...[
                          const SizedBox(height: 8),
                          Text(item.story, maxLines: 6, overflow: TextOverflow.ellipsis),
                        ],
                        if (item is TripUnplaced) ...[const SizedBox(height: 8), Text(t.trips_unplaced_note)],
                        if (item is TripUnplaced && isEditing && view.kind == TripKind.places)
                          TripPlaceHints(data: data, onSelect: onPickAll, onMoved: onClearPicked),
                        if (item is TripViewStop && item.article != null && item.article!.isNotEmpty)
                          _Article(text: item.article!),
                        if (isEditing && item.photos.isNotEmpty) ...[
                          const SizedBox(height: 12),
                          Text(t.trips_select_hint, style: muted),
                        ],
                      ],
                    ),
                  ),
                ],
              ),
            ),
          ),
          if (item.photos.isEmpty)
            SliverToBoxAdapter(
              child: Padding(
                padding: const EdgeInsets.all(16),
                child: Text(tripEmptyNote(t, item, view), style: muted),
              ),
            )
          else
            SliverPadding(
              // Room for the action bar over the last row while assets are picked.
              padding: EdgeInsets.fromLTRB(2, 0, 2, picked.isEmpty ? 24 : 96),
              sliver: SliverGrid(
                gridDelegate: const SliverGridDelegateWithMaxCrossAxisExtent(
                  maxCrossAxisExtent: 120,
                  mainAxisSpacing: 2,
                  crossAxisSpacing: 2,
                ),
                delegate: SliverChildBuilderDelegate(childCount: item.photos.length, (context, index) {
                  final photo = item.photos[index];
                  return _Thumbnail(
                    data: data,
                    photo: photo,
                    isPicked: picked.contains(photo.id),
                    // In edit mode a long press picks, and while anything is picked a tap does too, as in Gallery.
                    onPick: !isEditing ? null : () => onPick(photo.id),
                    isPicking: picked.isNotEmpty,
                  );
                }),
              ),
            ),
        ] else ...[
          SliverToBoxAdapter(
            child: Padding(
              padding: const EdgeInsets.fromLTRB(16, 8, 16, 8),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(tripRangeLine(t, view, lang), key: const ValueKey('trip-range')),
                  Text(tripStatsLine(t, view, lang), key: const ValueKey('trip-stats'), style: muted),
                  if (isEditing) ...[
                    const SizedBox(height: 8),
                    Wrap(
                      key: const ValueKey('trip-route-actions'),
                      spacing: 8,
                      runSpacing: 4,
                      children: [
                        OutlinedButton.icon(
                          key: const ValueKey('trip-clock'),
                          onPressed: () => unawaited(showTripClockPage(context, view.albumId)),
                          icon: const Icon(Icons.more_time, size: 18),
                          label: Text(t.trips_clock),
                          style: OutlinedButton.styleFrom(visualDensity: VisualDensity.compact),
                        ),
                        if (attentionCount > 0)
                          OutlinedButton.icon(
                            key: const ValueKey('trip-retry-legs'),
                            onPressed: data.isBusy ? null : () => unawaited(_retryLegs(context, ref)),
                            icon: const Icon(Icons.refresh, size: 18),
                            label: Text(t.trips_retry_legs(count: attentionCount)),
                            style: OutlinedButton.styleFrom(visualDensity: VisualDensity.compact),
                          ),
                      ],
                    ),
                  ],
                ],
              ),
            ),
          ),
          const SliverToBoxAdapter(child: Divider(height: 1)),
          SliverList.list(children: _rows(context, lang)),
          const SliverToBoxAdapter(child: SizedBox(height: 24)),
        ],
      ],
    );
  }

  String _stopName(Translations t, String stopId) {
    final stop = view.stops.where((stop) => stop.id == stopId).firstOrNull;
    return stop == null ? '' : tripRowTitle(t, stop);
  }

  Future<void> _retryLegs(BuildContext context, WidgetRef ref) async {
    final message = context.t.trips_edit_failed;
    final repository = ref.read(tripsApiRepositoryProvider);
    final isDone = await ref.read(tripDataProvider(view.albumId).notifier).run(repository.retryLegs);
    if (!isDone && context.mounted) {
      ImmichToast.show(context: context, msg: message, toastType: ToastType.error);
    }
  }

  List<Widget> _rows(BuildContext context, String lang) {
    final t = context.t;
    final rows = <Widget>[];
    switch (view.kind) {
      case TripKind.places:
        final places = view.stops.where((stop) => isEditing || stop.photos.isNotEmpty).toList()
          ..sort((a, b) => b.photos.length.compareTo(a.photos.length));
        rows.add(_Header(title: t.trips_places_title));
        rows.addAll(places.map((stop) => _StopRow(stop: stop, isRoute: false, onOpen: onOpen)));
        final unplaced = view.unplaced;
        if (unplaced != null) {
          rows.add(_ItemRow(title: t.trips_unplaced, count: unplaced.photos.length, onTap: () => onOpen(unplaced)));
        }
      case TripKind.plain:
        rows.addAll(
          view.stops
              .where((stop) => isEditing || stop.photos.isNotEmpty)
              .map((stop) => _StopRow(stop: stop, isRoute: false, onOpen: onOpen)),
        );
      default:
        for (final (index, day) in view.days.indexed) {
          final stops = view.stops.where((stop) => stop.day == index).toList();
          if (stops.isEmpty) {
            continue;
          }
          rows.add(_DayHeader(day: day, label: tripDayLabel(day.date, lang)));
          for (final stop in stops) {
            rows.add(_StopRow(stop: stop, isRoute: true, onOpen: onOpen));
            for (final way in view.transit.where((way) => way.fromStopId == stop.id)) {
              rows.add(
                _ItemRow(
                  leading: way.t0,
                  title: t.trips_on_the_way,
                  count: way.photos.length,
                  isMuted: true,
                  onTap: () => onOpen(way),
                ),
              );
            }
            // In edit mode every leg is listed, a leg still being routed included.
            final legs = isEditing ? data.trip.legs : view.legs.map((leg) => leg.leg);
            for (final leg in legs.where((leg) => leg.fromStopId == stop.id)) {
              rows.add(_LegRow(leg: leg, onTap: isEditing ? () => onOpenLeg(leg.id) : null));
            }
          }
        }
    }
    return rows;
  }
}

class _Handle extends StatelessWidget {
  const _Handle();

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Container(
        margin: const EdgeInsets.symmetric(vertical: 8),
        width: 32,
        height: 4,
        decoration: BoxDecoration(
          color: context.colorScheme.onSurfaceVariant.withValues(alpha: 0.4),
          borderRadius: BorderRadius.circular(2),
        ),
      ),
    );
  }
}

class _Article extends StatelessWidget {
  final String text;

  const _Article({required this.text});

  @override
  Widget build(BuildContext context) {
    return Theme(
      data: Theme.of(context).copyWith(dividerColor: Colors.transparent),
      child: ExpansionTile(
        tilePadding: EdgeInsets.zero,
        childrenPadding: EdgeInsets.zero,
        title: Text(context.t.trips_about_place, style: TextStyle(color: context.primaryColor)),
        children: [
          for (final paragraph in text.split(RegExp(r'\n\s*\n')))
            Padding(padding: const EdgeInsets.only(top: 8), child: Text(paragraph)),
        ],
      ),
    );
  }
}

class _Header extends StatelessWidget {
  final String title;

  const _Header({required this.title});

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 12, 16, 4),
      child: Text(title, style: context.textTheme.titleSmall),
    );
  }
}

class _DayHeader extends StatelessWidget {
  final TripDay day;
  final String label;

  const _DayHeader({required this.day, required this.label});

  @override
  Widget build(BuildContext context) {
    final muted = context.textTheme.bodySmall?.copyWith(color: context.colorScheme.onSurfaceVariant);
    return Padding(
      key: const ValueKey('trip-day'),
      padding: const EdgeInsets.fromLTRB(16, 14, 16, 4),
      child: Row(
        children: [
          Container(
            width: 8,
            height: 8,
            decoration: BoxDecoration(color: Color(day.color), shape: BoxShape.circle),
          ),
          const SizedBox(width: 8),
          Text(label, style: context.textTheme.titleSmall),
          const SizedBox(width: 8),
          Expanded(
            child: Text(day.regions.take(3).join(' · '), style: muted, overflow: TextOverflow.ellipsis),
          ),
          Text('${day.count}', style: muted),
        ],
      ),
    );
  }
}

class _StopRow extends StatelessWidget {
  final TripViewStop stop;
  final bool isRoute;
  final void Function(TripItem item) onOpen;

  const _StopRow({required this.stop, required this.isRoute, required this.onOpen});

  @override
  Widget build(BuildContext context) {
    return _ItemRow(
      key: ValueKey('trip-stop-row-${stop.id}'),
      leading: isRoute ? stop.t0 : null,
      title: tripRowTitle(context.t, stop),
      count: stop.photos.length,
      isMuted: stop.photos.length <= 3,
      isItalic: stop.title.isEmpty && stop.region.isEmpty,
      onTap: () => onOpen(stop),
    );
  }
}

class _ItemRow extends StatelessWidget {
  final String? leading;
  final String title;
  final int count;
  final bool isMuted;
  final bool isItalic;
  final VoidCallback onTap;

  const _ItemRow({
    super.key,
    this.leading,
    required this.title,
    required this.count,
    this.isMuted = false,
    this.isItalic = false,
    required this.onTap,
  });

  @override
  Widget build(BuildContext context) {
    final muted = context.textTheme.bodySmall?.copyWith(
      color: context.colorScheme.onSurfaceVariant,
      fontFeatures: const [FontFeature.tabularFigures()],
    );
    return InkWell(
      onTap: onTap,
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 10),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.baseline,
          textBaseline: TextBaseline.alphabetic,
          children: [
            if (leading != null) SizedBox(width: 48, child: Text(leading!, style: muted)),
            Expanded(
              child: Text(
                title,
                style: context.textTheme.bodyMedium?.copyWith(
                  color: isMuted ? context.colorScheme.onSurfaceVariant : null,
                  fontStyle: isItalic ? FontStyle.italic : null,
                ),
              ),
            ),
            Text(count > 0 ? '$count' : '', style: muted),
          ],
        ),
      ),
    );
  }
}

class _LegRow extends StatelessWidget {
  final TripLegDto leg;

  /// Opens the leg; null outside edit mode
  final VoidCallback? onTap;

  const _LegRow({required this.leg, this.onTap});

  @override
  Widget build(BuildContext context) {
    final muted = context.textTheme.bodySmall?.copyWith(color: context.colorScheme.onSurfaceVariant);
    final row = Padding(
      padding: EdgeInsets.symmetric(horizontal: 16, vertical: onTap == null ? 2 : 8),
      child: Row(
        children: [
          SizedBox(
            width: 48,
            child: Icon(tripModeIcon(leg.mode), size: 16, color: context.colorScheme.onSurfaceVariant),
          ),
          Expanded(child: Text(tripLegLine(context.t, leg), style: muted)),
          if (onTap != null && leg.status == TripLegStatus.pending)
            const SizedBox.square(dimension: 14, child: CircularProgressIndicator(strokeWidth: 2))
          else if (onTap != null && leg.status == TripLegStatus.attention)
            Icon(
              Icons.error_outline,
              size: 16,
              color: context.colorScheme.error,
              semanticLabel: context.t.trips_leg_attention,
            ),
        ],
      ),
    );
    return onTap == null ? row : InkWell(key: ValueKey('trip-leg-row-${leg.id}'), onTap: onTap, child: row);
  }
}

class _Thumbnail extends ConsumerWidget {
  final TripData data;
  final TripPhoto photo;
  final bool isPicked;

  /// Picks or unpicks the asset; null outside edit mode
  final VoidCallback? onPick;

  /// Some asset is picked, so a tap picks instead of opening the viewer
  final bool isPicking;

  const _Thumbnail({
    required this.data,
    required this.photo,
    this.isPicked = false,
    this.onPick,
    this.isPicking = false,
  });

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final asset = data.assets[photo.id];
    if (asset == null) {
      return const SizedBox.shrink();
    }
    final onPick = this.onPick;
    return GestureDetector(
      key: ValueKey('trip-thumbnail-${photo.id}'),
      onLongPress: onPick,
      onTap: () {
        if (onPick != null && isPicking) {
          onPick();
          return;
        }
        // The viewer pages through every asset of the trip, in the trip's order (web TripPhoto `photos`).
        final assets = data.assetsOf(data.view.photos);
        final index = assets.indexWhere((candidate) => candidate.id == asset.id);
        AssetViewer.setAsset(ref, asset);
        unawaited(
          context.pushRoute(
            TripAssetViewerRoute(
              albumId: data.view.albumId,
              initialIndex: index < 0 ? 0 : index,
              timelineService: ref.read(timelineFactoryProvider).fromAssets(assets, TimelineOrigin.remoteAssets),
            ),
          ),
        );
      },
      child: isPicked ? _Picked(child: ThumbnailTile(asset)) : ThumbnailTile(asset),
    );
  }
}

/// A picked asset: inset, with a check, as Gallery's timeline shows it.
class _Picked extends StatelessWidget {
  final Widget child;

  const _Picked({required this.child});

  @override
  Widget build(BuildContext context) {
    return Container(
      key: const ValueKey('trip-thumbnail-picked'),
      color: context.colorScheme.primaryContainer,
      padding: const EdgeInsets.all(8),
      child: Stack(
        fit: StackFit.expand,
        children: [
          ClipRRect(borderRadius: BorderRadius.circular(12), child: child),
          Positioned(
            top: 4,
            left: 4,
            child: Icon(Icons.check_circle_rounded, color: context.colorScheme.primary, size: 22),
          ),
        ],
      ),
    );
  }
}
