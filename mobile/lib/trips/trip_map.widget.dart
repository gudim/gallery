import 'dart:async';
import 'dart:math' as math;
import 'dart:ui' as ui;

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:immich_mobile/extensions/asyncvalue_extensions.dart';
import 'package:immich_mobile/trips/trip_text.dart';
import 'package:immich_mobile/trips/trip_view.dart';
import 'package:immich_mobile/widgets/map/map_theme_override.dart';
import 'package:maplibre_gl/maplibre_gl.dart';
import 'package:openapi/api.dart';

// A trip's route on Gallery's map style (trips PLAN §2.9), after web/src/lib/trips/components/TripRouteLayers.svelte:
// legs coloured by day and styled by mode, each with its mode's badge, the start and finish, trails, and a numbered
// marker per stop with assets. Markers and badges are drawn into images, so they need no glyphs from the style.

typedef _LineStyle = ({double width, double opacity, List<double>? dash});

// Widths in px and dashes in line widths, after travel-album's leg styles.
const Map<TripLegMode, _LineStyle> _styles = {
  TripLegMode.driving: (width: 3.4, opacity: 0.85, dash: null),
  TripLegMode.flight: (width: 2.6, opacity: 0.8, dash: [3.8, 2.3]),
  TripLegMode.foot: (width: 3, opacity: 0.85, dash: [0.01, 1.7]),
  TripLegMode.direct: (width: 2, opacity: 0.45, dash: [2.5, 3.5]),
  TripLegMode.bus: (width: 2.4, opacity: 0.85, dash: null),
  TripLegMode.bicycle: (width: 3, opacity: 0.85, dash: [1.3, 1.3]),
  TripLegMode.train: (width: 3.6, opacity: 0.9, dash: [3, 0.6]),
  TripLegMode.boat: (width: 2.6, opacity: 0.85, dash: [5.4, 3.8]),
  TripLegMode.trail: (width: 3, opacity: 0.85, dash: null),
};

/// Modes whose legs carry a badge; a straight line and a trail are not a way of travelling.
const _badgeModes = {
  TripLegMode.foot,
  TripLegMode.driving,
  TripLegMode.bicycle,
  TripLegMode.bus,
  TripLegMode.train,
  TripLegMode.boat,
  TripLegMode.flight,
};

/// A stop marker's width in logical pixels; a way's marker is smaller.
const _markerSize = 24.0;

/// How much of its own opacity a leg keeps while another leg is open.
const _faded = 0.35;

const _trailColors = {'green': '#3ddc84', 'yellow': '#ffd400'};

String _hex(int argb) => '#${(argb & 0xFFFFFF).toRadixString(16).padLeft(6, '0')}';

class TripMap extends StatefulWidget {
  final TripView view;

  /// A stop or transit item was tapped on the map.
  final void Function(TripItem item) onOpen;

  /// A tap found several items under the finger: their ids, listed instead of opening one (web TripPage `onSelect`)
  final void Function(List<String> itemIds)? onSeveral;

  /// The item to bring into view, when it changes.
  final TripItem? focused;

  /// The leg opened in edit mode: it glows, the other legs fade, and the map shows it whole.
  final String? openLegId;

  /// A leg's badge was tapped; set in edit mode only, where a badge opens its leg (web TripRouteLayers `onOpenLeg`).
  final void Function(String legId)? onOpenLeg;

  /// Space the bottom sheet covers, so fitting the route keeps it visible.
  final double bottomPadding;

  /// A stop's pin being moved: the map centres here, and a fixed pin at its centre marks where the map is panned to.
  final LatLng? pin;

  /// Where the fixed pin points once the map stops moving.
  final ValueChanged<LatLng>? onPinMoved;

  const TripMap({
    super.key,
    required this.view,
    required this.onOpen,
    this.onSeveral,
    this.focused,
    this.openLegId,
    this.onOpenLeg,
    this.bottomPadding = 0,
    this.pin,
    this.onPinMoved,
  });

  @override
  State<TripMap> createState() => _TripMapState();
}

class _TripMapState extends State<TripMap> {
  MapLibreMapController? _controller;
  bool _isReady = false;

  /// Physical pixels per logical one, so markers are drawn sharp at their logical size.
  double _ratio = 1;
  final _images = <String, Future<void>>{};

