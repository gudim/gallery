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
import 'package:immich_mobile/trips/trip_map.widget.dart';
import 'package:immich_mobile/trips/trip_text.dart';
import 'package:immich_mobile/trips/trip_view.dart';
import 'package:openapi/api.dart';

// A trip on the phone (trips PLAN §2.9), after web/src/lib/trips/components/TripPage.svelte and TripPanel.svelte:
// Gallery's map with the route, and the stops in a sheet over it (beside it on a tablet). A stop opens its assets,
// and an asset opens Gallery's viewer over every asset of the trip, with likes.

@RoutePage()
class TripPage extends ConsumerStatefulWidget {
  final String albumId;
  final String title;

  const TripPage({super.key, required this.albumId, required this.title});

  @override
  ConsumerState<TripPage> createState() => _TripPageState();
}

class _TripPageState extends ConsumerState<TripPage> {
  static const _wideWidth = 600.0;

  String? _openId;

  void _open(TripItem item) => setState(() => _openId = item.id);

  void _back() => setState(() => _openId = null);

  @override
  Widget build(BuildContext context) {
    final data = ref.watch(tripDataProvider(widget.albumId));
    // Keeps the likes alive while the viewer is open over this page.
    ref.watch(tripLikesProvider(widget.albumId));

    return PopScope(
      canPop: _openId == null,
      onPopInvokedWithResult: (didPop, _) {
        if (!didPop) {
          _back();
        }
      },
      child: Scaffold(
        appBar: AppBar(title: Text(widget.title)),
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
    final view = data.view;
    final openItem = _openId == null ? null : _find(view, _openId!);

    Widget panel(ScrollController? controller) =>
        _TripPanel(data: data, openItem: openItem, controller: controller, onOpen: _open, onBack: _back);

    if (view.kind == TripKind.plain) {
      return panel(null);
    }

    return LayoutBuilder(
      builder: (context, constraints) {
        if (constraints.maxWidth >= _wideWidth) {
          return Row(
            children: [
              Expanded(
                flex: 2,
                child: TripMap(view: view, onOpen: _open, focused: openItem),
              ),
              const VerticalDivider(width: 1),
              Expanded(child: panel(null)),
            ],
          );
        }
        const initialSize = 0.45;
        return Stack(
          children: [
            Positioned.fill(
              child: TripMap(
                view: view,
                onOpen: _open,
                focused: openItem,
                bottomPadding: constraints.maxHeight * initialSize,
              ),
            ),
            DraggableScrollableSheet(
              initialChildSize: initialSize,
              minChildSize: 0.15,
              maxChildSize: 0.95,
              snap: true,
              snapSizes: const [initialSize],
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
  final ScrollController? controller;
  final void Function(TripItem item) onOpen;
  final VoidCallback onBack;

  const _TripPanel({
    required this.data,
    required this.openItem,
    required this.controller,
    required this.onOpen,
    required this.onBack,
  });

  TripView get view => data.view;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final t = context.t;
    final lang = context.locale.toLanguageTag();
    final item = openItem;
    final muted = context.textTheme.bodySmall?.copyWith(color: context.colorScheme.onSurfaceVariant);
    final isSheet = controller != null;

    return CustomScrollView(
      controller: controller,
      slivers: [
        if (isSheet) const SliverToBoxAdapter(child: _Handle()),
        if (item != null) ...[
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
                        if (item is TripViewStop && item.story.isNotEmpty) ...[
                          const SizedBox(height: 8),
                          Text(item.story, maxLines: 6, overflow: TextOverflow.ellipsis),
                        ],
                        if (item is TripUnplaced) ...[const SizedBox(height: 8), Text(t.trips_unplaced_note)],
                        if (item is TripViewStop && item.article != null && item.article!.isNotEmpty)
                          _Article(text: item.article!),
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
              padding: const EdgeInsets.fromLTRB(2, 0, 2, 24),
              sliver: SliverGrid(
                gridDelegate: const SliverGridDelegateWithMaxCrossAxisExtent(
                  maxCrossAxisExtent: 120,
                  mainAxisSpacing: 2,
                  crossAxisSpacing: 2,
                ),
                delegate: SliverChildBuilderDelegate(
                  childCount: item.photos.length,
                  (context, index) => _Thumbnail(data: data, photo: item.photos[index]),
                ),
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

  List<Widget> _rows(BuildContext context, String lang) {
    final t = context.t;
    final rows = <Widget>[];
    switch (view.kind) {
      case TripKind.places:
        final places = view.stops.where((stop) => stop.photos.isNotEmpty).toList()
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
              .where((stop) => stop.photos.isNotEmpty)
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
            for (final leg in view.legs.where((leg) => leg.leg.fromStopId == stop.id)) {
              rows.add(_LegRow(leg: leg.leg));
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

  const _LegRow({required this.leg});

  @override
  Widget build(BuildContext context) {
    final muted = context.textTheme.bodySmall?.copyWith(color: context.colorScheme.onSurfaceVariant);
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 2),
      child: Row(
        children: [
          SizedBox(
            width: 48,
            child: Icon(tripModeIcon(leg.mode), size: 16, color: context.colorScheme.onSurfaceVariant),
          ),
          Expanded(child: Text(tripLegLine(context.t, leg), style: muted)),
        ],
      ),
    );
  }
}

class _Thumbnail extends ConsumerWidget {
  final TripData data;
  final TripPhoto photo;

  const _Thumbnail({required this.data, required this.photo});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final asset = data.assets[photo.id];
    if (asset == null) {
      return const SizedBox.shrink();
    }
    return GestureDetector(
      onTap: () {
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
      child: ThumbnailTile(asset),
    );
  }
}
