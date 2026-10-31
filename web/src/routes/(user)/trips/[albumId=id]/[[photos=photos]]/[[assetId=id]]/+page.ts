import { getAlbumInfo } from '@immich/sdk';
import { authenticate } from '$lib/utils/auth';
import { getAssetInfoFromParam } from '$lib/utils/navigation';
import type { PageLoad } from './$types';

// The trip viewer for a signed-in user with access to the album (trips PLAN §2.3).
export const load = (async ({ params, url }) => {
  await authenticate(url);
  const [album, asset] = await Promise.all([
    getAlbumInfo({ id: params.albumId, withoutAssets: true }),
    getAssetInfoFromParam(params),
  ]);
  return { album, asset, meta: { title: album.albumName } };
}) satisfies PageLoad;
