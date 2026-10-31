<script lang="ts">
  import { Route } from '$lib/route';
  import { isAlbumEditor } from '$lib/services/album.service';
  import TripPage from '$lib/trips/components/TripPage.svelte';
  import type { PageData } from './$types';

  type Props = {
    data: PageData;
  };

  let { data }: Props = $props();
</script>

<TripPage
  albumId={data.album.id}
  albumName={data.album.albumName}
  albumUrl={Route.viewAlbum({ id: data.album.id })}
  canEdit={isAlbumEditor(data.album)}
/>
