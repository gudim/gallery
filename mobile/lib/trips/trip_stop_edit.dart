import 'dart:async';

import 'package:flutter/material.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:immich_mobile/extensions/build_context_extensions.dart';
import 'package:immich_mobile/generated/translations.g.dart';
import 'package:immich_mobile/trips/trip.provider.dart';
import 'package:immich_mobile/trips/trip_point.page.dart';
import 'package:immich_mobile/trips/trip_view.dart';
import 'package:immich_mobile/trips/trips_api.repository.dart';
import 'package:immich_mobile/widgets/common/confirm_dialog.dart';
import 'package:immich_mobile/widgets/common/immich_toast.dart';
import 'package:openapi/api.dart';

// The opened stop in edit mode (trips PLAN §2.9), after web TripStopEdit.svelte: its title and story, saved a second
// after typing stops, and what can be done to it.

class TripStopEdit extends ConsumerStatefulWidget {
  final TripData data;
  final TripItem item;

  /// The stop is gone (merged, deleted, or folded into the way)
  final VoidCallback onGone;

  /// Puts a fixed pin for the stop on the map, to pan the map under
  final void Function(TripViewStop stop) onMovePin;

  const TripStopEdit({
    super.key,
    required this.data,
    required this.item,
    required this.onGone,
    required this.onMovePin,
  });

  @override
  ConsumerState<TripStopEdit> createState() => _TripStopEditState();
}

enum _SaveState { idle, saving, saved }

class _TripStopEditState extends ConsumerState<TripStopEdit> {
  static const saveDelay = Duration(seconds: 1);

  final _title = TextEditingController();
  final _story = TextEditingController();
  late final TripDataNotifier _editor;
  late final TripsApiRepository _repository;
  Timer? _timer;
  String _textStopId = '';
  ({String title, String story}) _saved = (title: '', story: '');
  _SaveState _saveState = _SaveState.idle;

  TripView get _view => widget.data.view;

  TripViewStop? get _stop => widget.item is TripViewStop ? widget.item as TripViewStop : null;

  @override
  void initState() {
    super.initState();
    // Kept for the save that leaving the stop sends, when this widget's ref is gone.
    _editor = ref.read(tripDataProvider(_view.albumId).notifier);
    _repository = ref.read(tripsApiRepositoryProvider);
    _loadTexts();
  }

  @override
  void didUpdateWidget(TripStopEdit oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (_stop?.id != _textStopId) {
      unawaited(_flush());
      _loadTexts();
    }
  }

  @override
  void dispose() {
    unawaited(_flush(isLeaving: true));
    _title.dispose();
    _story.dispose();
    super.dispose();
  }

  void _loadTexts() {
    final stop = _stop;
    _textStopId = stop?.id ?? '';
    _title.text = stop?.stop.title ?? '';
    _story.text = stop?.stop.story ?? '';
    _saved = (title: _title.text, story: _story.text);
    _saveState = _SaveState.idle;
  }

  void _schedule() {
    _timer?.cancel();
    _timer = Timer(saveDelay, () => unawaited(_flush()));
    if (_saveState != _SaveState.idle) {
      setState(() => _saveState = _SaveState.idle);
    }
  }

  Future<void> _flush({bool isLeaving = false}) async {
    _timer?.cancel();
    final id = _textStopId;
    final sent = (title: _title.text, story: _story.text);
    final hasTitle = sent.title != _saved.title;
    final hasStory = sent.story != _saved.story;
    if (id.isEmpty || (!hasTitle && !hasStory)) {
      return;
    }
    final change = TripStopUpdateDto(
      title: hasTitle ? Optional.present(sent.title) : const Optional.absent(),
      story: hasStory ? Optional.present(sent.story) : const Optional.absent(),
    );
    if (!isLeaving) {
      setState(() => _saveState = _SaveState.saving);
    }
    final isSaved = await _editor.run((albumId) => _repository.updateStop(albumId, id, change));
    // The owner may have left, or opened another stop meanwhile; its texts are not these.
    if (!mounted) {
      return;
    }
    if (!isSaved) {
      _toast(context.t.trips_save_failed);
    }
    if (id != _textStopId) {
      return;
    }
    setState(() {
      if (isSaved) {
        _saved = sent;
      }
      _saveState = isSaved ? _SaveState.saved : _SaveState.idle;
    });
  }

  void _toast(String message) => ImmichToast.show(context: context, msg: message, toastType: ToastType.error);

  /// Runs one edit and tells the user when it fails. Returns whether it went through.
  Future<bool> _run(Future<TripResponseDto> Function(TripsApiRepository repository, String albumId) edit) async {
    final message = context.t.trips_edit_failed;
    final isDone = await _editor.run((albumId) => edit(_repository, albumId));
    if (!isDone && mounted) {
      _toast(message);
    }
    return isDone;
  }

  Future<void> _runAndLeave(
    Future<TripResponseDto> Function(TripsApiRepository repository, String albumId) edit,
  ) async {
    if (await _run(edit)) {
      widget.onGone();
    }
  }

