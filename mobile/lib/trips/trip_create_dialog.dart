import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:immich_mobile/extensions/build_context_extensions.dart';
import 'package:immich_mobile/generated/translations.g.dart';
import 'package:immich_mobile/trips/trips_api.repository.dart';
import 'package:openapi/api.dart';

/// Makes a trip of an album (trips PLAN §2.9, after web TripCreateModal.svelte): the owner picks its kind, the server
/// lays it out, and stops are named in the language of the owner's interface. True once the trip is made.
Future<bool> showTripCreateDialog(BuildContext context, {required String albumId}) async =>
    await showDialog<bool>(
      context: context,
      builder: (context) => _TripCreateDialog(albumId: albumId),
    ) ??
    false;

class _TripCreateDialog extends ConsumerStatefulWidget {
  final String albumId;

  const _TripCreateDialog({required this.albumId});

  @override
  ConsumerState<_TripCreateDialog> createState() => _TripCreateDialogState();
}

class _TripCreateDialogState extends ConsumerState<_TripCreateDialog> {
  TripKind _kind = TripKind.route;
  bool _isBusy = false;
  bool _isFailed = false;

  Future<void> _create() async {
    setState(() {
      _isBusy = true;
      _isFailed = false;
    });
    try {
      await ref.read(tripsApiRepositoryProvider).createTrip(widget.albumId, _kind, context.locale.toLanguageTag());
      if (mounted) {
        Navigator.of(context).pop(true);
      }
    } catch (_) {
      if (mounted) {
        setState(() {
          _isBusy = false;
          _isFailed = true;
        });
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final t = context.t;
    final kinds = [
      (kind: TripKind.route, icon: Icons.route, title: t.trips_kind_route, hint: t.trips_kind_route_hint),
      (
        kind: TripKind.places,
        icon: Icons.location_on_outlined,
        title: t.trips_kind_places,
        hint: t.trips_kind_places_hint,
      ),
      (
        kind: TripKind.plain,
        icon: Icons.calendar_month_outlined,
        title: t.trips_kind_plain,
        hint: t.trips_kind_plain_hint,
      ),
    ];
    final colors = context.colorScheme;

    return AlertDialog(
      title: Text(t.trips_create_title),
      scrollable: true,
      content: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Text(t.trips_create_hint, style: context.textTheme.bodyMedium?.copyWith(color: colors.onSurfaceVariant)),
          const SizedBox(height: 16),
          Semantics(
            label: t.trips_kind,
            child: Column(
              children: [
                for (final option in kinds)
                  Padding(
                    padding: const EdgeInsets.only(bottom: 8),
                    child: ListTile(
                      key: ValueKey('trip-kind-${option.kind}'),
                      selected: _kind == option.kind,
                      enabled: !_isBusy,
                      shape: RoundedRectangleBorder(
                        borderRadius: BorderRadius.circular(12),
                        side: BorderSide(
                          color: _kind == option.kind ? colors.primary : colors.outlineVariant,
                          width: 2,
                        ),
                      ),
                      selectedTileColor: colors.primary.withValues(alpha: 0.06),
                      leading: Icon(option.icon),
                      title: Text(option.title),
                      subtitle: Text(option.hint),
                      onTap: () => setState(() => _kind = option.kind),
                    ),
                  ),
              ],
            ),
          ),
          if (_isFailed)
            Text(
              t.trips_create_failed,
              key: const ValueKey('trip-create-error'),
              style: context.textTheme.bodyMedium?.copyWith(color: colors.error),
            ),
        ],
      ),
      actions: [
        TextButton(
          key: const ValueKey('trip-create-cancel'),
          onPressed: _isBusy ? null : () => Navigator.of(context).pop(false),
          child: Text(t.cancel),
        ),
        FilledButton(
          key: const ValueKey('trip-create-confirm'),
          onPressed: _isBusy ? null : _create,
          child: _isBusy
              ? const SizedBox.square(dimension: 18, child: CircularProgressIndicator(strokeWidth: 2))
              : Text(t.trips_create),
        ),
      ],
    );
  }
}
