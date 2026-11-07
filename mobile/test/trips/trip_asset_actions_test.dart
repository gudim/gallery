import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:immich_mobile/trips/trip.provider.dart';
import 'package:immich_mobile/trips/trip_asset_actions.dart';
import 'package:immich_mobile/trips/trips_api.repository.dart';
import 'package:mocktail/mocktail.dart';
import 'package:openapi/api.dart';

import '../widget_tester_extensions.dart';

// After the web TripAssetActions.svelte: which actions the picked assets of a stop offer, and what each one sends.

class _MockTripsApiRepository extends Mock implements TripsApiRepository {}

TripStopDto _stop(String id, {int sequence = 0, String? title, TripStopRole? role, bool isAtCenter = false}) =>
    TripStopDto(
      country: null,
      id: id,
      isAddedByHand: false,
      isAtCenter: isAtCenter,
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
      title: title ?? id,
      titleSource: null,
    );

TripAssetDto _filing(String assetId, String? stopId, {TripPointSource? source}) =>
    TripAssetDto(assetId: assetId, stopId: stopId, latitude: 55, longitude: 25, pointSource: source);

TripResponseDto _trip(
  List<TripStopDto> stops,
  List<TripAssetDto> assets, {
  TripKind kind = TripKind.route,
  int contentVersion = 1,
}) => TripResponseDto(
  albumId: 'album',
  kind: kind,
  isFavorites: false,
  isShowcased: false,
  isFeatured: false,
  isNaming: false,
  language: null,
  contentVersion: contentVersion,
  stops: stops,
  assets: assets,
);

AssetResponseDto _asset(String id, int minute) => AssetResponseDto(
  id: id,
  ownerId: 'owner',
  checksum: 'checksum-$id',
  createdAt: DateTime.utc(2026, 5, 1),
  fileCreatedAt: DateTime.utc(2026, 5, 1, 10, minute),
  fileModifiedAt: DateTime.utc(2026, 5, 1, 10, minute),
  localDateTime: DateTime.utc(2026, 5, 1, 10, minute),
  updatedAt: DateTime.utc(2026, 5, 1),
  duration: null,
  hasMetadata: true,
  height: 1080,
  width: 1920,
  isArchived: false,
  isEdited: false,
  isFavorite: false,
  isOffline: false,
  isTrashed: false,
  originalFileName: '$id.jpg',
  originalPath: '/upload/$id.jpg',
  thumbhash: null,
  type: AssetTypeEnum.IMAGE,
  visibility: AssetVisibility.timeline,
);

// Three stops; `b` holds a1 and a2, `a` and `c` one asset each.
final _route = _trip(
  [_stop('a'), _stop('b', sequence: 1), _stop('c', sequence: 2), _stop('d', sequence: 3)],
  [_filing('a0', 'a'), _filing('a1', 'b'), _filing('a2', 'b', source: TripPointSource.manual), _filing('c0', 'c')],
);
final _assets = [_asset('a0', 0), _asset('a1', 1), _asset('a2', 2), _asset('c0', 3)];