  Future<TripPoint?> _pickPoint(String title) {
    final (latitude, longitude) = switch (widget.item) {
      TripViewStop(:final latitude, :final longitude) => (latitude, longitude),
      TripTransit(:final latitude, :final longitude) => (latitude, longitude),
      _ => (null, null),
    };
    return showTripPointPage(
      context,
      albumId: _view.albumId,
      title: title,
      latitude: latitude,
      longitude: longitude,
      isNamed: true,
    );
  }

  Future<void> _changeEnd(TripStopRole role) async {
    final t = context.t;
    final point = await _pickPoint(role == TripStopRole.start ? t.trips_start : t.trips_finish);
    if (point != null && mounted) {
      await _run(
        (repository, albumId) =>
            role == TripStopRole.start ? repository.setStart(albumId, point) : repository.setFinish(albumId, point),
      );
    }
  }

  Future<void> _addPointAfter(TripStopRole? role) async {
    final point = await _pickPoint(context.t.trips_add_point);
    if (point != null && mounted) {
      final afterStopId = role == TripStopRole.start ? null : widget.item.id;
      await _run((repository, albumId) => repository.addPoint(albumId, point, afterStopId));
    }
  }

  Future<void> _delete() async {
    final t = context.t;
    final isSure = await showDialog<bool>(
      context: context,
      builder: (_) => ConfirmDialog(title: t.trips_delete_stop, content: t.trips_delete_stop_prompt, ok: t.delete),
    );
    if (isSure == true) {
      await _runAndLeave((repository, albumId) => repository.deleteStop(albumId, widget.item.id));
    }
  }

