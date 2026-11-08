import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:immich_mobile/constants/colors.dart';
import 'package:immich_mobile/models/map/map_state.model.dart';
import 'package:immich_mobile/providers/locale_provider.dart';
import 'package:immich_mobile/providers/map/map_state.provider.dart';
import 'package:immich_mobile/providers/theme.provider.dart';
import 'package:immich_mobile/theme/color_scheme.dart';
import 'package:immich_mobile/trips/trip_map.widget.dart';
import 'package:immich_mobile/trips/trip_view.dart';
import 'package:immich_mobile/widgets/map/map_theme_override.dart';
import 'package:maplibre_gl/maplibre_gl.dart';
import 'package:openapi/api.dart';

import '../modules/map/map_mocks.dart';
import '../widget_tester_extensions.dart';

// MapLibre cannot run in a widget test, so the map's style stays loading and only the tree around it is checked.

final _view = buildTripView(
  TripResponseDto(
    albumId: 'album',
    kind: TripKind.places,
    isFavorites: false,
    isShowcased: false,
    isFeatured: false,
    isNaming: false,
    language: null,
    contentVersion: 1,
    stops: const [],
  ),
  const [],
);

void main() {
  testWidgets('keeps the map when a pin move starts and ends, so the platform view is not rebuilt', (tester) async {
    final pin = ValueNotifier<LatLng?>(null);
    await tester.pumpConsumerWidgetRaw(
      ValueListenableBuilder(
        valueListenable: pin,
        builder: (_, at, _) => TripMap(view: _view, onOpen: (_) {}, pin: at),
      ),
      overrides: [
        mapStateNotifierProvider.overrideWith(() => MockMapStateNotifier(const MapState(themeMode: ThemeMode.light))),
        localeProvider.overrideWithValue(const Locale('en')),
        immichThemeProvider.overrideWith((_) => ImmichColorPreset.indigo.themeOfPreset),
      ],
    );
    final map = tester.element(find.byType(MapThemeOverride));

    pin.value = const LatLng(56.2, 24.75);
    await tester.pump();
    expect(find.byKey(const ValueKey('trip-pin')), findsOneWidget);
    expect(tester.element(find.byType(MapThemeOverride)), same(map));

    pin.value = null;
    await tester.pump();
    expect(find.byKey(const ValueKey('trip-pin')), findsNothing);
    expect(tester.element(find.byType(MapThemeOverride)), same(map));
  });
}
