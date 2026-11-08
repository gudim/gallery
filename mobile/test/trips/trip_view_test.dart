import 'package:flutter_test/flutter_test.dart';
import 'package:immich_mobile/trips/trip_view.dart';
import 'package:maplibre_gl/maplibre_gl.dart' show LatLng;
import 'package:openapi/api.dart';

// Ported from web/src/lib/trips/trip-view.spec.ts, so both clients derive the same screen from the same trip.

DateTime _at(String iso) => DateTime.parse(iso);

TripStopDto _stop(
  String id, {
  TripStopRole? role,
  String? localStart,
  String? localEnd,
  String? region,
  String country = 'Lithuania',
  String? placeId,
  bool? isTransit,
}) => TripStopDto(
  id: id,
  placeId: placeId,
  latitude: 54.68,
  longitude: 25.28,
  isPositionManual: false,
  sequence: 0,
  title: id,
  titleSource: null,
  story: null,
  storySource: null,
  region: region,
  country: country,
  isAddedByHand: false,
  role: role,
  isFinishAtStart: false,
  isTransit: isTransit,
  isAtCenter: false,
  localStart: localStart == null ? null : _at(localStart),
  localEnd: localEnd == null ? null : _at(localEnd),
);

TripLegDto _leg(
  String id,
  String fromStopId,
  String toStopId, {
  TripLegMode mode = TripLegMode.driving,
  String? polyline = '_izlhA~rlgdFo}@?',
  double distance = 1000,
}) => TripLegDto(
  id: id,
  fromStopId: fromStopId,
  toStopId: toStopId,
  mode: mode,
  isModeManual: false,
  status: TripLegStatus.ok,
  // (38.5, -120.2) → (38.501, -120.2), at precision 6
  polyline: polyline,
  distance: distance,
  duration: 60,
  departureName: null,
  departureLatitude: null,
  departureLongitude: null,
  arrivalName: null,
  arrivalLatitude: null,
  arrivalLongitude: null,
);

TripAssetDto _filing(String assetId, String? stopId, {double? latitude, double? longitude, TripPointSource? source}) =>
    TripAssetDto(assetId: assetId, stopId: stopId, latitude: latitude, longitude: longitude, pointSource: source);

TripAssetInfo _asset(String id, String localDateTime, {bool isVideo = false}) =>
    TripAssetInfo(id: id, localDateTime: _at(localDateTime), isVideo: isVideo, point: const LatLng(1, 2));

// Start, day one: A, shot on the way, B; day two: C; finish. D has no assets.
TripResponseDto _trip() => TripResponseDto(
  albumId: 'album',
  kind: TripKind.route,
  isFavorites: false,
  isShowcased: false,
  isFeatured: false,
  language: null,
  contentVersion: 1,
  isNaming: false,
  places: [TripPlaceDto(id: 'p', key: 'p', title: null, article: 'An article', articleSource: null)],
  stops: [
    _stop('start', role: TripStopRole.start),
    _stop(
      'a',
      localStart: '2026-08-08T10:00:00.000Z',
      localEnd: '2026-08-08T11:00:00.000Z',
      region: 'Vilnius',
      placeId: 'p',
    ),
    _stop('way', localStart: '2026-08-08T12:00:00.000Z', isTransit: true),
    _stop('b', localStart: '2026-08-08T14:00:00.000Z', localEnd: '2026-08-08T14:00:00.000Z', region: 'Biržai'),
    _stop('c', localStart: '2026-08-09T09:00:00.000Z', region: 'Riga', country: 'Latvia'),
    _stop('d', localStart: '2026-08-09T12:00:00.000Z'),
    _stop('finish', role: TripStopRole.finish),
  ],
  assets: [
    _filing('a1', 'a'),
    _filing('a2', 'a', latitude: 5, longitude: 6, source: TripPointSource.inferred),
    _filing('w1', 'way'),
    _filing('b1', 'b'),
    _filing('c1', 'c'),
  ],
  legs: [
    _leg('l1', 'start', 'a', mode: TripLegMode.foot),
    _leg('l2', 'a', 'b'),
    _leg('l3', 'b', 'c', polyline: null, distance: 2500),
    _leg('l4', 'c', 'finish'),
  ],
  overlays: [],
  likes: [TripLikeDto(assetId: 'b1', count: 3, isLiked: true)],
);

final _assets = [
  _asset('a1', '2026-08-08T10:05:00.000Z'),
  _asset('a2', '2026-08-08T10:50:00.000Z', isVideo: true),
  _asset('w1', '2026-08-08T13:00:00.000Z'),
  _asset('b1', '2026-08-08T14:00:00.000Z'),
  _asset('c1', '2026-08-09T09:30:00.000Z'),
];

