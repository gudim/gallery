import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:immich_mobile/trips/trip.provider.dart';
import 'package:immich_mobile/trips/trip_leg_edit.dart';
import 'package:immich_mobile/trips/trips_api.repository.dart';
import 'package:mocktail/mocktail.dart';
import 'package:openapi/api.dart';

import '../widget_tester_extensions.dart';

// After the web TripLegEdit.svelte: a leg's mode, its retry, and a train's stations.

class _MockTripsApiRepository extends Mock implements TripsApiRepository {}

TripStopDto _stop(String id, int sequence) => TripStopDto(
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
  sequence: sequence,
  story: null,
  storySource: null,
  title: id,
  titleSource: null,
);

TripLegDto _leg({
  TripLegMode mode = TripLegMode.driving,
  bool isModeManual = false,
  TripLegStatus status = TripLegStatus.ok,
  String? departureName,
  double? departureLatitude,
}) => TripLegDto(
  arrivalLatitude: null,
  arrivalLongitude: null,
  arrivalName: null,
  departureLatitude: departureLatitude,
  departureLongitude: departureLatitude == null ? null : 25,
  departureName: departureName,
  distance: 12000,
  duration: 900,
  fromStopId: 'a',
  id: 'leg',
  isModeManual: isModeManual,
  mode: mode,
  polyline: null,
  status: status,
  toStopId: 'b',
);

TripResponseDto _trip(TripLegDto leg, {int contentVersion = 1}) => TripResponseDto(
  albumId: 'album',
  kind: TripKind.route,
  isFavorites: false,
  isShowcased: false,
  isFeatured: false,
  isNaming: false,
  language: null,
  contentVersion: contentVersion,
  stops: [_stop('a', 0), _stop('b', 1)],
  legs: [leg],
);

TripStationDto _station(String name, double latitude, int distance) =>
    TripStationDto(name: name, latitude: latitude, longitude: 25, distance: distance);

void main() {
  late _MockTripsApiRepository repository;

  setUpAll(() => registerFallbackValue(TripStationDto(name: '', latitude: 0, longitude: 0, distance: 0)));

  setUp(() {
    repository = _MockTripsApiRepository();
    when(() => repository.getAlbumAssets('album')).thenAnswer((_) async => []);
  });

  Future<void> open(WidgetTester tester, TripLegDto leg) async {
    when(() => repository.getTrip('album')).thenAnswer((_) async => _trip(leg));
    await tester.pumpConsumerWidget(
      Consumer(
        builder: (context, ref, _) {
          final data = ref.watch(tripDataProvider('album')).valueOrNull;
          final shown = data?.trip.legs.firstOrNull;
          if (data == null || shown == null) {
            return const SizedBox.shrink();
          }
          return SingleChildScrollView(
            child: TripLegEdit(data: data, leg: shown),
          );
        },
      ),
      overrides: [tripsApiRepositoryProvider.overrideWithValue(repository)],
    );
    await tester.pumpAndSettle();
  }

  Future<void> pick(WidgetTester tester, Finder field, String label) async {
    await tester.tap(field);
    await tester.pumpAndSettle();
    await tester.tap(find.text(label).last);
    await tester.pumpAndSettle();
  }

  testWidgets('sets a mode by hand, and returns to the mode by distance', (tester) async {
    when(
      () => repository.setLegMode('album', 'leg', TripLegMode.bus),
    ).thenAnswer((_) async => _trip(_leg(mode: TripLegMode.bus, isModeManual: true), contentVersion: 2));
    when(() => repository.setLegMode('album', 'leg', null)).thenAnswer((_) async => _trip(_leg(), contentVersion: 3));
    await open(tester, _leg());

    final field = find.byKey(const ValueKey('trip-leg-mode'));
    expect(find.descendant(of: field, matching: find.text('by distance')), findsOneWidget);

    await pick(tester, field, 'by bus');
    verify(() => repository.setLegMode('album', 'leg', TripLegMode.bus)).called(1);
    expect(find.descendant(of: field, matching: find.text('by bus')), findsOneWidget);

    await pick(tester, field, 'by distance');
    verify(() => repository.setLegMode('album', 'leg', null)).called(1);
  });

  testWidgets('never offers a trail', (tester) async {
    await open(tester, _leg());

    await tester.tap(find.byKey(const ValueKey('trip-leg-mode')));
    await tester.pumpAndSettle();

    expect(find.text('trail'), findsNothing);
  });

  testWidgets('shows the mode the server holds again when the change fails', (tester) async {
    when(
      () => repository.setLegMode('album', 'leg', TripLegMode.boat),
    ).thenAnswer((_) async => throw Exception('offline'));
    await open(tester, _leg());

    final field = find.byKey(const ValueKey('trip-leg-mode'));
    await pick(tester, field, 'by boat');

    expect(find.descendant(of: field, matching: find.text('by distance')), findsOneWidget);
    // The error toast's own timer.
    await tester.pump(const Duration(seconds: 4));
  });

  testWidgets('offers a retry only for a leg that could not be routed', (tester) async {
    when(() => repository.retryLeg('album', 'leg')).thenAnswer((_) async => _trip(_leg(), contentVersion: 2));
    await open(tester, _leg(status: TripLegStatus.attention));

    await tester.tap(find.byKey(const ValueKey('trip-leg-retry')));
    await tester.pumpAndSettle();

    verify(() => repository.retryLeg('album', 'leg')).called(1);
    expect(find.byKey(const ValueKey('trip-leg-retry')), findsNothing);
  });

  testWidgets('a car leg asks for no stations', (tester) async {
    await open(tester, _leg());

    verifyNever(() => repository.getLegStations(any(), any()));
  });

  testWidgets('a train leg lists the stations near both ends, and sets the one picked', (tester) async {
    final near = _station('Biržai', 56.2, 400);
    when(
      () => repository.getLegStations('album', 'leg'),
    ).thenAnswer((_) async => TripLegStationsDto(departure: [near, _station('', 56.3, 2500)], arrival: const []));
    when(() => repository.setLegStation('album', 'leg', TripStationSide.departure, any())).thenAnswer(
      (_) async =>
          _trip(_leg(mode: TripLegMode.train, departureName: 'Biržai', departureLatitude: 56.2), contentVersion: 2),
    );
    await open(tester, _leg(mode: TripLegMode.train));

    expect(find.text('No station nearby'), findsOneWidget);
    await pick(tester, find.text('Pick a station'), 'Biržai · 0.4 km');

    final sent =
        verify(() => repository.setLegStation('album', 'leg', TripStationSide.departure, captureAny())).captured.single
            as TripStationDto;
    expect(sent.name, 'Biržai');
    // Read once for the leg, not again for every read of the trip.
    verify(() => repository.getLegStations('album', 'leg')).called(1);
  });

  testWidgets('says so when the stations cannot be read', (tester) async {
    when(() => repository.getLegStations('album', 'leg')).thenAnswer((_) async => throw Exception('overpass'));
    await open(tester, _leg(mode: TripLegMode.train));

    expect(find.text('Stations could not be loaded'), findsOneWidget);
  });
}
