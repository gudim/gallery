import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:http/http.dart' as http;
import 'package:immich_mobile/generated/translations.g.dart';
import 'package:immich_mobile/infrastructure/repositories/network.repository.dart';
import 'package:immich_mobile/utils/url_helper.dart';
import 'package:package_info_plus/package_info_plus.dart';
import 'package:url_launcher/url_launcher.dart';

/// The trips APK a server ships (trips DECISIONS-LOG 2026-11-08): trips-release-server.yml lays it and
/// gallery-trips.json into the web's static files under /trips-app/, as web `trips-app.ts` reads them.
class TripsAppRelease {
  /// The image tag the APK was built with, e.g. v5.10.0.2.
  final String version;
  final int versionCode;
  final Uri apkUri;

  const TripsAppRelease({required this.version, required this.versionCode, required this.apkUri});

  static final _filePattern = RegExp(r'^[\w.-]+\.apk$');

  /// The release gallery-trips.json describes, or null for anything else (a server without the app answers with the
  /// web's page).
  static TripsAppRelease? parse(String body, String serverUrl) {
    final Object? json;
    try {
      json = jsonDecode(body);
    } on FormatException {
      return null;
    }
    if (json is! Map<String, dynamic>) {
      return null;
    }
    final version = json['version'];
    final versionCode = json['versionCode'];
    final file = json['file'];
    if (version is! String || versionCode is! int || file is! String || !_filePattern.hasMatch(file)) {
      return null;
    }
    return TripsAppRelease(version: version, versionCode: versionCode, apkUri: Uri.parse('$serverUrl/trips-app/$file'));
  }
}

/// Whether to offer [release] to the installed app: only the trips build (`.trips`, trips.gradle) is offered, and only
/// a newer version code.
bool shouldOfferTripsApp({required String packageName, required String buildNumber, TripsAppRelease? release}) {
  final installed = int.tryParse(buildNumber);
  return release != null && packageName.endsWith('.trips') && installed != null && release.versionCode > installed;
}

/// Offers the server's trips APK once per launch when it is newer than the installed one. The APK opens in the
/// browser, which downloads it, and Android then installs it over this app. Every failure is silent.
class TripsAppUpdate {
  static bool _isChecked = false;

  static void checkOnce(BuildContext context) {
    if (_isChecked) {
      return;
    }
    _isChecked = true;
    unawaited(_check(context));
  }

  static Future<void> _check(BuildContext context) async {
    try {
      final info = await PackageInfo.fromPlatform();
      if (!info.packageName.endsWith('.trips')) {
        return;
      }
      final serverUrl = getServerUrl();
      if (serverUrl == null) {
        return;
      }
      final release = await fetchTripsAppRelease(NetworkRepository.client, serverUrl);
      if (!shouldOfferTripsApp(packageName: info.packageName, buildNumber: info.buildNumber, release: release) ||
          !context.mounted) {
        return;
      }
      await showTripsAppUpdateDialog(context, release!);
    } catch (_) {
      // An update offer is a convenience: no server, no file, no network all mean no offer.
    }
  }
}

Future<TripsAppRelease?> fetchTripsAppRelease(http.Client client, String serverUrl) async {
  final response = await client.get(Uri.parse('$serverUrl/trips-app/gallery-trips.json'));
  return response.statusCode == 200 ? TripsAppRelease.parse(response.body, serverUrl) : null;
}

Future<void> showTripsAppUpdateDialog(
  BuildContext context,
  TripsAppRelease release, {
  Future<bool> Function(Uri uri) open = _openInBrowser,
}) => showDialog<void>(
  context: context,
  builder: (context) => AlertDialog(
    title: Text(context.t.trips_app_update_title),
    content: Text(context.t.trips_app_update_body(version: release.version.replaceFirst(RegExp('^v'), ''))),
    actions: [
      TextButton(onPressed: () => Navigator.of(context).pop(), child: Text(context.t.trips_app_update_later)),
      TextButton(
        onPressed: () {
          Navigator.of(context).pop();
          unawaited(open(release.apkUri));
        },
        child: Text(context.t.download),
      ),
    ],
  ),
);

Future<bool> _openInBrowser(Uri uri) => launchUrl(uri, mode: LaunchMode.externalApplication);
