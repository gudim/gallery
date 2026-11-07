import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:immich_mobile/trips/trip_create_dialog.dart';
import 'package:immich_mobile/trips/trips_api.repository.dart';
import 'package:mocktail/mocktail.dart';
import 'package:openapi/api.dart';

import '../widget_tester_extensions.dart';

class _MockTripsApiRepository extends Mock implements TripsApiRepository {}

void main() {
  late _MockTripsApiRepository repository;
  bool? result;

  setUpAll(() => registerFallbackValue(TripKind.route));

  setUp(() {
    repository = _MockTripsApiRepository();
    result = null;
  });

  Future<void> open(WidgetTester tester) async {
    await tester.pumpConsumerWidget(
      Builder(
        builder: (context) => TextButton(
          onPressed: () async => result = await showTripCreateDialog(context, albumId: 'album-1'),
          child: const Text('open'),
        ),
      ),
      overrides: [tripsApiRepositoryProvider.overrideWithValue(repository)],
    );
    await tester.tap(find.text('open'));
    await tester.pumpAndSettle();
  }

  testWidgets('makes a route by default', (tester) async {
    when(() => repository.createTrip(any(), any(), any())).thenAnswer((_) async {});
    await open(tester);

    await tester.tap(find.byKey(const ValueKey('trip-create-confirm')));
    await tester.pumpAndSettle();

    verify(() => repository.createTrip('album-1', TripKind.route, any())).called(1);
    expect(result, isTrue);
  });

  testWidgets('makes the kind picked', (tester) async {
    when(() => repository.createTrip(any(), any(), any())).thenAnswer((_) async {});
    await open(tester);

    await tester.tap(find.byKey(const ValueKey('trip-kind-places')));
    await tester.pump();
    await tester.tap(find.byKey(const ValueKey('trip-create-confirm')));
    await tester.pumpAndSettle();

    verify(() => repository.createTrip('album-1', TripKind.places, any())).called(1);
    expect(result, isTrue);
  });

  testWidgets('makes nothing when cancelled', (tester) async {
    await open(tester);

    await tester.tap(find.byKey(const ValueKey('trip-create-cancel')));
    await tester.pumpAndSettle();

    verifyNever(() => repository.createTrip(any(), any(), any()));
    expect(result, isNot(isTrue));
  });

  testWidgets('stays open and says so when the trip cannot be made', (tester) async {
    when(() => repository.createTrip(any(), any(), any())).thenThrow(ApiException(400, 'album already has a trip'));
    await open(tester);

    await tester.tap(find.byKey(const ValueKey('trip-create-confirm')));
    await tester.pumpAndSettle();

    expect(find.byKey(const ValueKey('trip-create-error')), findsOneWidget);
    expect(find.byKey(const ValueKey('trip-create-confirm')), findsOneWidget);
    expect(result, isNull);
  });
}
