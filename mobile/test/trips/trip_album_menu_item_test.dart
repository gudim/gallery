import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:immich_mobile/domain/models/album/album.model.dart';
import 'package:immich_mobile/presentation/widgets/remote_album/album_option.widget.dart';
import 'package:immich_mobile/trips/trip.provider.dart';
import 'package:immich_mobile/trips/trip_album_menu_item.dart';

import '../widget_tester_extensions.dart';

final _album = RemoteAlbum(
  id: 'album-1',
  name: 'Biržai',
  ownerId: 'owner',
  description: '',
  createdAt: DateTime(2026, 1, 1),
  updatedAt: DateTime(2026, 1, 1),
  isActivityEnabled: false,
  order: AlbumAssetOrder.desc,
  assetCount: 79,
  ownerName: 'Owner',
  isShared: false,
);

Future<void> _openMenu(WidgetTester tester, {required bool hasTrip}) async {
  await tester.pumpConsumerWidget(
    RemoteAlbumOption(extraItems: [TripAlbumMenuItem(album: _album)]),
    overrides: [tripExistsProvider(_album.id).overrideWith((ref) async => hasTrip)],
  );
  await tester.tap(find.byIcon(Icons.more_vert_rounded));
  await tester.pumpAndSettle();
}

void main() {
  testWidgets('offers "Open the trip" when the album has a trip', (tester) async {
    await _openMenu(tester, hasTrip: true);

    expect(find.byKey(const ValueKey('trip-open')), findsOneWidget);
  });

  testWidgets('offers nothing when the album has no trip', (tester) async {
    await _openMenu(tester, hasTrip: false);

    expect(find.byKey(const ValueKey('trip-open')), findsNothing);
  });
}
