import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:immich_mobile/trips/trip.provider.dart';
import 'package:immich_mobile/trips/trip_panel.dart';
import 'package:immich_mobile/trips/trips_api.repository.dart';
import 'package:mocktail/mocktail.dart';
import 'package:openapi/api.dart';

import '../widget_tester_extensions.dart';

// After the web TripPanel.svelte: a Places trip lists its places by frames or by name.

class _MockTripsApiRepository extends Mock implements TripsApiRepository {}

TripStopDto _stop(String id, String title) => TripStopDto(
  country: null,
  id: id,
  isAddedByHand: false,
  isAtCenter: false,
  isFinishAtStart: false,
  isPositionManual: false,
  isTransit: false,
  latitude: 55,
  localEnd: null,
  localStart: null,
  longitude: 25,
  placeId: null,
  region: null,
  role: null,
  sequence: 0,
  story: null,
  storySource: null,
  title: title,
  titleSource: null,
);

void main() {
  testWidgets('a Places trip lists its places by frames, or by name once asked', (tester) async {
    final repository = _MockTripsApiRepository();
    when(() => repository.getAlbumAssets('album')).thenAnswer((_) async => []);
    when(() => repository.getTrip('album')).thenAnswer(
      (_) async => TripResponseDto(
        albumId: 'album',
        kind: TripKind.places,
        isFavorites: false,
        isShowcased: false,
        isFeatured: false,
        isNaming: false,
        language: null,
        contentVersion: 1,
        stops: [_stop('z', 'Anykščiai'), _stop('a', 'Zarasai')],
      ),
    );
    await tester.pumpConsumerWidget(
      Consumer(
        builder: (context, ref, _) {
          final data = ref.watch(tripDataProvider('album')).valueOrNull;
          return data == null
              ? const SizedBox.shrink()
              : TripPanel(
                  data: data,
                  openItem: null,
                  openLeg: null,
                  onOpenLeg: (_) {},
                  // Edit mode lists places without assets, which these are.
                  isEditing: true,
                  picking: TripPicking(ids: const [], toggle: (_) {}, selectOnly: (_) {}, clear: () {}),
                  controller: null,
                  onOpen: (_) {},
                  onBack: () {},
                  onMovePin: (_) {},
                );
        },
      ),
      overrides: [tripsApiRepositoryProvider.overrideWithValue(repository)],
    );
    await tester.pumpAndSettle();
    List<String> order() {
      final rows = ['a', 'z'].map((id) => (id, tester.getTopLeft(find.byKey(ValueKey('trip-stop-row-$id'))).dy));
      return (rows.toList()..sort((a, b) => a.$2.compareTo(b.$2))).map((row) => row.$1).toList();
    }

    // Equal frames fall back to the id.
    expect(order(), ['a', 'z']);
    await tester.tap(find.byKey(const ValueKey('trip-place-sort-name')));
    await tester.pumpAndSettle();
    expect(order(), ['z', 'a']);
    expect(tester.widget<ChoiceChip>(find.byKey(const ValueKey('trip-place-sort-name'))).selected, isTrue);
  });
}
