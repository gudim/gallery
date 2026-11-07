import 'package:auto_route/auto_route.dart';
import 'package:flutter/material.dart';
import 'package:immich_mobile/routing/router.dart';

export 'package:immich_mobile/trips/trip.page.dart';
export 'package:immich_mobile/trips/trip_asset_viewer.page.dart';

/// The trip pages, spread into `AppRouter.routes` by one hook line (trips PLAN §2.9).
List<AutoRoute> tripRoutes(List<AutoRouteGuard> guards) => [
  AutoRoute(page: TripRoute.page, guards: guards),
  AutoRoute(
    page: TripAssetViewerRoute.page,
    guards: guards,
    // As Gallery's own viewer route: it fades in over the page below.
    type: RouteType.custom(
      customRouteBuilder: <T>(context, child, page) => PageRouteBuilder<T>(
        fullscreenDialog: page.fullscreenDialog,
        settings: page,
        pageBuilder: (_, _, _) => child,
        opaque: false,
        transitionsBuilder: TransitionsBuilders.fadeIn,
      ),
    ),
  ),
];
