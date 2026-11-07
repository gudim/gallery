import 'dart:math' as math;

import 'package:immich_mobile/extensions/string_extensions.dart';
import 'package:openapi/api.dart';

// What the trip screen shows, derived from the trip read and the album's assets (trips PLAN §2.9). Ported from
// web/src/lib/trips/trip-view.ts, which ports travel-album's atlas/albums/payload.py.

/// Day colours, by day index (travel-album payload.py DAYCOL).
const tripDayColors = [
  0xFFE6394A,
  0xFFF2792B,
  0xFFE8B32C,
  0xFF7CB342,
  0xFF26A69A,
  0xFF2196F3,
  0xFF5C6BC0,
  0xFF8E5FD6,
  0xFFD94F9C,
  0xFF8D6E63,
  0xFF546E7A,
];

/// The one pin colour of a Places trip, which has no days.
const tripPlacesColor = 0xFF2196F3;

/// What the trip needs of an album asset. `localDateTime` is the wall clock, carried as UTC as the server sends it.
class TripAssetInfo {
  final String id;
  final DateTime? localDateTime;
  final bool isVideo;
  final double? latitude;
  final double? longitude;

  const TripAssetInfo({required this.id, this.localDateTime, this.isVideo = false, this.latitude, this.longitude});
}

/// `YYYY-MM-DD` of a wall-clock time, or ''.
String tripLocalDate(DateTime? time) => time == null ? '' : time.toUtc().toIso8601String().substring(0, 10);

/// `HH:MM` of a wall-clock time, or ''.
String tripLocalTime(DateTime? time) => time == null ? '' : time.toUtc().toIso8601String().substring(11, 16);

class TripPhoto {
  final String id;
  final TripAssetInfo asset;
  final String time;
  final String date;
  final bool isVideo;

  /// The point was inferred from neighbours in time
  final bool isInferred;
  final double? latitude;
  final double? longitude;
  final int likes;
  final bool isLiked;

  const TripPhoto({
    required this.id,
    required this.asset,
    required this.time,
    required this.date,
    required this.isVideo,
    required this.isInferred,
    required this.latitude,
    required this.longitude,
    required this.likes,
    required this.isLiked,
  });
}

class TripDay {
  final String date;
  final int color;

  /// Assets of the day's stops and of the legs between them
  int count;

  /// Distinct regions of the day's stops, in trip order
  final List<String> regions;

  TripDay({required this.date, required this.color, required this.count, required this.regions});
}

sealed class TripItem {
  String get id;
  int get day;
  List<TripPhoto> get photos;
  int videoCount = 0;

  /// Where the item sits on the map; null for Unplaced and for a stop without a position.
  double? get latitude => null;
  double? get longitude => null;

  /// `HH:MM` of the first and last asset, or of the stop's window; '—' when there is none (web `t0`, `t1`)
  String startTime = '—';
  String endTime = '—';

  void _span() {
    videoCount = photos.where((photo) => photo.isVideo).length;
    startTime = photos.isEmpty || photos.first.time.isEmpty ? '—' : photos.first.time;
    endTime = photos.isEmpty || photos.last.time.isEmpty ? '—' : photos.last.time;
  }
}

class TripViewStop extends TripItem {
  @override
  final String id;
  @override
  final int day;
  @override
  final List<TripPhoto> photos;
  final TripStopDto stop;
  final String title;
  final String story;
  final String region;
  final String country;
  @override
  final double? latitude;
  @override
  final double? longitude;
  final String date;

  /// 1-based among stops with assets; start, finish and empty stops have none
  int? number;
  final bool isEnd;
  final String? article;
  final String? placeId;

  TripViewStop({
    required this.id,
    required this.day,
    required this.photos,
    required this.stop,
    required this.title,
    required this.story,
    required this.region,
    required this.country,
    required this.latitude,
    required this.longitude,
    required this.date,
    required this.isEnd,
    required this.article,
    required this.placeId,
  });
}

/// Assets shot on the way between two stops, shown on the leg between them.
class TripTransit extends TripItem {
  @override
  final String id;
  @override
  final int day;
  @override
  final List<TripPhoto> photos = [];
  final String fromStopId;
  final String toStopId;
  final List<String> stopIds = [];
  @override
  final double? latitude;
  @override
  final double? longitude;

  /// Where on the leg, as a share of its length (0.05–0.95)
  double fraction = 0.5;

  TripTransit({
    required this.id,
    required this.day,
    required this.fromStopId,
    required this.toStopId,
    required this.latitude,
    required this.longitude,
  });
}

class TripUnplaced extends TripItem {
  @override
  String get id => 'unplaced';
  @override
  int get day => 0;
  @override
  final List<TripPhoto> photos;

