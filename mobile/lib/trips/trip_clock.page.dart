import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:immich_mobile/extensions/build_context_extensions.dart';
import 'package:immich_mobile/generated/translations.g.dart';
import 'package:immich_mobile/trips/trip.provider.dart';
import 'package:immich_mobile/trips/trips_api.repository.dart';
import 'package:immich_mobile/widgets/common/immich_toast.dart';
import 'package:openapi/api.dart';

// The clock-offset wizard on the phone (trips PLAN D9, §2.9), after web TripClockModal.svelte: the album's cameras, and
// for one without GPS a shift of its clock, suggested where the cameras with GPS time it. A shift moves the dates of the
// caller's own assets of the camera through Immich's bulk asset update; the trip follows once their metadata is read
// again (`TripDataNotifier.follow`).

Future<void> showTripClockPage(BuildContext context, String albumId) => Navigator.of(
  context,
).push(MaterialPageRoute(fullscreenDialog: true, builder: (_) => TripClockPage(albumId: albumId)));

class TripClockPage extends ConsumerStatefulWidget {
  final String albumId;

  const TripClockPage({super.key, required this.albumId});

  @override
  ConsumerState<TripClockPage> createState() => _TripClockPageState();
}

/// `-39` → "−39 min", `65` → "+1 h 5 min"
String tripOffsetLabel(Translations t, int offset) {
  final sign = offset < 0 ? '−' : '+';
  final hours = offset.abs() ~/ 60;
  final rest = offset.abs() % 60;
  return sign +
      (hours > 0 ? t.trips_duration_hours(hours: hours, minutes: rest) : t.trips_duration_minutes(minutes: rest));
}

/// A camera as the page tells cameras apart: its make and model, and whether it shot videos.
typedef _CameraId = ({String? make, String? model, bool isVideo});

class _TripClockPageState extends ConsumerState<TripClockPage> {
  List<TripCameraDto>? _cameras;
  final _minutes = <_CameraId, TextEditingController>{};

  /// The camera whose shift is on its way
  _CameraId? _applying;

  static _CameraId _idOf(TripCameraDto camera) => (make: camera.make, model: camera.model, isVideo: camera.isVideo);

  /// The camera in its widgets' keys
  static String _tagOf(TripCameraDto camera) => '${camera.make}|${camera.model}|${camera.isVideo}';

  @override
  void initState() {
    super.initState();
    unawaited(_load());
  }

  @override
  void dispose() {
    for (final controller in _minutes.values) {
      controller.dispose();
    }
    super.dispose();
  }

  Future<void> _load() async {
    try {
      final cameras = await ref.read(tripsApiRepositoryProvider).getCameras(widget.albumId);
      if (!mounted) {
        return;
      }
      setState(() {
        _cameras = cameras;
        for (final camera in cameras) {
          _minutes[_idOf(camera)] = TextEditingController(text: '${camera.suggestion?.offsetMinutes ?? 0}');
        }
      });
    } catch (_) {
      if (mounted) {
        ImmichToast.show(context: context, msg: context.t.trips_clock_failed, toastType: ToastType.error);
        Navigator.of(context).pop();
      }
    }
  }

  int? _offsetOf(TripCameraDto camera) => int.tryParse(_minutes[_idOf(camera)]?.text.trim() ?? '');

  // A whole number of minutes other than none, on assets of the caller's own.
  bool _canShift(TripCameraDto camera) {
    final offset = _offsetOf(camera);
    return _applying == null && camera.ownAssetIds.isNotEmpty && offset != null && offset != 0;
  }

  Future<void> _shift(TripCameraDto camera) async {
    final offset = _offsetOf(camera);
    if (offset == null) {
      return;
    }
    final t = context.t;
    // Read before the await: the page may be gone by the answer, and the trip under it must still follow the shift.
    final repository = ref.read(tripsApiRepositoryProvider);
    final trip = ref.read(tripDataProvider(widget.albumId).notifier);
    setState(() => _applying = _idOf(camera));
    try {
      await repository.shiftDates(camera.ownAssetIds, offset);
      trip.follow();
      if (mounted) {
        ImmichToast.show(context: context, msg: t.trips_clock_applied, toastType: ToastType.success);
        Navigator.of(context).pop();
      }
    } catch (_) {
      if (mounted) {
        setState(() => _applying = null);
        ImmichToast.show(context: context, msg: t.trips_clock_failed, toastType: ToastType.error);
      }
    }
  }

