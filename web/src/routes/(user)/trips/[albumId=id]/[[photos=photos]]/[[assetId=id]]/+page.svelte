<script lang="ts">
  import TripPage from '$lib/trips/components/TripPage.svelte';
  import type { PageData } from './$types';

  type Props = {
    data: PageData;
  };

  let { data }: Props = $props();
</script>

<TripPage album={data.album} />
