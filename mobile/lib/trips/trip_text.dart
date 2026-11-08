import 'package:flutter/material.dart';
import 'package:immich_mobile/extensions/build_context_extensions.dart';
import 'package:immich_mobile/generated/translations.g.dart';
import 'package:immich_mobile/trips/trip_view.dart';
import 'package:intl/intl.dart';
import 'package:openapi/api.dart';

// Texts the trip screen derives from its model, ported from web/src/lib/trips/trip-text.ts and the panel's lines.
// `lang` is the app's locale tag, for dates.

extension TripTextStyle on BuildContext {
  /// The small grey text of hints, counts and times on the trip screens
  TextStyle? get tripMuted => textTheme.bodySmall?.copyWith(color: colorScheme.onSurfaceVariant);
}

DateTime _utc(String date) => DateTime.parse('${date}T00:00:00Z');

/// "8 августа", "August 8"
String tripDayLabel(String date, String lang) => date.isEmpty ? '' : DateFormat.MMMMd(lang).format(_utc(date));

/// "8 августа 2026 г.", "August 8, 2026"
String tripLongDate(String date, String lang) => date.isEmpty ? '' : DateFormat.yMMMMd(lang).format(_utc(date));

/// "2019–2024", or one year
String tripYearSpan(List<TripPhoto> photos) {
  final years =
      photos
          .map((photo) => photo.date.length >= 4 ? photo.date.substring(0, 4) : '')
          .where((year) => year.isNotEmpty)
          .toSet()
          .toList()
        ..sort();
  if (years.isEmpty) {
    return '';
  }
  return years.length == 1 ? years.first : '${years.first}–${years.last}';
}

String tripModeLabel(Translations t, TripLegMode mode) => switch (mode) {
  TripLegMode.foot => t.trips_mode_foot,
  TripLegMode.driving => t.trips_mode_driving,
  TripLegMode.trail => t.trips_mode_trail,
  TripLegMode.direct => t.trips_mode_direct,
  TripLegMode.flight => t.trips_mode_flight,
  TripLegMode.bicycle => t.trips_mode_bicycle,
  TripLegMode.bus => t.trips_mode_bus,
  TripLegMode.train => t.trips_mode_train,
  TripLegMode.boat => t.trips_mode_boat,
};

/// Material icons for the leg modes, as the web's MDI ones.
IconData tripModeIcon(TripLegMode mode) => switch (mode) {
  TripLegMode.foot => Icons.directions_walk,
  TripLegMode.driving => Icons.directions_car,
  TripLegMode.trail => Icons.hiking,
  TripLegMode.direct => Icons.timeline,
  TripLegMode.flight => Icons.flight,
  TripLegMode.bicycle => Icons.directions_bike,
  TripLegMode.bus => Icons.directions_bus,
  TripLegMode.train => Icons.train,
  TripLegMode.boat => Icons.directions_boat,
};

/// "Start" or "Finish".
String tripEndLabel(Translations t, TripStopRole role) => role == TripStopRole.start ? t.trips_start : t.trips_finish;

/// A stop's name in lists; the start, the finish and a point not named yet still read as something.
String tripRowTitle(Translations t, TripViewStop stop) {
  final role = stop.role;
  if (stop.name.isNotEmpty) {
    return stop.name;
  }
  return role != null ? tripEndLabel(t, role) : t.trips_untitled_stop;
}

/// The title of an item in lists and on its own page.
String tripItemTitle(Translations t, TripItem item, TripView view, String lang) => switch (item) {
  TripUnplaced() => t.trips_unplaced,
  TripTransit(:final fromStopId, :final toStopId) => t.trips_transit_title(
    from: _stopName(view, fromStopId),
    to: _stopName(view, toStopId),
  ),
  TripViewStop() => tripRowTitle(t, item),
};

String _stopName(TripView view, String id) {
  final name = view.stopById(id)?.name ?? '';
  return name.isNotEmpty ? name : '…';
}

/// The header line: the dates and days of a route, or places and years.
String tripRangeLine(Translations t, TripView view, String lang) {
  if (view.isPlaces) {
    final places = view.stops.where((stop) => stop.photos.isNotEmpty).length;
    final years = tripYearSpan(view.photos);
    return [t.trips_places_count(count: places), if (years.isNotEmpty) years].join(' · ');
  }
  if (view.days.isEmpty) {
    return '';
  }
  final first = view.days.first.date;
  final last = view.days.last.date;
  return t.trips_range(
    from: tripDayLabel(first, lang),
    to: tripDayLabel(last, lang),
    year: last.substring(0, 4),
    count: view.days.length,
  );
}

/// The header numbers: assets, videos, stops or places, days, km.
String tripStatsLine(Translations t, TripView view, String lang) {
  final stats = tripStats(view);
  final isRoute = view.isRoute;
  return [
    t.trips_assets_count(count: stats.assets),
    if (stats.videos > 0) t.trips_videos_count(count: stats.videos),
    view.isPlaces ? t.trips_places_count(count: stats.stops) : t.trips_stops_count(count: stats.stops),
    if (isRoute) t.trips_days_count(count: stats.days),
    if (isRoute && stats.km != null && stats.km! > 0)
      t.trips_km(km: NumberFormat.decimalPattern(lang).format(stats.km)),
  ].join(' · ');
}

/// Mode, distance, time and stations of a leg.
String tripLegLine(Translations t, TripLegDto leg) {
  final parts = [tripModeLabel(t, leg.mode)];
  final distance = leg.distance;
  if (distance != null && distance > 0) {
    final km = distance / 1000;
    parts.add(t.trips_km(km: km < 10 ? km.toStringAsFixed(1) : km.round()));
  }
  final duration = leg.duration;
  if (duration != null && duration > 0) {
    final minutes = (duration / 60).round().clamp(1, 1 << 31);
    final hours = minutes ~/ 60;
    parts.add(
      hours > 0
          ? t.trips_duration_hours(hours: hours, minutes: minutes % 60)
          : t.trips_duration_minutes(minutes: minutes),
    );
  }
  if (leg.departureName != null && leg.arrivalName != null) {
    parts.add('${leg.departureName} → ${leg.arrivalName}');
  }
  return parts.join(' · ');
}

/// The meta line of an item: its day and times on a route, its years elsewhere, and its counts.
List<String> tripItemMeta(Translations t, TripItem item, TripView view, String lang) {
  if (item is TripUnplaced) {
    return [t.trips_assets_count(count: item.photos.length)];
  }
  final parts = <String>[];
  if (view.isRoute) {
    parts.add(tripDayLabel(item.day < view.days.length ? view.days[item.day].date : '', lang));
    if (item is TripTransit) {
      parts.add(t.trips_on_the_way);
    }
    parts.add(item.photos.isNotEmpty ? tripTimeSpan(item) : t.trips_no_shots);
  } else {
    parts.add(tripYearSpan(item.photos));
  }
  if (item.photos.isNotEmpty) {
    parts.add(t.trips_assets_count(count: item.photos.length));
  }
  if (item.videoCount > 0) {
    parts.add(t.trips_videos_count(count: item.videoCount));
  }
  if (item is TripViewStop && view.isMultiCountry && item.country.isNotEmpty) {
    parts.add(item.country);
  }
  return parts.where((part) => part.isNotEmpty).toList();
}

/// What an item with no assets says instead.
String tripEmptyNote(Translations t, TripItem item, TripView view) {
  if (item is TripViewStop && view.isPlaces) {
    return item.role != null ? t.trips_empty_center : t.trips_empty_place;
  }
  return t.trips_empty_stop;
}