  String _nameOf(Translations t, TripCameraDto camera) {
    final name = [camera.model, camera.make].firstWhere((part) => part != null && part.isNotEmpty, orElse: () => null);
    if (camera.isVideo) {
      return name == null ? t.trips_clock_video : '${t.trips_clock_video} · $name';
    }
    return name ?? t.trips_clock_camera_unknown;
  }

  @override
  Widget build(BuildContext context) {
    final t = context.t;
    final cameras = _cameras;
    final muted = context.textTheme.bodySmall?.copyWith(color: context.colorScheme.onSurfaceVariant);

    return Scaffold(
      appBar: AppBar(title: Text(t.trips_clock)),
      body: cameras == null
          ? const Center(child: CircularProgressIndicator())
          : ListView.separated(
              key: const ValueKey('trip-cameras'),
              padding: const EdgeInsets.fromLTRB(16, 8, 16, 32),
              itemCount: cameras.length + 1,
              separatorBuilder: (_, index) => index == 0 ? const SizedBox(height: 8) : const Divider(height: 24),
              itemBuilder: (context, index) {
                if (index == 0) {
                  return Text(t.trips_clock_hint, style: muted);
                }
                final camera = cameras[index - 1];
                final others = camera.assetCount - camera.ownAssetIds.length;
                final suggestion = camera.suggestion;
                return Column(
                  key: ValueKey('trip-camera-${_tagOf(camera)}'),
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(_nameOf(t, camera), style: context.textTheme.titleSmall),
                    Text(
                      '${t.trips_assets_count(count: camera.assetCount)} · ${t.trips_clock_gps(count: camera.gpsCount)}',
                      style: muted,
                    ),
                    if (camera.isReference) ...[
                      const SizedBox(height: 4),
                      Text(t.trips_clock_reference),
                    ] else ...[
                      if (suggestion != null) ...[
                        const SizedBox(height: 4),
                        Text(
                          t.trips_clock_suggestion(
                            offset: tripOffsetLabel(t, suggestion.offsetMinutes),
                            best: (suggestion.best * 100).round(),
                            current: (suggestion.current * 100).round(),
                          ),
                        ),
                      ],
                      if (others > 0) ...[
                        const SizedBox(height: 4),
                        Text(t.trips_clock_others(count: others), style: muted),
                      ],
                      const SizedBox(height: 8),
                      Row(
                        crossAxisAlignment: CrossAxisAlignment.center,
                        children: [
                          SizedBox(
                            width: 160,
                            child: TextField(
                              key: ValueKey('trip-camera-minutes-${_tagOf(camera)}'),
                              controller: _minutes[_idOf(camera)],
                              enabled: camera.ownAssetIds.isNotEmpty && _applying == null,
                              keyboardType: const TextInputType.numberWithOptions(signed: true),
                              inputFormatters: [FilteringTextInputFormatter.allow(RegExp(r'^-?\d*'))],
                              decoration: InputDecoration(labelText: t.trips_clock_minutes, isDense: true),
                              onChanged: (_) => setState(() {}),
                            ),
                          ),
                          const SizedBox(width: 12),
                          FilledButton(
                            key: ValueKey('trip-camera-shift-${_tagOf(camera)}'),
                            onPressed: _canShift(camera) ? () => unawaited(_shift(camera)) : null,
                            child: _applying == _idOf(camera)
                                ? const SizedBox.square(dimension: 16, child: CircularProgressIndicator(strokeWidth: 2))
                                : Text(t.trips_clock_apply),
                          ),
                        ],
                      ),
                    ],
                  ],
                );
              },
            ),
    );
  }
}