  TripUnplaced(this.photos);
}

/// `color` is the day's, or on a one-day trip the leg's own, so legs that meet stay apart.
class TripViewLeg {
  final TripLegDto leg;
  final int day;
  final int color;

  /// [latitude, longitude] points
  final List<(double, double)> points;

  const TripViewLeg({required this.leg, required this.day, required this.color, required this.points});
}

class TripView {
  final TripKind kind;
  final String albumId;
  final List<TripViewStop> stops;
  final List<TripDay> days;
  final List<TripViewLeg> legs;
  final List<TripTransit> transit;
  final TripUnplaced? unplaced;

  /// Stops with assets, each followed by the transit after it, then Unplaced: the order of every view
  final List<TripItem> order;

  /// Every shown asset in `order`: the viewer pages through these
  final List<TripPhoto> photos;
  final int? km;
  final List<TripOverlayDto> overlays;

  /// Stops span more than one country, so meta lines name it
  final bool isMultiCountry;

  const TripView({
    required this.kind,
    required this.albumId,
    required this.stops,
    required this.days,
    required this.legs,
    required this.transit,
    required this.unplaced,
    required this.order,
    required this.photos,
    required this.km,
    required this.overlays,
    required this.isMultiCountry,
  });
}

/// Decodes an encoded polyline into [latitude, longitude] points. Trip legs use precision 6, as Valhalla does.
List<(double, double)> decodePolyline(String encoded, {int precision = 6}) {
  final factor = math.pow(10, precision);
  final points = <(double, double)>[];
  var index = 0;
  var lat = 0;
  var lng = 0;
  while (index < encoded.length) {
    for (final axis in [0, 1]) {
      var result = 0;
      var shift = 0;
      int byte;
      do {
        byte = encoded.codeUnitAt(index++) - 63;
        result |= (byte & 0x1f) << shift;
        shift += 5;
      } while (byte >= 0x20 && index < encoded.length);
      final delta = result & 1 == 1 ? ~(result >> 1) : result >> 1;
      if (axis == 0) {
        lat += delta;
      } else {
        lng += delta;
      }
    }
    points.add((lat / factor, lng / factor));
  }
  return points;
}

/// Where on the leg a → b the assets were shot: the median time as a share of the way, 0.05–0.95.
double transitFraction(TripStopDto from, TripStopDto to, List<DateTime?> times) {
  final start = (from.localEnd ?? from.localStart)?.millisecondsSinceEpoch;
  final end = to.localStart?.millisecondsSinceEpoch;
  final shots = times.whereType<DateTime>().map((time) => time.millisecondsSinceEpoch).toList()..sort();
  if (start == null || end == null || end <= start || shots.isEmpty) {
    return 0.5;
  }
  final middle = shots.length ~/ 2;
  final median = shots.length.isOdd ? shots[middle].toDouble() : (shots[middle - 1] + shots[middle]) / 2;
  final share = (median - start) / (end - start);
  return (share.clamp(0.05, 0.95) * 1000).round() / 1000;
}