  TripView get _view => widget.view;

  @override
  void didUpdateWidget(TripMap old) {
    super.didUpdateWidget(old);
    if (!_isReady) {
      return;
    }
    if (old.view != widget.view || old.openLegId != widget.openLegId) {
      unawaited(_updateSources());
    }
    if (old.openLegId != widget.openLegId) {
      unawaited(_fitLeg());
    }
    if (old.focused?.id != widget.focused?.id) {
      unawaited(_focus());
    }
    final pin = widget.pin;
    if (old.pin == null && pin != null) {
      unawaited(_startPinMove(pin));
    }
    if (old.pin != null && pin == null) {
      unawaited(_endPinMove());
    }
  }

  /// Puts back the bottom padding the move cleared (the sheet's height on the phone, none on the wide layout), so the
  /// open stop sits clear of the sheet again.
  Future<void> _endPinMove() async {
    await _controller?.setPadding(bottom: widget.bottomPadding);
    await _focus();
  }

  /// Centres the camera on the pin, which is drawn at the map's centre.
  Future<void> _startPinMove(LatLng pin) async {
    final controller = _controller;
    if (controller == null) {
      return;
    }
    // A fit leaves its padding on the camera (Android), and the camera's target would then sit above the pin drawn at
    // the map's centre, so the pin would save a point it does not show.
    await controller.setPadding();
    final zoom = math.max(controller.cameraPosition?.zoom ?? 15, 15).toDouble();
    await controller.animateCamera(CameraUpdate.newLatLngZoom(pin, zoom));
  }

  void _onCameraIdle() {
    unawaited(_updateBadges());
    final target = _controller?.cameraPosition?.target;
    if (widget.pin != null && target != null) {
      widget.onPinMoved?.call(target);
    }
  }

  @override
  void dispose() {
    _controller?.onFeatureTapped.remove(_onFeatureTapped);
    super.dispose();
  }

  void _onMapCreated(MapLibreMapController controller) {
    _controller = controller;
    controller.onFeatureTapped.add(_onFeatureTapped);
  }

  void _onFeatureTapped(math.Point<double> point, LatLng coordinates, String id, String layerId, Annotation? _) {
    if (layerId == 'trip-badges') {
      widget.onOpenLeg?.call(id);
      return;
    }
    if (layerId == 'trip-stops') {
      unawaited(_openAt(point, id));
    }
  }

  // Stop markers overlap rather than cluster, so a finger may cover several: every marker within a marker's reach of
  // the tap is listed, as the web lists the stops of a tapped cluster; one alone opens.
  Future<void> _openAt(math.Point<double> point, String tappedId) async {
    final controller = _controller;
    final ids = {tappedId};
    if (controller != null && widget.onSeveral != null) {
      // The plugin reports a tap in physical pixels on Android and in logical ones on iOS.
      final reach = _markerSize / 2 * (defaultTargetPlatform == TargetPlatform.android ? _ratio : 1);
      try {
        final features = await controller.queryRenderedFeaturesInRect(
          Rect.fromCenter(center: Offset(point.x, point.y), width: 2 * reach, height: 2 * reach),
          ['trip-stops'],
          null,
        );
        ids.addAll([
          for (final feature in features)
            if (feature case {'id': final String id}) id,
        ]);
      } catch (_) {
        // The tapped marker alone still opens.
      }
    }
    if (!mounted) {
      return;
    }
    final items = _view.itemsOf(ids);
    if (items.length > 1) {
      widget.onSeveral?.call([for (final item in items) item.id]);
    } else if (items.isNotEmpty) {
      widget.onOpen(items.first);
    }
  }