void main() {
  late _MockTripsApiRepository repository;
  late List<String?> done;

  setUpAll(() {
    registerFallbackValue(<String>[]);
    registerFallbackValue(const TripPoint(latitude: 0, longitude: 0));
  });

  setUp(() {
    repository = _MockTripsApiRepository();
    done = [];
  });

  Future<void> open(
    WidgetTester tester,
    String itemId,
    List<String> ids, {
    TripResponseDto? trip,
    List<AssetResponseDto>? assets,
  }) async {
    when(() => repository.getTrip('album')).thenAnswer((_) async => trip ?? _route);
    when(() => repository.getAlbumAssets('album')).thenAnswer((_) async => assets ?? _assets);
    await tester.pumpConsumerWidget(
      Consumer(
        builder: (context, ref, _) {
          final data = ref.watch(tripDataProvider('album')).valueOrNull;
          final item = data?.view.order.where((item) => item.id == itemId).firstOrNull;
          if (data == null || item == null) {
            return const SizedBox.shrink();
          }
          return Align(
            alignment: Alignment.bottomCenter,
            child: TripAssetActions(data: data, item: item, ids: ids, onDone: done.add, onClear: () {}),
          );
        },
      ),
      overrides: [tripsApiRepositoryProvider.overrideWithValue(repository)],
    );
    await tester.pumpAndSettle();
  }

  Finder action(String key) => find.byKey(ValueKey(key));

  testWidgets('moves the picked assets to a stop picked from the list, the nearest stops first', (tester) async {
    when(() => repository.moveAssets('album', any(), any())).thenAnswer((_) async => _route);
    await open(tester, 'b', ['a1', 'a2']);

    await tester.tap(action('trip-move-to-stop'));
    await tester.pumpAndSettle();
    final titles = tester
        .widgetList<PopupMenuItem<String>>(find.byType(PopupMenuItem<String>))
        .map((item) => item.value)
        .toList();
    expect(titles, ['a', 'c', 'd']);

    await tester.tap(find.text('c').last);
    await tester.pumpAndSettle();

    verify(() => repository.moveAssets('album', ['a1', 'a2'], 'c')).called(1);
    expect(done, ['c']);
  });

  testWidgets('makes a new stop of the picked assets', (tester) async {
    when(() => repository.createStop('album', any())).thenAnswer((_) async => _route);
    await open(tester, 'b', ['a1', 'a2']);

    await tester.tap(action('trip-new-stop'));
    await tester.pumpAndSettle();

    verify(() => repository.createStop('album', ['a1', 'a2'])).called(1);
    expect(done, [null]);
  });

  testWidgets('splits a stop at one picked asset, but not at its first', (tester) async {
    when(() => repository.splitStop('album', 'b', 'a2')).thenAnswer((_) async => _route);
    await open(tester, 'b', ['a1']);
    expect(action('trip-split'), findsNothing);

    await open(tester, 'b', ['a2']);
    await tester.tap(action('trip-split'));
    await tester.pumpAndSettle();

    verify(() => repository.splitStop('album', 'b', 'a2')).called(1);
  });

  testWidgets('offers a point for one asset, and its reset only when the point was set by hand', (tester) async {
    when(() => repository.removeAssetPoint('album', 'a2')).thenAnswer((_) async => _route);
    await open(tester, 'b', ['a1', 'a2']);
    expect(action('trip-asset-point'), findsNothing);

    await open(tester, 'b', ['a1']);
    expect(action('trip-asset-point'), findsOneWidget);
    expect(action('trip-asset-point-reset'), findsNothing);

    await open(tester, 'b', ['a2']);
    await tester.tap(action('trip-asset-point-reset'));
    await tester.pumpAndSettle();

    verify(() => repository.removeAssetPoint('album', 'a2')).called(1);
  });

  testWidgets('files unplaced assets of a Places trip to its centre', (tester) async {
    final places = _trip(
      [_stop('center', role: TripStopRole.start, isAtCenter: true), _stop('p', sequence: 1)],
      [_filing('a0', 'p'), _filing('a1', null)],
      kind: TripKind.places,
    );
    when(() => repository.toCenter('album', any(), null)).thenAnswer((_) async => places);
    await open(tester, 'unplaced', ['a1'], trip: places);

    await tester.tap(action('trip-to-center'));
    await tester.pumpAndSettle();

    verify(() => repository.toCenter('album', ['a1'], null)).called(1);
  });

  testWidgets('hides the picked assets from the album once confirmed', (tester) async {
    when(() => repository.hideAssets('album', any())).thenAnswer((_) async => (trip: _route, count: 2));
    await open(tester, 'b', ['a1', 'a2']);

    await tester.tap(action('trip-hide'));
    await tester.pumpAndSettle();
    verifyNever(() => repository.hideAssets(any(), any()));

    await tester.tap(find.byType(TextButton).last);
    await tester.pumpAndSettle();

    verify(() => repository.hideAssets('album', ['a1', 'a2'])).called(1);
    expect(done, [null]);
    // Lets the toast of how many left go.
    await tester.pump(const Duration(seconds: 4));
  });

  testWidgets('keeps the album when the hide is cancelled', (tester) async {
    await open(tester, 'b', ['a1']);

    await tester.tap(action('trip-hide'));
    await tester.pumpAndSettle();
    await tester.tap(find.byType(TextButton).first);
    await tester.pumpAndSettle();

    verifyNever(() => repository.hideAssets(any(), any()));
    expect(done, isEmpty);
  });

  testWidgets('keeps the pick when an edit fails', (tester) async {
    when(() => repository.createStop('album', any())).thenThrow(Exception('offline'));
    await open(tester, 'b', ['a1']);

    await tester.tap(action('trip-new-stop'));
    await tester.pumpAndSettle();

    expect(done, isEmpty);
    await tester.pump(const Duration(seconds: 4));
  });
}