  @override
  Widget build(BuildContext context) {
    final t = context.t;
    final item = widget.item;
    final stop = _stop;
    final role = stop?.stop.role;
    final isRoute = _view.kind == TripKind.route;
    final hasMap = _view.kind != TripKind.plain;
    final hasAssets = item.photos.isNotEmpty;
    final isHandPoint = stop != null && stop.stop.isAddedByHand && role == null;
    final places = widget.data.trip.places;
    final isBusy = widget.data.isBusy;
    final muted = context.textTheme.bodySmall?.copyWith(color: context.colorScheme.onSurfaceVariant);

    Widget action(String label, IconData icon, VoidCallback onPressed, {Key? key, bool isDanger = false}) {
      final color = isDanger ? context.colorScheme.error : null;
      return OutlinedButton.icon(
        key: key,
        onPressed: isBusy ? null : onPressed,
        icon: Icon(icon, size: 18, color: color),
        label: Text(label, style: TextStyle(color: color)),
        style: OutlinedButton.styleFrom(
          visualDensity: VisualDensity.compact,
          side: isDanger ? BorderSide(color: context.colorScheme.error) : null,
        ),
      );
    }

    final orderOptions = isHandPoint && isRoute ? _orderOptions(t, stop) : const <TripViewStop>[];

    return Column(
      key: const ValueKey('trip-stop-edit'),
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        if (stop != null) ...[
          TextField(
            key: const ValueKey('trip-stop-title'),
            controller: _title,
            onChanged: (_) => _schedule(),
            onTapOutside: (_) => FocusScope.of(context).unfocus(),
            onEditingComplete: () => unawaited(_flush()),
            decoration: InputDecoration(
              labelText: t.trips_stop_title,
              hintText: stop.region.isNotEmpty ? stop.region : t.trips_stop_title_hint,
              floatingLabelBehavior: FloatingLabelBehavior.always,
            ),
          ),
          if (role == null) ...[
            const SizedBox(height: 12),
            TextField(
              key: const ValueKey('trip-stop-story'),
              controller: _story,
              onChanged: (_) => _schedule(),
              onTapOutside: (_) => FocusScope.of(context).unfocus(),
              minLines: 2,
              maxLines: 8,
              decoration: InputDecoration(labelText: t.trips_stop_story),
            ),
          ],
          SizedBox(
            height: 20,
            child: Padding(
              padding: const EdgeInsets.only(top: 4),
              child: Text(switch (_saveState) {
                _SaveState.saving => t.trips_saving,
                _SaveState.saved => t.trips_saved,
                _SaveState.idle => '',
              }, style: muted),
            ),
          ),
          if (places.isNotEmpty && role == null) ...[
            const SizedBox(height: 4),
            DropdownButtonFormField<String>(
              key: const ValueKey('trip-stop-place'),
              initialValue: stop.placeId ?? '',
              isExpanded: true,
              decoration: InputDecoration(labelText: t.trips_place),
              items: [
                DropdownMenuItem(value: '', child: Text(t.trips_no_place)),
                for (final place in places)
                  DropdownMenuItem(
                    value: place.id,
                    child: Text(place.title?.isNotEmpty == true ? place.title! : place.key),
                  ),
              ],
              onChanged: isBusy
                  ? null
                  : (placeId) => unawaited(
                      _run(
                        (repository, albumId) => repository.updateStop(
                          albumId,
                          stop.id,
                          TripStopUpdateDto(placeId: Optional.present(placeId == '' ? null : placeId)),
                        ),
                      ),
                    ),
            ),
            const SizedBox(height: 12),
          ],
          if (orderOptions.isNotEmpty) ...[
            DropdownButtonFormField<String>(
              key: const ValueKey('trip-stop-order'),
              isExpanded: true,
              hint: Text(t.trips_point_after_hint),
              decoration: InputDecoration(labelText: t.trips_point_after),
              items: [
                for (final candidate in orderOptions)
                  DropdownMenuItem(value: candidate.id, child: Text(_orderLabel(t, candidate))),
              ],
              onChanged: isBusy ? null : (afterId) => unawaited(_order(stop, afterId)),
            ),
            const SizedBox(height: 12),
          ],
        ],
        Wrap(
          key: const ValueKey('trip-stop-actions'),
          spacing: 8,
          runSpacing: 4,
          children: [
            if (role != null)
              action(
                t.trips_change_place,
                Icons.edit_location_alt_outlined,
                () => unawaited(_changeEnd(role)),
                key: const ValueKey('trip-change-place'),
              ),
            if (role == TripStopRole.finish && stop?.stop.isFinishAtStart != true)
              action(
                t.trips_finish_at_start,
                Icons.check,
                () => unawaited(_run((repository, albumId) => repository.setFinishAtStart(albumId))),
              ),
            if (role != null)
              action(
                role == TripStopRole.start ? t.trips_remove_start : t.trips_remove_finish,
                Icons.wrong_location_outlined,
                () => unawaited(
                  _runAndLeave(
                    (repository, albumId) =>
                        role == TripStopRole.start ? repository.removeStart(albumId) : repository.removeFinish(albumId),
                  ),
                ),

                key: const ValueKey('trip-remove-end'),
              ),
            if (stop != null && role == null && hasMap && stop.latitude != null && stop.longitude != null)
              action(
                t.trips_move_pin,
                Icons.open_with,
                () => widget.onMovePin(stop),
                key: const ValueKey('trip-move-pin'),
              ),
            if (stop != null && role == null && hasMap && stop.stop.isPositionManual && hasAssets)
              action(
                t.trips_pin_to_assets,
                Icons.photo_library_outlined,
                () => unawaited(
                  _run(
                    (repository, albumId) => repository.updateStop(
                      albumId,
                      stop.id,
                      TripStopUpdateDto(isPositionManual: const Optional.present(false)),
                    ),
                  ),
                ),
              ),
            if (isRoute && (role == TripStopRole.start || (stop != null && role == null)))
              action(
                t.trips_add_point_after,
                Icons.add_location_alt_outlined,
                () => unawaited(_addPointAfter(role)),
                key: const ValueKey('trip-add-point'),
              ),
            if (stop != null && role == null && hasAssets) ...[
              action(
                t.trips_merge_next,
                Icons.vertical_align_center,
                () => unawaited(_run((repository, albumId) => repository.mergeNextStop(albumId, stop.id))),
                key: const ValueKey('trip-merge-next'),
              ),
              if (isRoute)
                action(
                  t.trips_mark_on_the_way,
                  Icons.directions_bus_outlined,
                  () =>
                      unawaited(_runAndLeave((repository, albumId) => repository.setTransit(albumId, [stop.id], true))),
                  key: const ValueKey('trip-mark-on-the-way'),
                ),
            ],
            if (item is TripTransit)
              action(
                t.trips_not_on_the_way,
                Icons.swap_vert,
                () => unawaited(
                  _runAndLeave((repository, albumId) => repository.setTransit(albumId, item.stopIds, false)),
                ),
                key: const ValueKey('trip-not-on-the-way'),
              ),
            if (stop != null && role == null && !hasAssets)
              action(
                t.trips_delete_stop,
                Icons.delete_outline,
                () => unawaited(_delete()),
                key: const ValueKey('trip-delete-stop'),
                isDanger: true,
              ),
          ],
        ),
      ],
    );
  }

  /// A point added by hand goes after any other stop of the route, listed in trip order.
  List<TripViewStop> _orderOptions(Translations t, TripViewStop stop) {
    final stops = _view.stops;
    final index = stops.indexWhere((candidate) => candidate.id == stop.id);
    // Going after the stop it already follows changes nothing.
    final previousId = index > 0 ? stops[index - 1].id : null;
    return [
      for (final candidate in stops)
        if (candidate.id != stop.id && candidate.id != previousId && candidate.stop.role != TripStopRole.finish)
          candidate,
    ];
  }

  String _orderLabel(Translations t, TripViewStop candidate) {
    if (candidate.stop.role == TripStopRole.start) {
      return t.trips_start;
    }
    if (candidate.title.isNotEmpty) {
      return candidate.title;
    }
    return candidate.region.isNotEmpty ? candidate.region : t.trips_untitled_stop;
  }

  // Right after the start is null to the server.
  Future<void> _order(TripViewStop stop, String? afterId) {
    TripViewStop? after;
    for (final candidate in _view.stops) {
      if (candidate.id == afterId) {
        after = candidate;
      }
    }
    final afterStopId = after == null || after.stop.role == TripStopRole.start ? null : after.id;
    return _run((repository, albumId) => repository.movePoint(albumId, stop.id, afterStopId));
  }
}