  Future<void> _onStyleLoaded() async {
    final controller = _controller;
    if (controller == null) {
      return;
    }
    // A theme switch loads a new style without our sources and images. The images go in before the layers that use
    // them: MapLibre Android drops an icon added in the same frame as data that shows it (maplibre_gl's
    // addGeoJsonSource notes the bug).
    _images.clear();
    await _addImages();
    const empty = {'type': 'FeatureCollection', 'features': <Object>[]};
    for (final id in ['trip-trails', 'trip-leg-open', 'trip-legs', 'trip-ends', 'trip-badges', 'trip-stops']) {
      await controller.addGeoJsonSource(id, empty);
    }
    await controller.addLineLayer(
      'trip-trails',
      'trip-trails',
      const LineLayerProperties(
        lineColor: ['get', 'color'],
        lineWidth: 3.4,
        lineOpacity: 0.9,
        lineCap: 'round',
        lineJoin: 'round',
      ),
      enableInteraction: false,
    );
    await controller.addLineLayer(
      'trip-leg-open',
      'trip-leg-open',
      const LineLayerProperties(
        lineColor: ['get', 'color'],
        lineWidth: 12,
        lineOpacity: 0.35,
        lineBlur: 2,
        lineCap: 'round',
        lineJoin: 'round',
      ),
      enableInteraction: false,
    );
    for (final MapEntry(key: mode, value: style) in _styles.entries) {
      await controller.addLineLayer(
        'trip-legs',
        'trip-legs-${mode.toJson()}',
        LineLayerProperties(
          lineColor: ['get', 'color'],
          lineWidth: style.width,
          lineOpacity: [
            '*',
            style.opacity,
            ['get', 'fade'],
          ],
          lineDasharray: style.dash,
          lineCap: 'round',
          lineJoin: 'round',
        ),
        filter: [
          '==',
          ['get', 'mode'],
          mode.toJson(),
        ],
        enableInteraction: false,
      );
    }
    await controller.addCircleLayer(
      'trip-ends',
      'trip-ends',
      const CircleLayerProperties(
        circleRadius: 6,
        circleColor: '#ffffff',
        circleStrokeColor: ['get', 'color'],
        circleStrokeWidth: 3,
      ),
      enableInteraction: false,
    );
    const symbol = SymbolLayerProperties(
      iconImage: ['get', 'image'],
      iconSize: 1,
      iconAllowOverlap: true,
      iconIgnorePlacement: true,
    );
    await controller.addSymbolLayer('trip-badges', 'trip-badges', symbol);
    await controller.addSymbolLayer('trip-stops', 'trip-stops', symbol);
    _isReady = true;
    await _updateSources();
    await _fit();
    await _focus();
    await _fitLeg();
  }

  Future<void> _updateSources() async {
    final controller = _controller;
    if (controller == null) {
      return;
    }
    await _addImages();
    await controller.setGeoJsonSource('trip-trails', {
      'type': 'FeatureCollection',
      'features': [
        for (final overlay in _view.overlays)
          if (overlay.kind == TripOverlayKind.trail && overlay.geometry['type'] == 'LineString')
            {
              'type': 'Feature',
              'geometry': overlay.geometry,
              'properties': {'color': _trailColors[overlay.color] ?? overlay.color ?? _trailColors['green']},
            },
      ],
    });
    final openLegId = widget.openLegId;
    Map<String, Object> legFeature(TripViewLeg leg) => {
      'type': 'Feature',
      'geometry': {
        'type': 'LineString',
        'coordinates': [for (final point in leg.points) _lngLat(point)],
      },
      'properties': {
        'mode': leg.mode.toJson(),
        'color': _hex(leg.color),
        'fade': openLegId == null || leg.id == openLegId ? 1 : _faded,
      },
    };
    await controller.setGeoJsonSource('trip-legs', {
      'type': 'FeatureCollection',
      'features': [for (final leg in _view.legs) legFeature(leg)],
    });
    await controller.setGeoJsonSource('trip-leg-open', {
      'type': 'FeatureCollection',
      'features': [
        for (final leg in _view.legs)
          if (leg.id == openLegId) legFeature(leg),
      ],
    });
    await controller.setGeoJsonSource('trip-ends', {
      'type': 'FeatureCollection',
      'features': [
        for (final stop in _view.stops)
          if (stop.point case final point? when stop.isEnd)
            {
              'type': 'Feature',
              'geometry': {'type': 'Point', 'coordinates': _lngLat(point)},
              'properties': {'color': _hex(_colorOf(stop.day))},
            },
      ],
    });

    final stops = <Map<String, Object?>>[];
    for (final item in _view.order) {
      final point = item.point;
      if (point == null || item.photos.isEmpty) {
        continue;
      }
      stops.add({
        'type': 'Feature',
        'id': item.id,
        'geometry': {'type': 'Point', 'coordinates': _lngLat(point)},
        'properties': {'image': _stopImage(item).name},
      });
    }
    await controller.setGeoJsonSource('trip-stops', {'type': 'FeatureCollection', 'features': stops});
    await _updateBadges();
  }

