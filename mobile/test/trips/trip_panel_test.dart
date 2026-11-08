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

TripStopDto _stop(String id, String title, {String? placeId}) => TripStopDto(
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
  placeId: placeId,
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

  Future<void> pumpPanel(
    WidgetTester tester,
    TripResponseDto trip, {
    String? openId,
    TripLegDto? openLeg,
    required bool isEditing,
  }) async {
    final repository = _MockTripsApiRepository();
    when(() => repository.getAlbumAssets('album')).thenAnswer((_) async => []);
    when(() => repository.getTrip('album')).thenAnswer((_) async => trip);
    await tester.pumpConsumerWidget(
      Consumer(
        builder: (context, ref, _) {
          final data = ref.watch(tripDataProvider('album')).valueOrNull;
          return data == null
              ? const SizedBox.shrink()
              : TripPanel(
                  data: data,
                  openItem: openId == null ? null : data.view.itemById(openId),
                  openLeg: openLeg,
                  onOpenLeg: (_) {},
                  isEditing: isEditing,
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
  }

  TripResponseDto trip({List<TripStopDto>? stops, List<TripLegDto> legs = const []}) => TripResponseDto(
    albumId: 'album',
    kind: TripKind.places,
    isFavorites: false,
    isShowcased: false,
    isFeatured: false,
    isNaming: false,
    language: null,
    contentVersion: 1,
    stops: stops ?? [_stop('a', 'Biržai', placeId: 'x')],
    places: [TripPlaceDto(article: 'A town in the north.', articleSource: null, id: 'x', key: 'x', title: 'Biržai')],
    legs: legs,
  );

  testWidgets('tells about the place only outside edit mode, as the web', (tester) async {
    await pumpPanel(tester, trip(), openId: 'a', isEditing: false);
    expect(find.text('About this place'), findsOneWidget);

    await pumpPanel(tester, trip(), openId: 'a', isEditing: true);
    expect(find.text('About this place'), findsNothing);
  });

  testWidgets('an open leg names a stop it cannot find with an ellipsis, as the web', (tester) async {
    final leg = TripLegDto(
      id: 'leg',
      fromStopId: 'a',
      toStopId: 'gone',
      mode: TripLegMode.driving,
      isModeManual: false,
      status: TripLegStatus.ok,
      polyline: null,
      distance: null,
      duration: null,
      departureName: null,
      departureLatitude: null,
      departureLongitude: null,
      arrivalName: null,
      arrivalLatitude: null,
      arrivalLongitude: null,
    );
    await pumpPanel(tester, trip(legs: [leg]), openLeg: leg, isEditing: true);
    expect(find.text('Biržai → …'), findsOneWidget);
  });
}