/// Builds the screen's model. `assets` are the album's assets as the caller may see them; trip assets missing from it
/// are skipped, so the model never names an asset the caller cannot open.
TripView buildTripView(TripResponseDto trip, List<TripAssetInfo> assets) {
  final kind = trip.kind;
  final assetById = {for (final asset in assets) asset.id: asset};
  final likes = {for (final like in trip.likes) like.assetId: like};
  final articles = {for (final place in trip.places) place.id: place.article};

  final photosByStop = <String?, List<TripPhoto>>{};
  for (final filing in trip.assets) {
    final asset = assetById[filing.assetId];
    if (asset == null) {
      continue;
    }
    final like = likes[asset.id];
    photosByStop
        .putIfAbsent(filing.stopId, () => [])
        .add(
          TripPhoto(
            id: asset.id,
            asset: asset,
            time: tripLocalTime(asset.localDateTime),
            date: tripLocalDate(asset.localDateTime),
            isVideo: asset.isVideo,
            isInferred: filing.pointSource == TripPointSource.inferred,
            latitude: filing.latitude ?? asset.latitude,
            longitude: filing.longitude ?? asset.longitude,
            likes: like?.count ?? 0,
            isLiked: like?.isLiked ?? false,
          ),
        );
  }

  // A Plain trip has no start or finish; a Places trip's start is its centre.
  final stops = kind == TripKind.plain ? trip.stops.where((stop) => stop.role == null).toList() : trip.stops;
  final real = stops.where((stop) => stop.isTransit != true).toList();

  final dates = kind == TripKind.places
      ? <String>[]
      : (real
            .where((stop) => stop.role == null && stop.localStart != null)
            .map((stop) => tripLocalDate(stop.localStart))
            .toSet()
            .toList()
          ..sort());
  final dayIndex = {for (final (index, date) in dates.indexed) date: index};

  final viewStops = real.map((stop) {
    final photos = photosByStop[stop.id] ?? <TripPhoto>[];
    final isEnd = stop.role != null;
    // The start and finish, and a stop without a time, take the first day (the finish the last).
    var date = tripLocalDate(stop.localStart);
    if (kind == TripKind.route && (isEnd || stop.localStart == null)) {
      date = (stop.role == TripStopRole.finish ? (dates.isEmpty ? null : dates.last) : dates.firstOrNull) ?? '';
    }
    final isTimed = kind == TripKind.route && !isEnd && stop.localStart != null;
    final item = TripViewStop(
      id: stop.id,
      day: dayIndex[date] ?? 0,
      photos: photos,
      stop: stop,
      title: stop.title ?? '',
      story: stop.story ?? '',
      region: stop.region ?? '',
      country: stop.country ?? '',
      latitude: stop.latitude,
      longitude: stop.longitude,
      date: date,
      isEnd: isEnd,
      placeId: stop.placeId,
      article: stop.placeId == null ? null : articles[stop.placeId],
    ).._span();
    item.startTime = isTimed ? tripLocalTime(stop.localStart) : '—';
    item.endTime = isTimed ? tripLocalTime(stop.localEnd ?? stop.localStart) : '—';
    return item;
  }).toList();

  final days = [
    for (final (index, date) in dates.indexed)
      () {
        final same = viewStops.where((stop) => stop.date == date);
        return TripDay(
          date: date,
          color: tripDayColors[index % tripDayColors.length],
          count: same.fold(0, (sum, stop) => sum + stop.photos.length),
          regions: same.map((stop) => stop.region).where((region) => region.isNotEmpty).toSet().toList(),
        );
      }(),
  ];

  final stopDay = {for (final stop in viewStops) stop.id: stop.day};
  final position = {for (final (index, stop) in stops.indexed) stop.id: index};
  // A leg's day is the day of whichever end is shown, else of the nearest shown stop.
  int legDay(String from, String to) {
    for (final id in [from, to]) {
      final day = stopDay[id];
      if (day != null) {
        return day;
      }
    }
    final at = position[from] ?? 0;
    int? bestDistance;
    var bestDay = 0;
    for (final MapEntry(key: id, value: day) in stopDay.entries) {
      final distance = ((position[id] ?? 0) - at).abs();
      if (bestDistance == null || distance < bestDistance) {
        bestDistance = distance;
        bestDay = day;
      }
    }
    return bestDay;
  }

  final legs = kind == TripKind.route
      ? [
          for (final (index, leg) in trip.legs.indexed)
            if (leg.polyline != null && leg.polyline!.isNotEmpty)
              () {
                final day = legDay(leg.fromStopId, leg.toStopId);
                return TripViewLeg(
                  leg: leg,
                  day: day,
                  color: days.length == 1
                      ? tripDayColors[index % tripDayColors.length]
                      : (day < days.length ? days[day].color : tripPlacesColor),
                  points: decodePolyline(leg.polyline!),
                );
              }(),
        ]
      : <TripViewLeg>[];

  // Transit stops between the same two real stops make one item on the leg between them.
  final transit = <TripTransit>[];
  if (kind == TripKind.route) {
    final byPair = <String, TripTransit>{};
    final stopById = {for (final stop in stops) stop.id: stop};
    TripStopDto? previous;
    var pending = <TripStopDto>[];
    for (final stop in stops) {
      if (stop.isTransit == true) {
        if (previous != null) {
          pending.add(stop);
        }
        continue;
      }
      for (final way in pending) {
        final photos = photosByStop[way.id] ?? const <TripPhoto>[];
        if (photos.isEmpty) {
          continue;
        }
        final item = byPair.putIfAbsent('${previous!.id}:${stop.id}', () {
          final created = TripTransit(
            id: way.id,
            day: legDay(previous!.id, stop.id),
            fromStopId: previous.id,
            toStopId: stop.id,
            latitude: way.latitude,
            longitude: way.longitude,
          );
          transit.add(created);
          return created;
        });
        item.stopIds.add(way.id);
        item.photos.addAll(photos);
      }
      pending = [];
      previous = stop;
    }
    for (final item in transit) {
      item._span();
      item.fraction = transitFraction(
        stopById[item.fromStopId]!,
        stopById[item.toStopId]!,
        item.photos.map((photo) => photo.asset.localDateTime).toList(),
      );
      if (item.day < days.length) {
        days[item.day].count += item.photos.length;
      }
    }
  }

  final unplacedPhotos = kind == TripKind.places ? (photosByStop[null] ?? const <TripPhoto>[]) : const <TripPhoto>[];
  final unplaced = unplacedPhotos.isNotEmpty ? (TripUnplaced(unplacedPhotos).._span()) : null;

  var number = 0;
  for (final stop in viewStops) {
    if (stop.photos.isNotEmpty) {
      stop.number = ++number;
    }
  }

  final order = <TripItem>[];
  final placedTransit = <TripTransit>{};
  for (final stop in viewStops) {
    if (stop.photos.isNotEmpty) {
      order.add(stop);
    }
    for (final item in transit) {
      if (item.fromStopId == stop.id) {
        order.add(item);
        placedTransit.add(item);
      }
    }
  }
  order.addAll(transit.where((item) => !placedTransit.contains(item)));
  if (unplaced != null) {
    order.add(unplaced);
  }

  final km = kind == TripKind.route
      ? (trip.legs.fold(0.0, (sum, leg) => sum + (leg.distance ?? 0)) / 1000).round()
      : null;

  return TripView(
    kind: kind,
    albumId: trip.albumId,
    stops: viewStops,
    days: days,
    legs: legs,
    transit: transit,
    unplaced: unplaced,
    order: order,
    photos: order.expand((item) => item.photos).toList(),
    km: km,
    overlays: trip.overlays,
    isMultiCountry: viewStops.map((stop) => stop.country).where((country) => country.isNotEmpty).toSet().length > 1,
  );
}

