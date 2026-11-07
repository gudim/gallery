import 'dart:async';
import 'dart:math';

import 'package:flutter/material.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:immich_mobile/extensions/asyncvalue_extensions.dart';
import 'package:immich_mobile/extensions/build_context_extensions.dart';
import 'package:immich_mobile/extensions/maplibrecontroller_extensions.dart';
import 'package:immich_mobile/generated/translations.g.dart';
import 'package:immich_mobile/trips/trips_api.repository.dart';
import 'package:immich_mobile/widgets/common/immich_toast.dart';
import 'package:immich_mobile/widgets/map/map_theme_override.dart';
import 'package:maplibre_gl/maplibre_gl.dart';
import 'package:openapi/api.dart';

// Picks a point for a trip on the phone (trips PLAN §2.9), after web TripPointModal.svelte: a place found through
// Nominatim in the trip's language, or a tap on Gallery's map. A point that takes a name (a stop's) proposes the
// place's name; an asset's point does not.

/// Opens the picker full screen; null when the owner leaves without a point.
Future<TripPoint?> showTripPointPage(
  BuildContext context, {
  required String albumId,
  required String title,
  double? latitude,
  double? longitude,
  bool isNamed = false,
}) => Navigator.of(context).push<TripPoint>(
  MaterialPageRoute(
    fullscreenDialog: true,
    builder: (_) => TripPointPage(
      albumId: albumId,
      title: title,
      initial: latitude == null || longitude == null ? null : LatLng(latitude, longitude),
      isNamed: isNamed,
    ),
  ),
);

class TripPointPage extends ConsumerStatefulWidget {
  final String albumId;
  final String title;

  /// Where the map opens, and the point already set
  final LatLng? initial;

  /// The point takes a name (a stop)
  final bool isNamed;

  /// Stands in for the map in widget tests, where MapLibre's platform view does not run; it gets the tap handler.
  @visibleForTesting
  final Widget Function(void Function(LatLng point) onTap)? mapOverride;

  const TripPointPage({
    super.key,
    required this.albumId,
    required this.title,
    this.initial,
    this.isNamed = false,
    this.mapOverride,
  });

  @override
  ConsumerState<TripPointPage> createState() => _TripPointPageState();
}

class _TripPointPageState extends ConsumerState<TripPointPage> {
  static const searchDelay = Duration(milliseconds: 400);

  final _query = TextEditingController();
  final _name = TextEditingController();
  MapLibreMapController? _controller;

  /// Added once; a tap while it is still being added waits for it.
  Future<Symbol?>? _marker;
  LatLng? _point;
  List<TripGeoPlaceDto> _places = const [];
  bool _isSearching = false;
  Timer? _searchTimer;
  int _searchId = 0;

  @override
  void initState() {
    super.initState();
    _point = widget.initial;
  }

  @override
  void dispose() {
    _searchTimer?.cancel();
    _query.dispose();
    _name.dispose();
    super.dispose();
  }

  TripsApiRepository get _repository => ref.read(tripsApiRepositoryProvider);

  void _onSearch(String value) {
    _searchTimer?.cancel();
    final text = value.trim();
    if (text.isEmpty) {
      // A search still on its way answers a query that is gone.
      _searchId++;
      setState(() {
        _places = const [];
        _isSearching = false;
      });
      return;
    }
    setState(() => _isSearching = true);
    _searchTimer = Timer(searchDelay, () => unawaited(_search(text)));
  }

  Future<void> _search(String text) async {
    final id = ++_searchId;
    try {
      final places = await _repository.searchPlaces(widget.albumId, text);
      if (mounted && id == _searchId) {
        setState(() => _places = places);
      }
    } catch (_) {
      if (mounted && id == _searchId) {
        ImmichToast.show(context: context, msg: context.t.trips_place_search_failed, toastType: ToastType.error);
      }
    } finally {
      if (mounted && id == _searchId) {
        setState(() => _isSearching = false);
      }
    }
  }

  Future<void> _pick(LatLng point, {String? label}) async {
    setState(() => _point = point);
    await _showMarker(point);
    if (!widget.isNamed) {
      return;
    }
    if (label != null) {
      _name.text = label;
      return;
    }
    // A point tapped on the map takes the name Nominatim gives it, until the owner types one.
    final typed = _name.text;
    try {
      final places = await _repository.reversePlace(widget.albumId, point.latitude, point.longitude);
      if (mounted && places.isNotEmpty && _name.text == typed && _point == point) {
        _name.text = places.first.label;
      }
    } catch (_) {
      // Without a name the point is left to naming.
    }
  }

  void _onPlace(TripGeoPlaceDto place) {
    FocusScope.of(context).unfocus();
    final point = LatLng(place.latitude, place.longitude);
    setState(() {
      _places = const [];
      _query.clear();
    });
    unawaited(_controller?.animateCamera(CameraUpdate.newLatLngZoom(point, 13)));
    unawaited(_pick(point, label: place.label));
  }

