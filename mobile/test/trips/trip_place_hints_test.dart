import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:immich_mobile/trips/trip.provider.dart';
import 'package:immich_mobile/trips/trip_place_hints.dart';
import 'package:immich_mobile/trips/trips_api.repository.dart';
import 'package:mocktail/mocktail.dart';
import 'package:openapi/api.dart';

import '../widget_tester_extensions.dart';

// After the web TripPlaceHints.svelte: a hint selects its assets or files them all.

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

TripResponseDto _trip({int contentVersion = 1}) => TripResponseDto(
  albumId: 'album',
  kind: TripKind.places,
  isFavorites: false,
  isShowcased: false,
  isFeatured: false,
  isNaming: false,
  language: null,
  contentVersion: contentVersion,
  stops: [_stop('p', 'Biržai')],
);

void main() {
  late _MockTripsApiRepository repository;
  late List<List<String>> selected;
  late int moved;

  setUp(() {
    repository = _MockTripsApiRepository();
    selected = [];
    moved = 0;
    when(() => repository.getAlbumAssets('album')).thenAnswer((_) async => []);
    when(() => repository.getTrip('album')).thenAnswer((_) async => _trip());
  });

  Future<void> open(WidgetTester tester, TripPlaceHintsDto hints) async {
    when(() => repository.getPlaceHints('album')).thenAnswer((_) async => hints);
    await tester.pumpConsumerWidget(
      Consumer(
        builder: (context, ref, _) {
          final data = ref.watch(tripDataProvider('album')).valueOrNull;
          if (data == null) {
            return const SizedBox.shrink();
          }
          return TripPlaceHints(data: data, onSelect: selected.add, onMoved: () => moved++);
        },
      ),
      overrides: [tripsApiRepositoryProvider.overrideWithValue(repository)],
    );
    await tester.pumpAndSettle();
  }

  testWidgets('shows nothing without hints', (tester) async {
    await open(tester, TripPlaceHintsDto());

    expect(find.byKey(const ValueKey('trip-place-hints')), findsNothing);
  });

  testWidgets('selects a hint\'s assets, and moves them all to its place', (tester) async {
    when(() => repository.moveAssets('album', ['x', 'y'], 'p')).thenAnswer((_) async => _trip(contentVersion: 2));
    when(() => repository.getPlaceHints('album')).thenAnswer(
      (_) async => TripPlaceHintsDto(
        places: [
          TripPlaceHintDto(stopId: 'p', assetIds: ['x', 'y']),
        ],
        center: ['z'],
      ),
    );
    await open(
      tester,
      TripPlaceHintsDto(
        places: [
          TripPlaceHintDto(stopId: 'p', assetIds: ['x', 'y']),
        ],
        center: ['z'],
      ),
    );

    final place = find.byKey(const ValueKey('trip-hint-p'));
    expect(find.descendant(of: place, matching: find.text('Biržai')), findsOneWidget);
    await tester.tap(find.descendant(of: place, matching: find.text('Select')));
    expect(selected, [
      ['x', 'y'],
    ]);

    await tester.tap(find.descendant(of: place, matching: find.text('Move')));
    await tester.pumpAndSettle();
    verify(() => repository.moveAssets('album', ['x', 'y'], 'p')).called(1);
    expect(moved, 1);
    // Asked again for the trip the move answered.
    verify(() => repository.getPlaceHints('album')).called(2);
  });

  testWidgets('files assets like no place to the centre', (tester) async {
    when(() => repository.toCenter('album', ['z'], null)).thenAnswer((_) async => _trip(contentVersion: 2));
    await open(tester, TripPlaceHintsDto(center: ['z']));

    await tester.tap(
      find.descendant(of: find.byKey(const ValueKey('trip-hint-center')), matching: find.text('File to the centre')),
    );
    await tester.pumpAndSettle();

    verify(() => repository.toCenter('album', ['z'], null)).called(1);
  });
}