void main() {
  group('buildTripView', () {
    test('splits a route into days, numbers stops with assets and orders transit after its stop', () {
      final view = buildTripView(_trip(), _assets);

      expect(view.days.map((day) => (day.date, day.color, day.count)).toList(), [
        ('2026-08-08', 0xFFE6394A, 4),
        ('2026-08-09', 0xFFF2792B, 1),
      ]);
      expect(view.days.map((day) => day.regions).toList(), [
        ['Vilnius', 'Biržai'],
        ['Riga'],
      ]);
      expect(view.stops.map((stop) => (stop.id, stop.number, stop.day, stop.startTime, stop.endTime)).toList(), [
        ('start', null, 0, '—', '—'),
        ('a', 1, 0, '10:00', '11:00'),
        ('b', 2, 0, '14:00', '14:00'),
        ('c', 3, 1, '09:00', '09:00'),
        ('d', null, 1, '12:00', '12:00'),
        ('finish', null, 1, '—', '—'),
      ]);
      expect(view.order.map((item) => item.id).toList(), ['a', 'way', 'b', 'c']);
      expect(view.photos.map((photo) => photo.id).toList(), ['a1', 'a2', 'w1', 'b1', 'c1']);
      expect(view.isMultiCountry, isTrue);
      expect(view.stops[1].article, 'An article');
    });

    test('puts assets shot on the way on the leg between the stops around them', () {
      final way = buildTripView(_trip(), _assets).transit.single;

      expect((way.fromStopId, way.toStopId, way.day, way.startTime), ('a', 'b', 0, '13:00'));
      expect(way.stopIds, ['way']);
      // 13:00 between the end of A (11:00) and the start of B (14:00)
      expect(way.fraction, 0.667);
    });

    test('draws legs with a line, counts every leg in km and carries likes and points', () {
      final view = buildTripView(_trip(), _assets);

      expect(view.legs.map((leg) => (leg.leg.id, leg.day, leg.color)).toList(), [
        ('l1', 0, tripDayColors[0]),
        ('l2', 0, tripDayColors[0]),
        ('l4', 1, tripDayColors[1]),
      ]);
      expect(view.km, 6);
      expect(tripStats(view), (assets: 5, videos: 1, stops: 3, days: 2, km: 6));
      final [a1, a2, _, b1, _] = view.photos;
      expect((a1.point, a1.isInferred, a1.time, a1.likes), (const LatLng(1, 2), false, '10:05', 0));
      expect((a2.point, a2.isInferred, a2.isVideo), (const LatLng(5, 6), true, true));
      expect((b1.likes, b1.isLiked), (3, true));
    });

    test('colours each leg of a one-day trip on its own, counting legs without a line', () {
      final oneDay = _trip();
      oneDay.stops = oneDay.stops.where((stop) => stop.id != 'c' && stop.id != 'd').toList();
      oneDay.assets = oneDay.assets.where((filing) => filing.assetId != 'c1').toList();

      final view = buildTripView(oneDay, _assets);

      expect(view.days, hasLength(1));
      expect(view.legs.map((leg) => (leg.leg.id, leg.color)).toList(), [
        ('l1', tripDayColors[0]),
        ('l2', tripDayColors[1]),
        ('l4', tripDayColors[3]),
      ]);
    });

    test('skips trip assets the caller cannot see', () {
      final view = buildTripView(_trip(), _assets.sublist(1));

      expect(view.stops[1].photos.map((photo) => photo.id).toList(), ['a2']);
    });

    test('gives a Places trip no days or legs, and keeps its unplaced assets', () {
      final places = _trip()
        ..kind = TripKind.places
        ..legs = [];
      places.stops = places.stops.where((stop) => stop.role == null && stop.isTransit != true).toList();
      places.assets = [...places.assets.where((filing) => filing.assetId != 'w1'), _filing('w1', null)];

      final view = buildTripView(places, _assets);

      expect(view.days, isEmpty);
      expect(view.legs, isEmpty);
      expect(view.km, isNull);
      expect(view.unplaced?.photos.map((photo) => photo.id).toList(), ['w1']);
      expect(view.order.last, isA<TripUnplaced>());
    });

    test('lists places by frames with ties by id, or by name; edit mode lists empty places too', () {
      final places = _trip()
        ..kind = TripKind.places
        ..legs = [];
      places.stops = places.stops.where((stop) => stop.role == null && stop.isTransit != true).toList();
      places.stops.firstWhere((stop) => stop.id == 'c').title = 'Anykščiai';
      places.stops.firstWhere((stop) => stop.id == 'd').title = 'Zarasai';
      // Sorted among the E's, as the web's localeCompare does, not after the Z.
      places.stops.firstWhere((stop) => stop.id == 'b').title = 'Ėriškiai';
      final view = buildTripView(places, _assets);
      List<String> ids(TripPlaceSort sort, {bool isEditing = false}) =>
          tripPlaces(view, sort, isEditing: isEditing).map((stop) => stop.id).toList();

      expect(ids(TripPlaceSort.frames), ['a', 'b', 'c']);
      expect(ids(TripPlaceSort.frames, isEditing: true), ['a', 'b', 'c', 'd']);
      expect(ids(TripPlaceSort.name), ['a', 'c', 'b']);
      expect(ids(TripPlaceSort.name, isEditing: true), ['a', 'c', 'b', 'd']);
    });
  });

  group('helpers', () {
    test('decodes an encoded polyline', () {
      expect(decodePolyline('_izlhA~rlgdF'), const [LatLng(38.5, -120.2)]);
      expect(decodePolyline('_p~iF~ps|U_ulLnnqC_mqNvxq`@', precision: 5), const [
        LatLng(38.5, -120.2),
        LatLng(40.7, -120.95),
        LatLng(43.252, -126.453),
      ]);
    });

    test('finds a point along a line and its length', () {
      final (:at, :meters) = alongLine(const [LatLng(0, 0), LatLng(0, 1), LatLng(0, 3)], 0.5);

      expect(at.latitude, closeTo(0, 1e-9));
      expect(at.longitude, closeTo(1.5, 1e-9));
      expect(meters / 1000, closeTo(333.6, 0.5));
      expect(alongLine(const [LatLng(1, 2)], 0.5), (at: const LatLng(1, 2), meters: 0.0));
    });

    test('places transit in the middle when times are missing', () {
      expect(transitFraction(_stop('x'), _stop('y'), []), 0.5);
    });

    test('picks text colour and time spans', () {
      expect(isWhiteInkOn(0xFF5C6BC0), isTrue);
      expect(isWhiteInkOn(0xFFE8B32C), isFalse);
      final stop = buildTripView(_trip(), _assets).stops;
      expect(tripTimeSpan(stop[2]), '14:00');
      expect(tripTimeSpan(stop[1]), '10:00–11:00');
    });
  });
}
