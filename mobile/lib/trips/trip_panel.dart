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
import 'package:immich_mobile/trips/trip_leg_edit.dart';
import 'package:immich_mobile/trips/trip_place_hints.dart';
import 'package:immich_mobile/trips/trip_route_actions.dart';
import 'package:immich_mobile/trips/trip_stop_edit.dart';
import 'package:immich_mobile/trips/trip_text.dart';
import 'package:immich_mobile/trips/trip_view.dart';
import 'package:openapi/api.dart';

// The trip's panel on the phone (trips PLAN §2.9), after web TripPanel.svelte: the trip's stops by day (or its places),
// an open stop with its assets, or an open leg; in edit mode with their editors.

/// Assets picked in the open stop's grid in edit mode (web assetMultiSelectManager), and the ways to change them.
class TripPicking {
  final List<String> ids;
  final void Function(String assetId) toggle;

  /// Picks just these assets, as a place hint's "Select" does
  final void Function(List<String> assetIds) only;
  final VoidCallback clear;

  const TripPicking({required this.ids, required this.toggle, required this.only, required this.clear});
}

class TripPanel extends ConsumerWidget {
  final TripData data;
  final TripItem? openItem;

  /// The leg opened in edit mode
  final TripLegDto? openLeg;
  final void Function(String legId) onOpenLeg;
  final bool isEditing;

  final TripPicking picking;
  final ScrollController? controller;
  final void Function(TripItem item) onOpen;
  final VoidCallback onBack;
  final void Function(TripViewStop stop) onMovePin;

  const TripPanel({
    super.key,
    required this.data,
    required this.openItem,
    required this.openLeg,
    required this.onOpenLeg,
    required this.isEditing,
    required this.picking,
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
                          TripPlaceHints(data: data, onSelect: picking.only, onMoved: picking.clear),
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
              padding: EdgeInsets.fromLTRB(2, 0, 2, picking.ids.isEmpty ? 24 : 96),
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
                    isPicked: picking.ids.contains(photo.id),
                    // In edit mode a long press picks, and while anything is picked a tap does too, as in Gallery.
                    onPick: !isEditing ? null : () => picking.toggle(photo.id),
                    isPicking: picking.ids.isNotEmpty,
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
                  if (isEditing) ...[const SizedBox(height: 8), TripRouteActions(data: data)],
                ],
              ),
            ),
          ),
          const SliverToBoxAdapter(child: Divider(height: 1)),
          SliverList.list(children: _rows(context, lang, ref.watch(tripPlaceSortProvider(view.albumId)))),
          const SliverToBoxAdapter(child: SizedBox(height: 24)),
        ],
      ],
    );
  }

  String _stopName(Translations t, String stopId) {
    final stop = view.stops.where((stop) => stop.id == stopId).firstOrNull;
    return stop == null ? '' : tripRowTitle(t, stop);
  }

  List<Widget> _rows(BuildContext context, String lang, TripPlaceSort placeSort) {
    final t = context.t;
    final rows = <Widget>[];
    switch (view.kind) {
      case TripKind.places:
        final places = tripPlaces(view, placeSort, isEditing: isEditing);
        rows.add(
          _Header(
            title: t.trips_places_title,
            sort: _PlaceSortToggle(albumId: view.albumId, sort: placeSort),
          ),
        );
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
                  leading: way.startTime,
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

  /// Sits at the header's end
  final Widget? sort;

  const _Header({required this.title, this.sort});

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: EdgeInsets.fromLTRB(16, sort == null ? 12 : 4, 16, 4),
      child: Row(
        children: [
          Expanded(child: Text(title, style: context.textTheme.titleSmall)),
          ?sort,
        ],
      ),
    );
  }
}

/// Lists places by frames or by name (web TripPanel's two sort buttons).
class _PlaceSortToggle extends ConsumerWidget {
  final String albumId;
  final TripPlaceSort sort;

  const _PlaceSortToggle({required this.albumId, required this.sort});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final t = context.t;
    Widget choice(TripPlaceSort value, String label) => ChoiceChip(
      key: ValueKey('trip-place-sort-${value.name}'),
      label: Text(label),
      selected: sort == value,
      showCheckmark: false,
      visualDensity: VisualDensity.compact,
      onSelected: (_) => ref.read(tripPlaceSortProvider(albumId).notifier).state = value,
    );
    return Wrap(
      spacing: 4,
      children: [choice(TripPlaceSort.frames, t.trips_sort_frames), choice(TripPlaceSort.name, t.trips_sort_name)],
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
      leading: isRoute ? stop.startTime : null,
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
