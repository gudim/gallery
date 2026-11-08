import 'dart:async';

import 'package:flutter/material.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:immich_mobile/generated/translations.g.dart';
import 'package:immich_mobile/trips/trip.provider.dart';
import 'package:immich_mobile/trips/trip_edit.dart';
import 'package:immich_mobile/trips/trip_text.dart';
import 'package:immich_mobile/trips/trip_view.dart';
import 'package:immich_mobile/trips/trips_api.repository.dart';
import 'package:maplibre_gl/maplibre_gl.dart' show LatLng;
import 'package:openapi/api.dart';

// A leg in edit mode (trips PLAN §2.9), after web TripLegEdit.svelte: its mode, a train's stations near both ends, and
// a retry when routing failed. A trail is drawn by an overlay, so it is never offered as a mode.

/// Where a station stands

class TripLegEdit extends ConsumerStatefulWidget {
  final TripData data;
  final TripLegDto leg;

  const TripLegEdit({super.key, required this.data, required this.leg});

  @override
  ConsumerState<TripLegEdit> createState() => _TripLegEditState();
}

class _TripLegEditState extends ConsumerState<TripLegEdit> {
  static const _auto = 'auto';
  static const _modes = [
    TripLegMode.foot,
    TripLegMode.driving,
    TripLegMode.bicycle,
    TripLegMode.bus,
    TripLegMode.train,
    TripLegMode.boat,
    TripLegMode.flight,
    TripLegMode.direct,
  ];

  /// The stations of a train leg: null while loading, and `failed` when they could not be read.
  TripLegStationsDto? _stations;
  bool _isStationsFailed = false;

  /// The leg and mode the stations were asked for; the leg object is replaced by every read of the trip.
  String? _stationsFor;

  /// Bumped when an edit fails, so the fields are built anew and show the leg as it is rather than what was picked.
  int _failedEdits = 0;

  TripLegDto get _leg => widget.leg;

  @override
  void initState() {
    super.initState();
    _loadStations();
  }

  @override
  void didUpdateWidget(TripLegEdit oldWidget) {
    super.didUpdateWidget(oldWidget);
    _loadStations();
  }

  void _loadStations() {
    final key = _leg.mode == TripLegMode.train ? _leg.id : null;
    if (key == _stationsFor) {
      return;
    }
    _stationsFor = key;
    _stations = null;
    _isStationsFailed = false;
    if (key == null) {
      return;
    }
    final albumId = widget.data.view.albumId;
    unawaited(
      ref
          .read(tripsApiRepositoryProvider)
          .getLegStations(albumId, key)
          .then((stations) {
            if (mounted && _stationsFor == key) {
              setState(() => _stations = stations);
            }
          })
          .catchError((_) {
            if (mounted && _stationsFor == key) {
              setState(() => _isStationsFailed = true);
            }
          }),
    );
  }

  Future<void> _run(TripEdit edit) async {
    if (!await runTripEdit(context, ref, widget.data.view.albumId, edit) && mounted) {
      setState(() => _failedEdits++);
    }
  }

  /// Where a station stands, which tells the leg's station apart among those listed
  static LatLng _pointOf(TripStationDto station) => LatLng(station.latitude, station.longitude);

