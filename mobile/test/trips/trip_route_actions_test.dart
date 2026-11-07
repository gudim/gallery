import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:immich_mobile/trips/trip.provider.dart';
import 'package:immich_mobile/trips/trip_point.page.dart';
import 'package:immich_mobile/trips/trip_route_actions.dart';
import 'package:immich_mobile/trips/trips_api.repository.dart';
import 'package:mocktail/mocktail.dart';
import 'package:openapi/api.dart';

import '../widget_tester_extensions.dart';

// After the web TripPanel.svelte's route actions: a route without a start or a finish offers to set it, and any route
// takes a point added by hand.

class _MockTripsApiRepository extends Mock implements TripsApiRepository {}

TripStopDto _stop(String id, int sequence, {TripStopRole? role}) => TripStopDto(
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
  role: role,
  sequence: sequence,
  story: null,
  storySource: null,
  title: id,
  titleSource: null,
);

TripResponseDto _trip(List<TripStopDto> stops, {TripKind kind = TripKind.route}) => TripResponseDto(
  albumId: 'album',
  kind: kind,
  isFavorites: false,
  isShowcased: false,
  isFeatured: false,
  isNaming: false,
  language: null,
  contentVersion: 1,
  stops: stops,
);

void main() {
  late _MockTripsApiRepository repository;

  setUp(() {
    repository = _MockTripsApiRepository();
    when(() => repository.getAlbumAssets('album')).thenAnswer((_) async => []);
  });

  Future<void> open(WidgetTester tester, TripResponseDto trip) async {
    when(() => repository.getTrip('album')).thenAnswer((_) async => trip);
    await tester.pumpConsumerWidget(
      Consumer(
        builder: (context, ref, _) {
          final data = ref.watch(tripDataProvider('album')).valueOrNull;
          return data == null ? const SizedBox.shrink() : TripRouteActions(data: data);
        },
      ),
      overrides: [tripsApiRepositoryProvider.overrideWithValue(repository)],
    );
    await tester.pumpAndSettle();
  }

  Finder action(String key) => find.byKey(ValueKey(key));

  testWidgets('a route without a start or a finish offers both, and a point', (tester) async {
    await open(tester, _trip([_stop('a', 0)]));

    expect(action('trip-set-start'), findsOneWidget);
    expect(action('trip-set-finish'), findsOneWidget);
    expect(action('trip-add-route-point'), findsOneWidget);
    expect(action('trip-clock'), findsOneWidget);
  });

  testWidgets('a route with both ends offers neither', (tester) async {
    await open(
      tester,
      _trip([_stop('s', 0, role: TripStopRole.start), _stop('a', 1), _stop('f', 2, role: TripStopRole.finish)]),
    );

    expect(action('trip-set-start'), findsNothing);
    expect(action('trip-set-finish'), findsNothing);
    expect(action('trip-add-route-point'), findsOneWidget);
  });

  testWidgets('a places trip has no ends and no points', (tester) async {
    await open(tester, _trip([_stop('a', 0)], kind: TripKind.places));

    expect(action('trip-set-start'), findsNothing);
    expect(action('trip-set-finish'), findsNothing);
    expect(action('trip-add-route-point'), findsNothing);
    expect(action('trip-clock'), findsOneWidget);
  });

  testWidgets('setting the start picks its point first, from the first stop', (tester) async {
    await open(tester, _trip([_stop('a', 0)]));

    await tester.tap(action('trip-set-start'));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 400));
    // The picker's map reads Gallery's settings, which widget tests do not start; the page's arguments are what counts.
    tester.takeException();

    final page = tester.widget<TripPointPage>(find.byType(TripPointPage));
    expect(page.isNamed, isTrue);
    expect(page.initial?.latitude, 55);
    expect(page.initial?.longitude, 25);
  });
}
