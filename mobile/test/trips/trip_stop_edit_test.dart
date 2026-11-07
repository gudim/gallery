import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:immich_mobile/trips/trip.provider.dart';
import 'package:immich_mobile/trips/trip_stop_edit.dart';
import 'package:immich_mobile/trips/trip_view.dart';
import 'package:immich_mobile/trips/trips_api.repository.dart';
import 'package:mocktail/mocktail.dart';
import 'package:openapi/api.dart';

import '../widget_tester_extensions.dart';

// After the web TripStopEdit.svelte: which actions a stop offers, the autosave of its texts, and the delete prompt.

class _MockTripsApiRepository extends Mock implements TripsApiRepository {}

TripStopDto _stop(String id, {TripStopRole? role, String? title, int sequence = 0, bool isAddedByHand = false}) =>
    TripStopDto(
      country: null,
      id: id,
      isAddedByHand: isAddedByHand,
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
      title: title,
      titleSource: null,
    );

TripResponseDto _trip(List<TripStopDto> stops, {int contentVersion = 1}) => TripResponseDto(
  albumId: 'album',
  kind: TripKind.route,
  isFavorites: false,
  isShowcased: false,
  isFeatured: false,
  isNaming: false,
  language: null,
  contentVersion: contentVersion,
  stops: stops,
);

void main() {
  late _MockTripsApiRepository repository;
  late int gone;

  setUpAll(() => registerFallbackValue(TripStopUpdateDto()));

  setUp(() {
    repository = _MockTripsApiRepository();
    gone = 0;
    when(() => repository.getAlbumAssets('album')).thenAnswer((_) async => []);
  });

  Future<void> open(WidgetTester tester, TripResponseDto trip, String stopId, {ValueNotifier<bool>? isOpen}) async {
    when(() => repository.getTrip('album')).thenAnswer((_) async => trip);
    final shown = isOpen ?? ValueNotifier(true);
    await tester.pumpConsumerWidget(
      Consumer(
        builder: (context, ref, _) {
          final data = ref.watch(tripDataProvider('album')).valueOrNull;
          final item = data?.view.stops.where((stop) => stop.id == stopId).firstOrNull;
          if (data == null || item == null || !shown.value) {
            return const SizedBox.shrink();
          }
          return SingleChildScrollView(
            child: TripStopEdit(data: data, item: item, onGone: () => gone++, onMovePin: (_) {}),
          );
        },
      ),
      overrides: [tripsApiRepositoryProvider.overrideWithValue(repository)],
    );
    await tester.pumpAndSettle();
  }

  testWidgets('offers to delete a stop without assets, and deletes it once confirmed', (tester) async {
    when(() => repository.deleteStop('album', 'b')).thenAnswer((_) async => _trip([_stop('a')], contentVersion: 2));
    await open(tester, _trip([_stop('a'), _stop('b', sequence: 1)]), 'b');

    expect(find.byKey(const ValueKey('trip-merge-next')), findsNothing);
    await tester.tap(find.byKey(const ValueKey('trip-delete-stop')));
    await tester.pumpAndSettle();
    verifyNever(() => repository.deleteStop(any(), any()));

    await tester.tap(find.byType(TextButton).last);
    await tester.pumpAndSettle();

    verify(() => repository.deleteStop('album', 'b')).called(1);
    expect(gone, 1);
  });

  testWidgets('keeps the stop when the delete is cancelled', (tester) async {
    await open(tester, _trip([_stop('a')]), 'a');

    await tester.tap(find.byKey(const ValueKey('trip-delete-stop')));
    await tester.pumpAndSettle();
    await tester.tap(find.byType(TextButton).first);
    await tester.pumpAndSettle();

    verifyNever(() => repository.deleteStop(any(), any()));
    expect(gone, 0);
  });

  testWidgets('saves the title a second after typing stops, and only what changed', (tester) async {
    TripStopUpdateDto? sent;
    when(() => repository.updateStop('album', 'a', any())).thenAnswer((invocation) async {
      sent = invocation.positionalArguments[2] as TripStopUpdateDto;
      return _trip([_stop('a', title: 'Biržai')], contentVersion: 2);
    });
    await open(tester, _trip([_stop('a')]), 'a');

    await tester.enterText(find.byKey(const ValueKey('trip-stop-title')), 'Biržai');
    await tester.pump(const Duration(milliseconds: 500));
    verifyNever(() => repository.updateStop(any(), any(), any()));

    await tester.pump(const Duration(milliseconds: 600));
    await tester.pumpAndSettle();

    verify(() => repository.updateStop('album', 'a', any())).called(1);
    expect(sent?.title.orElse(null), 'Biržai');
    expect(sent?.story.isPresent, isFalse);
  });

  testWidgets('saves the typed title when the stop is closed before the second is up', (tester) async {
    final isOpen = ValueNotifier(true);
    when(
      () => repository.updateStop('album', 'a', any()),
    ).thenAnswer((_) async => _trip([_stop('a', title: 'Biržai')], contentVersion: 2));
    await open(tester, _trip([_stop('a')]), 'a', isOpen: isOpen);

    await tester.enterText(find.byKey(const ValueKey('trip-stop-title')), 'Biržai');
    await tester.pump(const Duration(milliseconds: 300));
    isOpen.value = false;
    // The Consumer listens to the provider only; rebuild it the way the page does when the stop closes.
    tester.element(find.byType(Consumer)).markNeedsBuild();
    await tester.pump();
    await tester.pumpAndSettle();

    expect(tester.takeException(), isNull);
    expect(find.byType(TripStopEdit), findsNothing);
    verify(() => repository.updateStop('album', 'a', any())).called(1);
  });

  testWidgets('a start has no story, and offers its removal', (tester) async {
    when(() => repository.removeStart('album')).thenAnswer((_) async => _trip([_stop('a')], contentVersion: 2));
    await open(tester, _trip([_stop('s', role: TripStopRole.start), _stop('a', sequence: 1)]), 's');

    expect(find.byKey(const ValueKey('trip-stop-story')), findsNothing);
    expect(find.byKey(const ValueKey('trip-delete-stop')), findsNothing);
    await tester.tap(find.byKey(const ValueKey('trip-remove-end')));
    await tester.pumpAndSettle();

    verify(() => repository.removeStart('album')).called(1);
    expect(gone, 1);
  });

  testWidgets('a point added by hand on a route can go after another stop', (tester) async {
    when(
      () => repository.movePoint('album', 'p', 'b'),
    ).thenAnswer((_) async => _trip([_stop('a'), _stop('b', sequence: 1)], contentVersion: 2));
    await open(
      tester,
      _trip([_stop('a'), _stop('p', sequence: 1, isAddedByHand: true), _stop('b', sequence: 2, title: 'B')]),
      'p',
    );

    await tester.tap(find.byKey(const ValueKey('trip-stop-order')));
    await tester.pumpAndSettle();
    await tester.tap(find.text('B').last);
    await tester.pumpAndSettle();

    verify(() => repository.movePoint('album', 'p', 'b')).called(1);
  });

  test('the view the tests build keeps empty stops on a route', () {
    final view = buildTripView(_trip([_stop('a'), _stop('b', sequence: 1)]), const []);
    expect(view.stops.map((stop) => stop.id), ['a', 'b']);
  });
}
