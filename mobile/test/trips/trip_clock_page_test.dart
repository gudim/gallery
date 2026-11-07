import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:immich_mobile/trips/trip_clock.page.dart';
import 'package:immich_mobile/trips/trips_api.repository.dart';
import 'package:mocktail/mocktail.dart';
import 'package:openapi/api.dart';

import '../widget_tester_extensions.dart';

// After the web TripClockModal.svelte: the cameras, the suggested shift, and what a shift sends.

class _MockTripsApiRepository extends Mock implements TripsApiRepository {}

TripCameraDto _camera(
  String model, {
  bool isReference = false,
  List<String> own = const ['a1', 'a2'],
  int count = 2,
  int? offset,
}) => TripCameraDto(
  make: 'Canon',
  model: model,
  isVideo: false,
  assetCount: count,
  gpsCount: isReference ? count : 0,
  isReference: isReference,
  ownAssetIds: own,
  suggestion: offset == null ? null : TripCameraDtoSuggestion(offsetMinutes: offset, best: 0.9, current: 0.4),
);

void main() {
  late _MockTripsApiRepository repository;

  setUp(() {
    repository = _MockTripsApiRepository();
    when(() => repository.getAlbumAssets('album')).thenAnswer((_) async => []);
    when(() => repository.getTrip('album')).thenAnswer(
      (_) async => TripResponseDto(
        albumId: 'album',
        kind: TripKind.route,
        isFavorites: false,
        isShowcased: false,
        isFeatured: false,
        isNaming: false,
        language: null,
        contentVersion: 1,
      ),
    );
  });

  Future<void> open(WidgetTester tester, List<TripCameraDto> cameras) async {
    when(() => repository.getCameras('album')).thenAnswer((_) async => cameras);
    await tester.pumpConsumerWidget(
      Builder(
        builder: (context) =>
            TextButton(onPressed: () => showTripClockPage(context, 'album'), child: const Text('open')),
      ),
      overrides: [tripsApiRepositoryProvider.overrideWithValue(repository)],
    );
    await tester.tap(find.text('open'));
    await tester.pumpAndSettle();
  }

  Finder shift(String model) => find.byKey(ValueKey('trip-camera-shift-Canon|$model|false'));

  testWidgets('suggests a shift and sends it for the caller\'s own assets', (tester) async {
    when(() => repository.shiftDates(['a1', 'a2'], -39)).thenAnswer((_) async {});
    await open(tester, [_camera('R6', isReference: true), _camera('G7', offset: -39)]);

    expect(find.text('Has GPS: the other cameras are timed by its stops.'), findsOneWidget);
    expect(shift('R6'), findsNothing);
    expect(find.textContaining('−39 min'), findsOneWidget);

    await tester.tap(shift('G7'));
    await tester.pumpAndSettle();
    await tester.pump(const Duration(seconds: 4));

    verify(() => repository.shiftDates(['a1', 'a2'], -39)).called(1);
    expect(find.text('open'), findsOneWidget);
  });

  testWidgets('offers no shift of none, nor of assets that belong to others', (tester) async {
    await open(tester, [_camera('G7'), _camera('M50', own: const [], count: 3)]);

    expect(tester.widget<FilledButton>(shift('G7')).onPressed, isNull);
    expect(tester.widget<FilledButton>(shift('M50')).onPressed, isNull);
    expect(find.textContaining('3 of its photos belong to others'), findsOneWidget);

    await tester.enterText(find.byKey(const ValueKey('trip-camera-minutes-Canon|G7|false')), '15');
    await tester.pump();
    expect(tester.widget<FilledButton>(shift('G7')).onPressed, isNotNull);
  });
}
