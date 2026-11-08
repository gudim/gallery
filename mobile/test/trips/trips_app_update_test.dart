import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:immich_mobile/trips/trips_app_update.dart';

import '../widget_tester_extensions.dart';

const _server = 'https://gallery.example';
const _json = '{"version":"v5.10.0.2","versionCode":5100002,"file":"gallery-trips-v5.10.0.2.apk","size":1}';

void main() {
  group('TripsAppRelease.parse', () {
    test('reads gallery-trips.json', () {
      final release = TripsAppRelease.parse(_json, _server)!;
      expect(release.version, 'v5.10.0.2');
      expect(release.versionCode, 5100002);
      expect(release.apkUri.toString(), '$_server/trips-app/gallery-trips-v5.10.0.2.apk');
    });

    for (final (name, body) in [
      ("the web's page", '<!doctype html><html></html>'),
      ('a list', '[]'),
      ('a text version code', '{"version":"v5.10.0.2","versionCode":"5100002","file":"a.apk"}'),
      ('a file outside the folder', '{"version":"v5.10.0.2","versionCode":5100002,"file":"../a.apk"}'),
      ('a file that is not an apk', '{"version":"v5.10.0.2","versionCode":5100002,"file":"index.html"}'),
    ]) {
      test('refuses $name', () => expect(TripsAppRelease.parse(body, _server), isNull));
    }
  });

  group('shouldOfferTripsApp', () {
    final release = TripsAppRelease.parse(_json, _server);

    test('offers a newer version to the trips build', () {
      expect(
        shouldOfferTripsApp(packageName: 'de.opennoodle.gallery.trips', buildNumber: '5100001', release: release),
        isTrue,
      );
    });

    test('does not offer the installed version or an older one', () {
      expect(
        shouldOfferTripsApp(packageName: 'de.opennoodle.gallery.trips', buildNumber: '5100002', release: release),
        isFalse,
      );
      expect(
        shouldOfferTripsApp(packageName: 'de.opennoodle.gallery.trips', buildNumber: '5100003', release: release),
        isFalse,
      );
    });

    test('does not offer anything to Gallery itself', () {
      expect(shouldOfferTripsApp(packageName: 'de.opennoodle.gallery', buildNumber: '1', release: release), isFalse);
    });

    test('does not offer without a release', () {
      expect(shouldOfferTripsApp(packageName: 'de.opennoodle.gallery.trips', buildNumber: '1'), isFalse);
    });
  });

  group('fetchTripsAppRelease', () {
    test('reads the json under /trips-app', () async {
      Uri? asked;
      final client = MockClient((request) async {
        asked = request.url;
        return http.Response(_json, 200);
      });
      final release = await fetchTripsAppRelease(client, _server);
      expect(asked.toString(), '$_server/trips-app/gallery-trips.json');
      expect(release?.versionCode, 5100002);
    });

    test('is null when the server has no app', () async {
      final client = MockClient((_) async => http.Response('', 404));
      expect(await fetchTripsAppRelease(client, _server), isNull);
    });
  });

  group('showTripsAppUpdateDialog', () {
    final release = TripsAppRelease.parse(_json, _server)!;
    late List<Uri> opened;

    setUp(() => opened = []);

    Future<void> open(WidgetTester tester) async {
      await tester.pumpConsumerWidget(
        Builder(
          builder: (context) => TextButton(
            onPressed: () => showTripsAppUpdateDialog(
              context,
              release,
              open: (uri) async {
                opened.add(uri);
                return true;
              },
            ),
            child: const Text('open'),
          ),
        ),
      );
      await tester.tap(find.text('open'));
      await tester.pumpAndSettle();
    }

    testWidgets('names the version without its v', (tester) async {
      await open(tester);
      expect(find.textContaining('5.10.0.2'), findsOneWidget);
      expect(find.textContaining('v5.10.0.2'), findsNothing);
    });

    testWidgets('opens the APK in the browser', (tester) async {
      await open(tester);
      await tester.tap(find.byType(TextButton).last);
      await tester.pumpAndSettle();
      expect(opened, [release.apkUri]);
      expect(find.byType(AlertDialog), findsNothing);
    });

    testWidgets('later closes without opening anything', (tester) async {
      await open(tester);
      await tester.tap(find.byType(TextButton).at(1));
      await tester.pumpAndSettle();
      expect(opened, isEmpty);
      expect(find.byType(AlertDialog), findsNothing);
    });
  });
}