  /// GeoJSON orders a point's halves longitude first.
  static List<double> _lngLat(LatLng point) => [point.longitude, point.latitude];

  int _colorOf(int day) => _view.isPlaces || day >= _view.days.length ? tripPlacesColor : _view.days[day].color;

  // A leg's badge sits at its middle, or a quarter along when assets shot on the way are near the middle; it shows
  // only while the leg is at least ~90 px long on screen (travel-album map.js layoutBadges).
  Future<void> _updateBadges() async {
    final controller = _controller;
    if (controller == null) {
      return;
    }
    final zoom = controller.cameraPosition?.zoom ?? 0;
    final features = <Map<String, Object?>>[];
    for (final leg in _view.legs) {
      if (!_badgeModes.contains(leg.mode)) {
        continue;
      }
      final way = _view.transit
          .where((item) => item.fromStopId == leg.fromStopId && item.toStopId == leg.toStopId)
          .firstOrNull;
      final fraction = way != null && (way.fraction - 0.5).abs() < 0.15 ? (way.fraction < 0.5 ? 0.75 : 0.25) : 0.5;
      final (:at, :meters) = alongLine(leg.points, fraction);
      final metersPerPixel = 40075016.686 * math.cos(at.latitude * math.pi / 180) / math.pow(2, zoom + 8);
      if (meters / metersPerPixel < 90) {
        continue;
      }
      features.add({
        'type': 'Feature',
        'id': leg.id,
        'geometry': {'type': 'Point', 'coordinates': _lngLat(at)},
        'properties': {'image': _badgeImage(leg).name},
      });
    }
    await controller.setGeoJsonSource('trip-badges', {'type': 'FeatureCollection', 'features': features});
  }

  ({String name, int color, String text, IconData? icon, bool small}) _stopImage(TripItem item) {
    final color = _colorOf(item.day);
    final text = item is TripViewStop ? '${item.number ?? ''}' : '';
    return (name: 'trip-stop-$color-$text', color: color, text: text, icon: null, small: item is TripTransit);
  }

  ({String name, int color, String text, IconData? icon, bool small}) _badgeImage(TripViewLeg leg) => (
    name: 'trip-badge-${leg.color}-${leg.mode.toJson()}',
    color: leg.color,
    text: '',
    icon: tripModeIcon(leg.mode),
    small: false,
  );

  /// Every marker and badge image the view needs, each added once per style.
  Future<void> _addImages() async {
    final images = [
      for (final item in _view.order)
        if (item is! TripUnplaced) _stopImage(item),
      for (final leg in _view.legs)
        if (_badgeModes.contains(leg.mode)) _badgeImage(leg),
    ];
    await Future.wait([
      for (final image in images)
        _images.putIfAbsent(
          image.name,
          () => _image(image.name, image.color, text: image.text, icon: image.icon, small: image.small),
        ),
    ]);
  }

  /// A round marker in `color` with white or black ink, 24 logical pixels (16 for assets shot on
  /// the way), drawn at the screen's pixel ratio.
  Future<void> _image(String name, int color, {String text = '', IconData? icon, bool small = false}) async {
    final unit = _ratio;
    final size = (small ? 16.0 : _markerSize) * unit;
    final recorder = ui.PictureRecorder();
    final canvas = Canvas(recorder);
    final center = Offset(size / 2, size / 2);
    canvas.drawCircle(center, size / 2, Paint()..color = Colors.white);
    canvas.drawCircle(center, size / 2 - 2 * unit, Paint()..color = Color(color));
    final ink = isWhiteInkOn(color) ? Colors.white : Colors.black;
    final painter = TextPainter(
      textDirection: TextDirection.ltr,
      text: icon != null
          ? TextSpan(
              text: String.fromCharCode(icon.codePoint),
              style: TextStyle(fontFamily: icon.fontFamily, package: icon.fontPackage, fontSize: 14 * unit, color: ink),
            )
          : TextSpan(
              text: text,
              style: TextStyle(fontSize: 12 * unit, fontWeight: FontWeight.w600, color: ink),
            ),
    )..layout();
    painter.paint(canvas, center - Offset(painter.width / 2, painter.height / 2));
    final picture = recorder.endRecording();
    final rendered = await picture.toImage(size.toInt(), size.toInt());
    final bytes = await rendered.toByteData(format: ui.ImageByteFormat.png);
    await _controller?.addImage(name, bytes!.buffer.asUint8List());
  }

