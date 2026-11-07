import 'dart:async';
import 'dart:math' as math;
import 'dart:ui' as ui;

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

const _trailColors = {'green': '#3ddc84', 'yellow': '#ffd400'};

String _hex(int argb) => '#${(argb & 0xFFFFFF).toRadixString(16).padLeft(6, '0')}';

class TripMap extends StatefulWidget {
  final TripView view;

  /// A stop or transit item was tapped on the map.
  final void Function(TripItem item) onOpen;

  /// The item to bring into view, when it changes.
  final TripItem? focused;

  /// Space the bottom sheet covers, so fitting the route keeps it visible.
  final double bottomPadding;

  const TripMap({super.key, required this.view, required this.onOpen, this.focused, this.bottomPadding = 0});

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
    if (old.view != widget.view) {
      unawaited(_updateSources());
    }
    if (old.focused?.id != widget.focused?.id) {
      unawaited(_focus());
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
    if (layerId != 'trip-stops') {
      return;
    }
    for (final item in _view.order) {
      if (item.id == id) {
        widget.onOpen(item);
        return;
      }
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
    for (final id in ['trip-trails', 'trip-legs', 'trip-ends', 'trip-badges', 'trip-stops']) {
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
    for (final MapEntry(key: mode, value: style) in _styles.entries) {
      await controller.addLineLayer(
        'trip-legs',
        'trip-legs-${mode.toJson()}',
        LineLayerProperties(
          lineColor: ['get', 'color'],
          lineWidth: style.width,
          lineOpacity: style.opacity,
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
    await controller.addSymbolLayer('trip-badges', 'trip-badges', symbol, enableInteraction: false);
    await controller.addSymbolLayer('trip-stops', 'trip-stops', symbol);
    _isReady = true;
    await _updateSources();
    await _fit();
    await _focus();
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
    await controller.setGeoJsonSource('trip-legs', {
      'type': 'FeatureCollection',
      'features': [
        for (final leg in _view.legs)
          {
            'type': 'Feature',
            'geometry': {
              'type': 'LineString',
              'coordinates': [
                for (final (lat, lng) in leg.points) [lng, lat],
              ],
            },
            'properties': {'mode': leg.leg.mode.toJson(), 'color': _hex(leg.color)},
          },
      ],
    });
    await controller.setGeoJsonSource('trip-ends', {
      'type': 'FeatureCollection',
      'features': [
        for (final stop in _view.stops)
          if (stop.isEnd && stop.latitude != null && stop.longitude != null)
            {
              'type': 'Feature',
              'geometry': {
                'type': 'Point',
                'coordinates': [stop.longitude, stop.latitude],
              },
              'properties': {'color': _hex(_colorOf(stop.day))},
            },
      ],
    });

    final stops = <Map<String, Object?>>[];
    for (final item in _view.order) {
      final (latitude, longitude) = switch (item) {
        TripViewStop(:final latitude, :final longitude) => (latitude, longitude),
        TripTransit(:final latitude, :final longitude) => (latitude, longitude),
        TripUnplaced() => (null, null),
      };
      if (latitude == null || longitude == null || item.photos.isEmpty) {
        continue;
      }
      stops.add({
        'type': 'Feature',
        'id': item.id,
        'geometry': {
          'type': 'Point',
          'coordinates': [longitude, latitude],
        },
        'properties': {'image': _stopImage(item).name},
      });
    }
    await controller.setGeoJsonSource('trip-stops', {'type': 'FeatureCollection', 'features': stops});
    await _updateBadges();
  }

  int _colorOf(int day) =>
      _view.kind == TripKind.places || day >= _view.days.length ? tripPlacesColor : _view.days[day].color;

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
      if (!_badgeModes.contains(leg.leg.mode)) {
        continue;
      }
      final way = _view.transit
          .where((item) => item.fromStopId == leg.leg.fromStopId && item.toStopId == leg.leg.toStopId)
          .firstOrNull;
      final fraction = way != null && (way.fraction - 0.5).abs() < 0.15 ? (way.fraction < 0.5 ? 0.75 : 0.25) : 0.5;
      final (:at, :meters) = alongLine(leg.points, fraction);
      final metersPerPixel = 40075016.686 * math.cos(at.$1 * math.pi / 180) / math.pow(2, zoom + 8);
      if (meters / metersPerPixel < 90) {
        continue;
      }
      features.add({
        'type': 'Feature',
        'geometry': {
          'type': 'Point',
          'coordinates': [at.$2, at.$1],
        },
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
    name: 'trip-badge-${leg.color}-${leg.leg.mode.toJson()}',
    color: leg.color,
    text: '',
    icon: tripModeIcon(leg.leg.mode),
    small: false,
  );

  /// Every marker and badge image the view needs, each added once per style.
  Future<void> _addImages() async {
    final images = [
      for (final item in _view.order)
        if (item is! TripUnplaced) _stopImage(item),
      for (final leg in _view.legs)
        if (_badgeModes.contains(leg.leg.mode)) _badgeImage(leg),
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
    final size = (small ? 16.0 : 24.0) * unit;
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
    final points = [
      for (final stop in _view.stops)
        if (stop.latitude != null && stop.longitude != null) (stop.latitude!, stop.longitude!),
    ];
    if (points.isEmpty) {
      return;
    }
    final latitudes = points.map((point) => point.$1);
    final longitudes = points.map((point) => point.$2);
    final bounds = LatLngBounds(
      southwest: LatLng(latitudes.reduce(math.min), longitudes.reduce(math.min)),
      northeast: LatLng(latitudes.reduce(math.max), longitudes.reduce(math.max)),
    );
    await _controller?.moveCamera(
      CameraUpdate.newLatLngBounds(bounds, left: 40, top: 40, right: 40, bottom: 40 + widget.bottomPadding),
    );
    final zoom = _controller?.cameraPosition?.zoom;
    if (zoom != null && zoom > 15) {
      await _controller?.moveCamera(CameraUpdate.zoomTo(15));
    }
    await _updateBadges();
  }

  Future<void> _focus() async {
    final (latitude, longitude) = switch (widget.focused) {
      TripViewStop(:final latitude, :final longitude) => (latitude, longitude),
      TripTransit(:final latitude, :final longitude) => (latitude, longitude),
      _ => (null, null),
    };
    final controller = _controller;
    if (controller == null || latitude == null || longitude == null) {
      return;
    }
    final zoom = math.max(controller.cameraPosition?.zoom ?? 12, 12).toDouble();
    await controller.animateCamera(CameraUpdate.newLatLngZoom(LatLng(latitude, longitude), zoom));
  }

  @override
  Widget build(BuildContext context) {
    _ratio = MediaQuery.devicePixelRatioOf(context);
    return MapThemeOverride(
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
          onCameraIdle: () => unawaited(_updateBadges()),
          attributionButtonPosition: AttributionButtonPosition.bottomRight,
        ),
      ),
    );
  }
}
