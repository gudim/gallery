<script lang="ts">
  import { loadTripsApp, tripsAppUrl, type TripsApp } from '$lib/trips/app/trips-app';
  import { Button, Icon } from '@immich/ui';
  import { mdiAndroid } from '@mdi/js';
  import { onMount } from 'svelte';
  import { t } from 'svelte-i18n';

  // "Android app" in the account menu (trips DECISIONS-LOG 2026-11-08): downloads the trips APK this server ships,
  // and shows only when it ships one.

  type Props = {
    onClose?: () => void;
  };

  let { onClose }: Props = $props();

  let app = $state<TripsApp>();

  onMount(async () => {
    app = await loadTripsApp();
  });
</script>

{#if app}
  <Button
    href={tripsAppUrl(app)}
    download={app.file}
    onclick={onClose}
    size="small"
    color="secondary"
    variant="ghost"
    shape="round"
    class="border hover:bg-immich-primary/10 dark:border-immich-dark-gray dark:bg-gray-500 dark:text-white dark:hover:bg-immich-dark-primary/50"
  >
    <div class="flex place-content-center place-items-center gap-2 px-2 text-center">
      <Icon icon={mdiAndroid} size="18" aria-hidden />
      {$t('trips_app_download')}
    </div>
  </Button>
{/if}
