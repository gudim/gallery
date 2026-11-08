import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:immich_mobile/trips/trip_point.page.dart';
import 'package:immich_mobile/trips/trips_api.repository.dart';
import 'package:maplibre_gl/maplibre_gl.dart';
import 'package:mocktail/mocktail.dart';
import 'package:openapi/api.dart';

import '../widget_tester_extensions.dart';

// After web TripPointModal.svelte: a point found by search or tapped on the map; a stop's point proposes a name.

class _MockTripsApiRepository extends Mock implements TripsApiRepository {}

TripGeoPlaceDto _place(String label, double latitude, double longitude) => TripGeoPlaceDto(
  country: 'Lithuania',
  district: null,
  label: label,
  latitude: latitude,
  longitude: longitude,
  region: 'Panevėžys',
);

void main() {
  late _MockTripsApiRepository repository;
  TripPoint? result;
  late bool isClosed;

  setUpAll(() => registerFallbackValue(const LatLng(0, 0)));

  setUp(() {
    repository = _MockTripsApiRepository();
    result = null;
    isClosed = false;
  });

  Future<void> open(WidgetTester tester, {bool isNamed = true}) async {
    await tester.pumpConsumerWidget(
      Builder(
        builder: (context) => TextButton(
          onPressed: () async {
            result = await Navigator.of(context).push<TripPoint>(
              MaterialPageRoute(
                builder: (_) => TripPointPage(
                  albumId: 'album',
                  title: 'Start',
                  isNamed: isNamed,
                  mapOverride: (onTap) => GestureDetector(
                    key: const ValueKey('map'),
                    onTap: () => onTap(const LatLng(56.2, 24.75)),
                    child: const ColoredBox(color: Colors.grey),
                  ),
                ),
              ),
            );
            isClosed = true;
          },
          child: const Text('open'),
        ),
      ),
      overrides: [tripsApiRepositoryProvider.overrideWithValue(repository)],
    );
    await tester.tap(find.text('open'));
    await tester.pumpAndSettle();
  }

  TextButton saveButton(WidgetTester tester) =>
      tester.widget<TextButton>(find.byKey(const ValueKey('trip-point-save')));

  testWidgets('cannot save before a point is picked', (tester) async {
    await open(tester);

    expect(saveButton(tester).onPressed, isNull);
  });

  testWidgets('a place found by search becomes the point and its name', (tester) async {
    when(() => repository.searchPlaces('album', 'Biržai')).thenAnswer((_) async => [_place('Biržai', 56.2, 24.75)]);
    await open(tester);

    await tester.enterText(find.byKey(const ValueKey('trip-point-search')), 'Biržai');
    await tester.pump(const Duration(milliseconds: 500));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Biržai').last);
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const ValueKey('trip-point-save')));
    await tester.pumpAndSettle();

    expect(isClosed, isTrue);
    expect(result?.at.latitude, 56.2);
    expect(result?.at.longitude, 24.75);
    expect(result?.title, 'Biržai');
  });

  testWidgets('clearing the search drops the answer of a search still on its way', (tester) async {
    when(() => repository.searchPlaces('album', 'Bir')).thenAnswer((_) async {
      await Future<void>.delayed(const Duration(seconds: 1));
      return [_place('Biržai', 56.2, 24.75)];
    });
    await open(tester);

    await tester.enterText(find.byKey(const ValueKey('trip-point-search')), 'Bir');
    await tester.pump(const Duration(milliseconds: 500));
    verify(() => repository.searchPlaces('album', 'Bir')).called(1);
    await tester.enterText(find.byKey(const ValueKey('trip-point-search')), '');
    await tester.pump(const Duration(seconds: 2));
    await tester.pumpAndSettle();

    expect(find.text('Biržai'), findsNothing);
  });

  testWidgets('a point tapped on the map takes the name Nominatim gives it', (tester) async {
    when(
      () => repository.reversePlace('album', const LatLng(56.2, 24.75)),
    ).thenAnswer((_) async => [_place('Astravas', 56.2, 24.75)]);
    await open(tester);

    await tester.tap(find.byKey(const ValueKey('map')));
    await tester.pumpAndSettle();
    expect(find.text('Astravas'), findsOneWidget);
    await tester.tap(find.byKey(const ValueKey('trip-point-save')));
    await tester.pumpAndSettle();

    expect(result?.title, 'Astravas');
  });

  testWidgets('a name typed by the owner is kept over the one Nominatim gives later', (tester) async {
    when(() => repository.reversePlace(any(), any())).thenAnswer((_) async {
      await Future<void>.delayed(const Duration(seconds: 1));
      return [_place('Astravas', 56.2, 24.75)];
    });
    await open(tester);

    await tester.tap(find.byKey(const ValueKey('map')));
    await tester.pump();
    await tester.enterText(find.byKey(const ValueKey('trip-point-name')), 'Bridge');
    await tester.pump(const Duration(seconds: 2));
    await tester.tap(find.byKey(const ValueKey('trip-point-save')));
    await tester.pumpAndSettle();

    expect(result?.title, 'Bridge');
  });

  testWidgets("an asset's point asks for no name", (tester) async {
    await open(tester, isNamed: false);

    expect(find.byKey(const ValueKey('trip-point-name')), findsNothing);
    await tester.tap(find.byKey(const ValueKey('map')));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const ValueKey('trip-point-save')));
    await tester.pumpAndSettle();

    verifyNever(() => repository.reversePlace(any(), any()));
    expect(result?.at.latitude, 56.2);
    expect(result?.title, '');
  });
}
