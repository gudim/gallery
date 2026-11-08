import 'package:fake_async/fake_async.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:immich_mobile/trips/trip.provider.dart';
import 'package:immich_mobile/trips/trips_api.repository.dart';
import 'package:mocktail/mocktail.dart';

// The album menu asks whether the album has a trip each time it opens; the answer is kept a while after it closes.

class _MockTripsApiRepository extends Mock implements TripsApiRepository {}

void main() {
  late _MockTripsApiRepository repository;

  setUp(() => repository = _MockTripsApiRepository());

  /// Opens the menu once: listens until the answer comes, then closes it.
  void openMenu(FakeAsync async, ProviderContainer container) {
    final subscription = container.listen(tripExistsProvider('album'), (_, _) {});
    async.flushMicrotasks();
    subscription.close();
    // Riverpod disposes an unlistened provider on a zero timer.
    async.elapse(Duration.zero);
  }

  test('keeps the answer for a while after the menu closes', () {
    fakeAsync((async) {
      when(() => repository.getTrip('album')).thenAnswer((_) async => null);
      final container = ProviderContainer(overrides: [tripsApiRepositoryProvider.overrideWithValue(repository)]);
      addTearDown(container.dispose);

      openMenu(async, container);
      async.elapse(tripExistsCacheTime - const Duration(seconds: 1));
      openMenu(async, container);
      verify(() => repository.getTrip('album')).called(1);

      async.elapse(tripExistsCacheTime + const Duration(seconds: 1));
      openMenu(async, container);
      verify(() => repository.getTrip('album')).called(1);
    });
  });

  test('asks again next time when the answer failed', () {
    fakeAsync((async) {
      when(() => repository.getTrip('album')).thenAnswer((_) async => throw Exception('offline'));
      final container = ProviderContainer(overrides: [tripsApiRepositoryProvider.overrideWithValue(repository)]);
      addTearDown(container.dispose);

      openMenu(async, container);
      openMenu(async, container);
      verify(() => repository.getTrip('album')).called(2);
    });
  });
}