/// The point `fraction` of the way along a line of [latitude, longitude] points, and the line's length in metres
/// (travel-album map.js lineMid).
({(double, double) at, double meters}) alongLine(List<(double, double)> points, double fraction) {
  const radians = math.pi / 180;
  final steps = [
    for (var index = 1; index < points.length; index++)
      () {
        final (fromLat, fromLng) = points[index - 1];
        final (lat, lng) = points[index];
        final x = (lng - fromLng) * radians * math.cos((lat + fromLat) / 2 * radians);
        final y = (lat - fromLat) * radians;
        return math.sqrt(x * x + y * y) * 6371008.8;
      }(),
  ];
  final meters = steps.fold(0.0, (sum, step) => sum + step);
  var left = meters * fraction;
  for (final (index, step) in steps.indexed) {
    if (left <= step && step > 0) {
      final (fromLat, fromLng) = points[index];
      final (lat, lng) = points[index + 1];
      final part = left / step;
      return (at: (fromLat + (lat - fromLat) * part, fromLng + (lng - fromLng) * part), meters: meters);
    }
    left -= step;
  }
  return (at: points.last, meters: meters);
}

/// The header numbers: assets, videos, stops with assets, days, km (travel-album map.js stats).
({int assets, int videos, int stops, int days, int? km}) tripStats(TripView view) => (
  assets: view.photos.length,
  videos: view.photos.where((photo) => photo.isVideo).length,
  stops: view.stops.where((stop) => stop.photos.isNotEmpty).length,
  days: view.days.length,
  km: view.km,
);

/// White or black text on a day colour, whichever reads at 4.5:1 (white preferred).
bool isWhiteInkOn(int argb) {
  double channel(int shift) {
    final value = ((argb >> shift) & 0xFF) / 255;
    return value <= 0.03928 ? value / 12.92 : math.pow((value + 0.055) / 1.055, 2.4).toDouble();
  }

  final luminance = 0.2126 * channel(16) + 0.7152 * channel(8) + 0.0722 * channel(0);
  return 1.05 / (luminance + 0.05) >= 4.5;
}

/// `start–end`, or one time when they are equal.
String tripTimeSpan(TripItem item) =>
    item.startTime == item.endTime ? item.startTime : '${item.startTime}–${item.endTime}';

/// How a Places trip lists its places (web TripPanel `placeSort`).
enum TripPlaceSort { frames, name }

/// The places of a Places trip as its list shows them (web TripPanel `places`): most frames first, or by name, ties by
/// id so the order holds between reads. Only edit mode lists a place without assets.
// A letter with a diacritic sorts with its base letter, near the web's localeCompare: Ėriškiai among the E's.
String _nameKey(String title) => title.toLowerCase().removeDiacritics();

List<TripViewStop> tripPlaces(TripView view, TripPlaceSort sort, {required bool isEditing}) {
  final places = view.stops.where((stop) => isEditing || stop.photos.isNotEmpty).toList();
  return places..sort((a, b) {
    final order = switch (sort) {
      TripPlaceSort.frames => b.photos.length.compareTo(a.photos.length),
      TripPlaceSort.name => _nameKey(a.title).compareTo(_nameKey(b.title)),
    };
    return order != 0 ? order : a.id.compareTo(b.id);
  });
}
