import { AssetOrder, getTrip, isHttpError, searchAssets, type AssetResponseDto } from '@immich/sdk';
import { authManager } from '$lib/managers/auth-manager.svelte';
import { buildTripView, type TripView } from '$lib/trips/trip-view';

const PAGE_SIZE = 1000;

/** Every asset of the album the caller may see, with captions, oldest first. Works through a shared link too. */
const loadAlbumAssets = async (albumId: string) => {
  const assets: AssetResponseDto[] = [];
  for (let page: number | null = 1; page;) {
    const { assets: result } = await searchAssets({
      ...authManager.params,
      metadataSearchDto: { albumIds: [albumId], withExif: true, size: PAGE_SIZE, page, order: AssetOrder.Asc },
    });
    assets.push(...result.items);
    page = result.nextPage ? Number(result.nextPage) : null;
  }
  return assets;
};

/** The album's trip, ready for the viewer, or `null` when the album has none. */
export const loadTripView = async (albumId: string): Promise<TripView | null> => {
  let trip;
  try {
    trip = await getTrip({ id: albumId, ...authManager.params });
  } catch (error) {
    if (isHttpError(error) && error.status === 404) {
      return null;
    }
    throw error;
  }
  // Only a trip album pays for loading every asset.
  return buildTripView(trip, await loadAlbumAssets(albumId));
};