  /// The map fits the stops; the start, finish and legs may reach further.
  Future<void> _fit() async {
    final points = [for (final stop in _view.stops) ?stop.point];
    if (points.isEmpty) {
      return;
    }
    await _fitPoints(points, padding: 40, maxZoom: 15, isAnimated: false);
    await _updateBadges();
  }

  /// The map shows the whole open leg; one still being routed has no line yet.
  Future<void> _fitLeg() async {
    final points = _view.legById(widget.openLegId)?.points ?? const [];
    if (points.length >= 2) {
      await _fitPoints(points, padding: 60, maxZoom: 14, isAnimated: true);
    }
  }

  /// Fits the points above the bottom sheet, no closer than `maxZoom`.
  Future<void> _fitPoints(
    List<LatLng> points, {
    required double padding,
    required double maxZoom,
    required bool isAnimated,
  }) async {
    final controller = _controller;
    if (controller == null || points.isEmpty) {
      return;
    }
    final latitudes = points.map((point) => point.latitude);
    final longitudes = points.map((point) => point.longitude);
    final bounds = LatLngBounds(
      southwest: LatLng(latitudes.reduce(math.min), longitudes.reduce(math.min)),
      northeast: LatLng(latitudes.reduce(math.max), longitudes.reduce(math.max)),
    );
    Future<void> move(CameraUpdate update) async {
      await (isAnimated ? controller.animateCamera(update) : controller.moveCamera(update));
    }

    // The fit carries its own padding. On iOS the padding a pin move's end left on the camera would be added to it, so
    // the sheet's height would count twice; on Android the fit's padding replaces it.
    if (defaultTargetPlatform == TargetPlatform.iOS) {
      await controller.setPadding();
    }
    await move(
      CameraUpdate.newLatLngBounds(
        bounds,
        left: padding,
        top: padding,
        right: padding,
        bottom: padding + widget.bottomPadding,
      ),
    );
    final zoom = controller.cameraPosition?.zoom;
    if (zoom != null && zoom > maxZoom) {
      await move(CameraUpdate.zoomTo(maxZoom));
    }
  }

  Future<void> _focus() async {
    final point = widget.focused?.point;
    final controller = _controller;
    if (controller == null || point == null) {
      return;
    }
    final zoom = math.max(controller.cameraPosition?.zoom ?? 12, 12).toDouble();
    await controller.animateCamera(CameraUpdate.newLatLngZoom(point, zoom));
  }

  @override
  Widget build(BuildContext context) {
    _ratio = MediaQuery.devicePixelRatioOf(context);
    final map = MapThemeOverride(
      mapBuilder: (style) => style.widgetWhen(
        onData: (style) => MapLibreMap(
          initialCameraPosition: const CameraPosition(target: LatLng(0, 0), zoom: 1),
          compassEnabled: false,
          rotateGesturesEnabled: false,
          tiltGesturesEnabled: false,
          trackCameraPosition: true,
          styleString: style,
          onMapCreated: _onMapCreated,
          onStyleLoadedCallback: () => unawaited(_onStyleLoaded()),
          onCameraIdle: _onCameraIdle,
          attributionButtonPosition: AttributionButtonPosition.bottomRight,
        ),
      ),
    );
    const pinSize = 48.0;
    // One tree shape with the map first, pin or not: a new shape would rebuild the platform view, reloading the style.
    return Stack(
      children: [
        Positioned.fill(child: map),
        // The pin's tip sits on the map's centre; the map is panned under it.
        if (widget.pin != null)
          IgnorePointer(
            child: Center(
              child: Transform.translate(
                offset: const Offset(0, -pinSize / 2),
                child: Icon(
                  Icons.location_on,
                  key: const ValueKey('trip-pin'),
                  size: pinSize,
                  color: Theme.of(context).colorScheme.primary,
                  shadows: const [Shadow(blurRadius: 6, color: Colors.black54)],
                ),
              ),
            ),
          ),
      ],
    );
  }
}
