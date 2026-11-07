import 'dart:async';

import 'package:fake_async/fake_async.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:immich_mobile/trips/trip.provider.dart';
import 'package:immich_mobile/trips/trips_api.repository.dart';
import 'package:mocktail/mocktail.dart';
import 'package:openapi/api.dart';

// Ported from web/src/lib/trips/trip-editor.spec.ts.

class _MockTripsApiRepository extends Mock implements TripsApiRepository {}

TripLegDto _leg(TripLegStatus status) => TripLegDto(
  id: 'leg',
  fromStopId: 'a',
  toStopId: 'b',
  mode: TripLegMode.driving,
  isModeManual: false,
  status: status,
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

TripResponseDto _trip({
  int contentVersion = 1,
  bool isNaming = false,
  List<TripLegDto> legs = const [],
  TripKind kind = TripKind.route,
}) => TripResponseDto(
  albumId: 'album',
  kind: kind,
  isFavorites: false,
  isShowcased: false,
  isFeatured: false,
  isNaming: isNaming,
  language: null,
  contentVersion: contentVersion,
  legs: legs,
);

void main() {
  late _MockTripsApiRepository repository;

  setUp(() {
    repository = _MockTripsApiRepository();
    when(() => repository.getAlbumAssets('album')).thenAnswer((_) async => []);
  });

  /// Opens the trip, lets `seconds` pass, and returns how often the trip was read and the trip shown last.
  (int, TripResponseDto?) run(List<TripResponseDto> reads, int seconds) {
    late (int, TripResponseDto?) result;
    fakeAsync((async) {
      var calls = 0;
      when(() => repository.getTrip('album')).thenAnswer((_) async => reads[(calls++).clamp(0, reads.length - 1)]);
      final container = ProviderContainer(overrides: [tripsApiRepositoryProvider.overrideWithValue(repository)]);
      final subscription = container.listen(tripDataProvider('album'), (_, _) {});
      async.flushMicrotasks();
      async.elapse(Duration(seconds: seconds));
      result = (calls, container.read(tripDataProvider('album')).valueOrNull?.trip);
      subscription.close();
      container.dispose();
    });
    return result;
  }

  test('reads the trip again while a leg is routed, and shows the new one', () {
    final (calls, shown) = run([
      _trip(legs: [_leg(TripLegStatus.pending)]),
      _trip(contentVersion: 2, legs: [_leg(TripLegStatus.ok)]),
    ], 30);

    expect(calls, 2);
    expect(shown?.contentVersion, 2);
  });

  test('reads the trip again while stops are being named, though nothing a guest sees changed', () {
    final (calls, _) = run([_trip(isNaming: true), _trip(isNaming: true), _trip()], 30);

    expect(calls, 3);
  });

  test('does not read a trip with nothing pending', () {
    final (calls, _) = run([_trip()], 30);

    expect(calls, 1);
  });

  test('keeps reading after a failed read', () {
    var calls = 0;
    fakeAsync((async) {
      when(() => repository.getTrip('album')).thenAnswer((_) async {
        calls++;
        if (calls == 2) {
          throw ApiException(500, 'down');
        }
        return _trip(isNaming: calls < 3, contentVersion: calls);
      });
      final container = ProviderContainer(overrides: [tripsApiRepositoryProvider.overrideWithValue(repository)]);
      final subscription = container.listen(tripDataProvider('album'), (_, _) {});
      async.flushMicrotasks();
      async.elapse(const Duration(seconds: 30));
      expect(container.read(tripDataProvider('album')).valueOrNull?.trip.contentVersion, 3);
      subscription.close();
      container.dispose();
    });
    expect(calls, 3);
  });

  group('run', () {
    test('shows the trip an edit answers', () async {
      when(() => repository.getTrip('album')).thenAnswer((_) async => _trip());
      final container = ProviderContainer(overrides: [tripsApiRepositoryProvider.overrideWithValue(repository)]);
      addTearDown(container.dispose);
      await container.read(tripDataProvider('album').future);

      final isDone = await container
          .read(tripDataProvider('album').notifier)
          .run((albumId) async => _trip(kind: TripKind.places, contentVersion: 2));

      final data = container.read(tripDataProvider('album')).valueOrNull;
      expect(isDone, isTrue);
      expect(data?.view.kind, TripKind.places);
      expect(data?.isBusy, isFalse);
    });

    test('keeps the trip when an edit is refused', () async {
      when(() => repository.getTrip('album')).thenAnswer((_) async => _trip());
      final container = ProviderContainer(overrides: [tripsApiRepositoryProvider.overrideWithValue(repository)]);
      addTearDown(container.dispose);
      await container.read(tripDataProvider('album').future);

      final isDone = await container
          .read(tripDataProvider('album').notifier)
          .run((albumId) async => throw ApiException(400, 'refused'));

      final data = container.read(tripDataProvider('album')).valueOrNull;
      expect(isDone, isFalse);
      expect(data?.trip.contentVersion, 1);
      expect(data?.isBusy, isFalse);
    });

    test('is busy while the edit runs', () async {
      when(() => repository.getTrip('album')).thenAnswer((_) async => _trip());
      final container = ProviderContainer(overrides: [tripsApiRepositoryProvider.overrideWithValue(repository)]);
      addTearDown(container.dispose);
      await container.read(tripDataProvider('album').future);
      final answer = Completer<TripResponseDto>();

      final edit = container.read(tripDataProvider('album').notifier).run((albumId) => answer.future);
      expect(container.read(tripDataProvider('album')).valueOrNull?.isBusy, isTrue);
      answer.complete(_trip(contentVersion: 2));
      await edit;

      expect(container.read(tripDataProvider('album')).valueOrNull?.isBusy, isFalse);
    });

    test('drops a read that answers while an edit runs, since the edit is newer', () {
      fakeAsync((async) {
        var calls = 0;
        when(() => repository.getTrip('album')).thenAnswer((_) async {
          calls++;
          return calls == 1 ? _trip(isNaming: true) : _trip(contentVersion: 5);
        });
        final container = ProviderContainer(overrides: [tripsApiRepositoryProvider.overrideWithValue(repository)]);
        final subscription = container.listen(tripDataProvider('album'), (_, _) {});
        async.flushMicrotasks();
        final answer = Completer<TripResponseDto>();
        unawaited(container.read(tripDataProvider('album').notifier).run((albumId) => answer.future));

        async.elapse(TripDataNotifier.pollInterval);
        expect(calls, 2);
        expect(container.read(tripDataProvider('album')).valueOrNull?.trip.contentVersion, 1);

        answer.complete(_trip(contentVersion: 3));
        async.flushMicrotasks();
        expect(container.read(tripDataProvider('album')).valueOrNull?.trip.contentVersion, 3);
        subscription.close();
        container.dispose();
      });
    });
  });
}
