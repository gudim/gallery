import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:immich_mobile/domain/models/album/album.model.dart';
import 'package:immich_mobile/presentation/widgets/remote_album/album_option.widget.dart';
import 'package:immich_mobile/trips/trip.provider.dart';
import 'package:immich_mobile/trips/trip_album_menu_item.dart';

import '../widget_tester_extensions.dart';

RemoteAlbum _album({int assetCount = 79}) => RemoteAlbum(
  id: 'album-1',
  name: 'Biržai',
  ownerId: 'owner',
  description: '',
  createdAt: DateTime(2026, 1, 1),
  updatedAt: DateTime(2026, 1, 1),
  isActivityEnabled: false,
  order: AlbumAssetOrder.desc,
  assetCount: assetCount,
  ownerName: 'Owner',
  isShared: false,
);

Future<void> _openMenu(WidgetTester tester, {required bool? hasTrip, bool isOwner = false, int assetCount = 79}) async {
  final album = _album(assetCount: assetCount);
  await tester.pumpConsumerWidget(
    RemoteAlbumOption(
      extraItems: [TripAlbumMenuItem(album: album, isOwner: isOwner)],
    ),
    overrides: [
      tripExistsProvider(
        album.id,
      ).overrideWith((ref) => hasTrip == null ? Future<bool>.error(Exception('offline')) : Future.value(hasTrip)),
    ],
  );
  await tester.tap(find.byIcon(Icons.more_vert_rounded));
  await tester.pumpAndSettle();
}

void main() {
  testWidgets('offers "Open the trip" when the album has a trip', (tester) async {
    await _openMenu(tester, hasTrip: true, isOwner: true);

    expect(find.byKey(const ValueKey('trip-open')), findsOneWidget);
    expect(find.byKey(const ValueKey('trip-create')), findsNothing);
  });

  testWidgets('offers "Make a trip" to the owner of an album without a trip', (tester) async {
    await _openMenu(tester, hasTrip: false, isOwner: true);

    expect(find.byKey(const ValueKey('trip-create')), findsOneWidget);
    expect(find.byKey(const ValueKey('trip-open')), findsNothing);
  });

  testWidgets('offers nothing to anyone else when the album has no trip', (tester) async {
    await _openMenu(tester, hasTrip: false);

    expect(find.byKey(const ValueKey('trip-open')), findsNothing);
    expect(find.byKey(const ValueKey('trip-create')), findsNothing);
  });

  testWidgets('offers no trip of an empty album', (tester) async {
    await _openMenu(tester, hasTrip: false, isOwner: true, assetCount: 0);

    expect(find.byKey(const ValueKey('trip-create')), findsNothing);
  });

  testWidgets('offers nothing while it is unknown whether the album has a trip', (tester) async {
    await _openMenu(tester, hasTrip: null, isOwner: true);

    expect(find.byKey(const ValueKey('trip-open')), findsNothing);
    expect(find.byKey(const ValueKey('trip-create')), findsNothing);
  });
}
