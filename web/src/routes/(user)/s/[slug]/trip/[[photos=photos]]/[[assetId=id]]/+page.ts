import { redirect } from '@sveltejs/kit';
import { Route } from '$lib/route';
import { loadSharedLink } from '$lib/utils/shared-links';
import type { PageLoad } from './$types';

// A trip through the album's shared link (trips PLAN §2.3). A link that still needs its password, or that is not an
// album's, goes back to the shared-link page.
export const load = (async ({ params, url }) => {
  const data = await loadSharedLink({ params, url });
  const albumUrl = Route.viewSharedLink({ slug: params.slug, key: '' });
  const album = 'sharedLink' in data ? data.sharedLink.album : undefined;
  if (!album) {
    redirect(307, albumUrl);
  }
  return { ...data, album, albumUrl };
}) satisfies PageLoad;
