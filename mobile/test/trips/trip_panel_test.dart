import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:immich_mobile/trips/trip.provider.dart';
import 'package:immich_mobile/trips/trip_panel.dart';
import 'package:immich_mobile/trips/trip_view.dart';
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

AssetResponseDto _asset(String id) => AssetResponseDto(
  id: id,
  ownerId: 'owner',
  checksum: 'checksum-$id',
  createdAt: DateTime.utc(2026, 5, 1),
  fileCreatedAt: DateTime.utc(2026, 5, 1, 10),
  fileModifiedAt: DateTime.utc(2026, 5, 1, 10),
  localDateTime: DateTime.utc(2026, 5, 1, 10),
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
    List<String>? clusterIds,
    void Function(TripItem item)? onOpen,
    VoidCallback? onClearCluster,
    required bool isEditing,
  }) async {
    final repository = _MockTripsApiRepository();
    when(
      () => repository.getAlbumAssets('album'),
    ).thenAnswer((_) async => [for (final filing in trip.assets) _asset(filing.assetId)]);
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
                  onOpen: onOpen ?? (_) {},
                  onBack: () {},
                  onMovePin: (_) {},
                  cluster: clusterIds == null ? null : data.view.itemsOf(clusterIds),
                  onClearCluster: onClearCluster ?? () {},
                );
        },
      ),
      overrides: [tripsApiRepositoryProvider.overrideWithValue(repository)],
    );
    await tester.pumpAndSettle();
  }

  TripResponseDto trip({
    List<TripStopDto>? stops,
    List<TripLegDto> legs = const [],
    List<TripAssetDto> assets = const [],
  }) => TripResponseDto(
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
    assets: assets,
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

  testWidgets('lists the stops under a tap on several, as the web; one opens, the cross closes the list', (
    tester,
  ) async {
    final opened = <String>[];
    var cleared = 0;
    await pumpPanel(
      tester,
      trip(
        stops: [_stop('a', 'Biržai'), _stop('b', 'Pasvalys'), _stop('c', 'Rokiškis')],
        assets: [
          for (final id in ['a', 'b', 'c'])
            TripAssetDto(assetId: '$id-1', stopId: id, latitude: null, longitude: null, pointSource: null),
        ],
      ),
      clusterIds: ['c', 'a'],
      onOpen: (item) => opened.add(item.id),
      onClearCluster: () => cleared++,
      isEditing: true,
    );

    expect(find.text('Several stops here'), findsOneWidget);
    expect(find.text('Pasvalys'), findsNothing);
    // Listed in trip order, whatever order the map found them in.
    expect(tester.getTopLeft(find.text('Biržai')).dy, lessThan(tester.getTopLeft(find.text('Rokiškis')).dy));

    await tester.tap(find.text('Rokiškis'));
    await tester.tap(find.byKey(const ValueKey('trip-cluster-close')));
    expect(opened, ['c']);
    expect(cleared, 1);
  });
}