  Future<void> _showMarker(LatLng point) async {
    final controller = _controller;
    if (controller == null) {
      return;
    }
    final marker = _marker;
    if (marker == null) {
      _marker = controller.addMarkerAtLatLng(point);
      await _marker;
      return;
    }
    final symbol = await marker;
    if (symbol != null) {
      await controller.updateSymbol(symbol, SymbolOptions(geometry: point));
    }
  }

  void _save() {
    final point = _point;
    if (point != null) {
      Navigator.of(
        context,
      ).pop(TripPoint(latitude: point.latitude, longitude: point.longitude, title: _name.text.trim()));
    }
  }

  @override
  Widget build(BuildContext context) {
    final t = context.t;
    final muted = context.textTheme.bodySmall?.copyWith(color: context.colorScheme.onSurfaceVariant);

    return Scaffold(
      appBar: AppBar(
        title: Text(widget.title),
        actions: [
          TextButton(
            key: const ValueKey('trip-point-save'),
            onPressed: _point == null ? null : _save,
            child: Text(t.save),
          ),
          const SizedBox(width: 8),
        ],
      ),
      body: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 8, 16, 4),
            child: TextField(
              key: const ValueKey('trip-point-search'),
              controller: _query,
              onChanged: _onSearch,
              textInputAction: TextInputAction.search,
              decoration: InputDecoration(
                prefixIcon: const Icon(Icons.search),
                hintText: t.trips_point_search,
                suffixIcon: _isSearching
                    ? const Padding(
                        padding: EdgeInsets.all(12),
                        child: SizedBox.square(dimension: 20, child: CircularProgressIndicator(strokeWidth: 2)),
                      )
                    : null,
              ),
            ),
          ),
          Expanded(
            child: Stack(
              children: [
                Positioned.fill(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: [
                      Padding(
                        padding: const EdgeInsets.fromLTRB(16, 4, 16, 8),
                        child: Text(t.trips_point_hint_tap, style: muted),
                      ),
                      Expanded(child: _map()),
                    ],
                  ),
                ),
                if (_places.isNotEmpty)
                  // Scrolls when the keyboard leaves less room than the results need.
                  Positioned.fill(
                    left: 16,
                    right: 16,
                    child: Align(
                      alignment: Alignment.topCenter,
                      child: Material(
                        elevation: 6,
                        borderRadius: BorderRadius.circular(12),
                        clipBehavior: Clip.antiAlias,
                        child: ListView(
                          shrinkWrap: true,
                          padding: EdgeInsets.zero,
                          children: [
                            for (final place in _places)
                              ListTile(
                                key: ValueKey('trip-point-place-${place.latitude},${place.longitude}'),
                                title: Text(place.label, maxLines: 1, overflow: TextOverflow.ellipsis),
                                subtitle: Text(
                                  [
                                    place.region,
                                    place.country,
                                  ].whereType<String>().where((s) => s.isNotEmpty).join(', '),
                                  maxLines: 1,
                                  overflow: TextOverflow.ellipsis,
                                ),
                                onTap: () => _onPlace(place),
                              ),
                          ],
                        ),
                      ),
                    ),
                  ),
              ],
            ),
          ),
          if (widget.isNamed)
            SafeArea(
              top: false,
              child: Padding(
                padding: const EdgeInsets.fromLTRB(16, 12, 16, 12),
                child: TextField(
                  key: const ValueKey('trip-point-name'),
                  controller: _name,
                  decoration: InputDecoration(
                    labelText: t.trips_point_name,
                    hintText: t.trips_point_name_hint,
                    floatingLabelBehavior: FloatingLabelBehavior.always,
                  ),
                ),
              ),
            ),
        ],
      ),
    );
  }

  Widget _map() {
    final override = widget.mapOverride;
    if (override != null) {
      return override((point) => unawaited(_pick(point)));
    }
    final initial = widget.initial;
    return MapThemeOverride(
      mapBuilder: (style) => style.widgetWhen(
        onData: (style) => MapLibreMap(
          initialCameraPosition: CameraPosition(target: initial ?? const LatLng(0, 0), zoom: initial == null ? 1 : 12),
          compassEnabled: false,
          rotateGesturesEnabled: false,
          tiltGesturesEnabled: false,
          styleString: style,
          onMapCreated: (controller) => _controller = controller,
          onStyleLoadedCallback: () {
            final point = _point;
            if (point != null) {
              _marker = null;
              unawaited(_showMarker(point));
            }
          },
          onMapClick: (Point<num> _, LatLng point) => unawaited(_pick(point)),
          attributionButtonPosition: AttributionButtonPosition.bottomRight,
        ),
      ),
    );
  }
}