  @override
  Widget build(BuildContext context) {
    final t = context.t;
    final leg = _leg;
    final isBusy = widget.data.isBusy;
    final muted = context.tripMuted;

    return Column(
      key: const ValueKey('trip-leg-edit'),
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        // A field shows its own pick until it is built anew: keyed by what the server holds.
        KeyedSubtree(
          key: ValueKey('${leg.isModeManual ? leg.mode.toJson() : _auto}-$_failedEdits'),
          child: DropdownButtonFormField<String>(
            key: const ValueKey('trip-leg-mode'),
            isExpanded: true,
            initialValue: leg.isModeManual ? leg.mode.toJson() : _auto,
            decoration: InputDecoration(labelText: t.trips_leg_mode),
            items: [
              DropdownMenuItem(value: _auto, child: Text(t.trips_mode_auto)),
              for (final mode in _modes)
                DropdownMenuItem(
                  value: mode.toJson(),
                  child: Row(
                    children: [
                      Icon(tripModeIcon(mode), size: 18),
                      const SizedBox(width: 12),
                      Text(tripModeLabel(t, mode)),
                    ],
                  ),
                ),
            ],
            onChanged: isBusy
                ? null
                : (value) => unawaited(
                    _run(
                      (repository, albumId) => repository.setLegMode(
                        albumId,
                        leg.id,
                        value == null || value == _auto ? null : TripLegMode.fromJson(value),
                      ),
                    ),
                  ),
          ),
        ),
        const SizedBox(height: 12),
        if (leg.status == TripLegStatus.pending)
          Row(
            key: const ValueKey('trip-leg-pending'),
            children: [
              const SizedBox.square(dimension: 16, child: CircularProgressIndicator(strokeWidth: 2)),
              const SizedBox(width: 8),
              Expanded(child: Text(t.trips_leg_pending, style: muted)),
            ],
          )
        else if (leg.status == TripLegStatus.attention)
          Wrap(
            crossAxisAlignment: WrapCrossAlignment.center,
            spacing: 8,
            children: [
              Text(t.trips_leg_attention),
              OutlinedButton.icon(
                key: const ValueKey('trip-leg-retry'),
                onPressed: isBusy
                    ? null
                    : () => unawaited(_run((repository, albumId) => repository.retryLeg(albumId, leg.id))),
                icon: const Icon(Icons.refresh, size: 18),
                label: Text(t.trips_retry),
                style: OutlinedButton.styleFrom(visualDensity: VisualDensity.compact),
              ),
            ],
          ),
        if (leg.mode == TripLegMode.train) ...[const SizedBox(height: 12), ..._stationFields(t, leg, isBusy, muted)],
      ],
    );
  }

  List<Widget> _stationFields(Translations t, TripLegDto leg, bool isBusy, TextStyle? muted) {
    final stations = _stations;
    if (_isStationsFailed) {
      return [Text(t.trips_stations_failed, style: muted)];
    }
    if (stations == null) {
      return [
        Row(
          children: [
            const SizedBox.square(dimension: 16, child: CircularProgressIndicator(strokeWidth: 2)),
            const SizedBox(width: 8),
            Text(t.trips_stations_loading, style: muted),
          ],
        ),
      ];
    }
    final ends = [
      (
        side: TripStationSide.departure,
        label: t.trips_station_departure,
        list: stations.departure,
        name: leg.departureName,
        point: tripLatLng(leg.departureLatitude, leg.departureLongitude),
      ),
      (
        side: TripStationSide.arrival,
        label: t.trips_station_arrival,
        list: stations.arrival,
        name: leg.arrivalName,
        point: tripLatLng(leg.arrivalLatitude, leg.arrivalLongitude),
      ),
    ];
    return [
      for (final end in ends) ...[
        if (end.list.isEmpty)
          InputDecorator(
            decoration: InputDecoration(labelText: end.label, border: InputBorder.none),
            child: Text(t.trips_station_none, style: muted),
          )
        else
          DropdownButtonFormField<LatLng>(
            key: ValueKey(('trip-leg-station', end.side, end.point, _failedEdits)),
            isExpanded: true,
            initialValue: end.list.any((station) => _pointOf(station) == end.point) ? end.point : null,
            hint: Text(end.name ?? t.trips_station_pick),
            decoration: InputDecoration(labelText: end.label),
            items: [
              for (final station in end.list)
                DropdownMenuItem(
                  value: _pointOf(station),
                  child: Text(
                    '${station.name.isEmpty ? t.trips_station_unnamed : station.name} · '
                    '${t.trips_km(km: (station.distance / 1000).toStringAsFixed(1))}',
                    overflow: TextOverflow.ellipsis,
                  ),
                ),
            ],
            onChanged: isBusy
                ? null
                : (point) {
                    final station = end.list.where((station) => _pointOf(station) == point).firstOrNull;
                    if (station != null) {
                      unawaited(
                        _run((repository, albumId) => repository.setLegStation(albumId, leg.id, end.side, station)),
                      );
                    }
                  },
          ),
        const SizedBox(height: 12),
      ],
    ];
  }
}
