<script lang="ts">
  import { QueryParameter } from '$lib/constants';
  import { TRIP_TEXTS_SETTINGS_KEY } from '$lib/trips/components/TripTextsSettings.svelte';
  import { handleError } from '$lib/utils/handle-error';
  import {
    estimateTripTexts,
    getTripTextsProgress,
    retryTripTexts,
    startTripTexts,
    TripTextsProblem,
    type TripTextsEstimateDto,
    type TripTextsProgressDto,
  } from '@immich/sdk';
  import {
    Alert,
    Button,
    Checkbox,
    HStack,
    Label,
    LoadingSpinner,
    Modal,
    ModalBody,
    ModalFooter,
    Text,
  } from '@immich/ui';
  import { mdiTextBoxEditOutline } from '@mdi/js';
  import { onDestroy } from 'svelte';
  import { t } from 'svelte-i18n';

  // Generating a trip's texts (trips PLAN §2.6), ported from travel-album's generation window: the scope (the whole trip
  // or the open stop), the estimate, and "replace my texts too" with the count of the owner's texts. While the run goes
  // on, the window shows what is left and what failed after its retries.

  type Props = {
    albumId: string;
    /** The open stop, offered as the scope */
    stop?: { id: string; title: string };
    /** Closed after a run that wrote something, so the trip is read again */
    onClose: (isChanged?: boolean) => void;
  };

  let { albumId, stop, onClose }: Props = $props();

  const POLL_MS = 4000;

  let stopId = $state<string | undefined>(stop?.id);
  let overwrite = $state(false);
  let estimate = $state<TripTextsEstimateDto>();
  let progress = $state<TripTextsProgressDto>();
  let isStarted = $state(false);
  let isBusy = $state(false);
  let timer: ReturnType<typeof setTimeout> | undefined;

  const settingsUrl = `/user-settings?${QueryParameter.IS_OPEN}=${TRIP_TEXTS_SETTINGS_KEY}`;

  $effect(() => {
    const query = { id: albumId, stopId, overwrite };
    estimate = undefined;
    estimateTripTexts(query)
      .then((result) => {
        if (query.stopId === stopId && query.overwrite === overwrite) {
          estimate = result;
        }
      })
      .catch((error: unknown) => handleError(error, $t('trips_texts_load_failed')));
  });

  const follow = (result: TripTextsProgressDto) => {
    progress = result;
    clearTimeout(timer);
    if (result.pending > 0) {
      timer = setTimeout(() => void poll(), POLL_MS);
    }
  };

  const poll = async () => {
    try {
      follow(await getTripTextsProgress({ id: albumId }));
    } catch {
      timer = setTimeout(() => void poll(), POLL_MS);
    }
  };

  const act = async (action: () => Promise<TripTextsProgressDto>, message: string) => {
    isBusy = true;
    try {
      isStarted = true;
      follow(await action());
    } catch (error) {
      handleError(error, message);
    } finally {
      isBusy = false;
    }
  };

  const start = () =>
    act(
      () => startTripTexts({ id: albumId, tripTextsStartDto: { stopId, overwrite } }),
      $t('trips_texts_start_failed'),
    );
  const retry = () => act(() => retryTripTexts({ id: albumId }), $t('trips_texts_start_failed'));

  // A run started earlier, maybe from another tab, shows what is left and what failed at once.
  getTripTextsProgress({ id: albumId })
    .then(follow)
    .catch(() => {});

  onDestroy(() => clearTimeout(timer));

  const isRunning = $derived(!!progress && progress.pending > 0);
  const problemTexts = $derived<Record<TripTextsProblem, string>>({
    [TripTextsProblem.NoSettings]: $t('trips_texts_problem_noSettings'),
    [TripTextsProblem.NoConsent]: $t('trips_texts_problem_noConsent'),
    [TripTextsProblem.KeyUnreadable]: $t('trips_texts_problem_keyUnreadable'),
  });
</script>

<Modal title={$t('trips_texts_generate')} icon={mdiTextBoxEditOutline} size="small" onClose={() => onClose(isStarted)}>
  <ModalBody>
    <div class="flex flex-col gap-4" data-testid="trip-texts-modal">
      {#if progress && (isRunning || isStarted || progress.failed.length > 0)}
        {#if isRunning}
          <div class="flex items-center gap-3">
            <LoadingSpinner />
            <Text>{$t('trips_texts_pending', { values: { count: progress.pending } })}</Text>
          </div>
        {:else if isStarted && progress.failed.length === 0}
          <Text>{$t('trips_texts_done')}</Text>
        {/if}
        {#if progress.failed.length > 0}
          <Alert color="danger" title={$t('trips_texts_failed')}>
            <ul class="flex flex-col gap-1 text-sm">
              {#each progress.failed as failure, index (index)}
                <li><span class="font-medium">{failure.title || $t('trips_untitled_stop')}</span>: {failure.error}</li>
              {/each}
            </ul>
          </Alert>
        {/if}
      {/if}
      {#if !isRunning && !isStarted}
        {#if stop}
          <div class="flex flex-col gap-2" role="radiogroup" aria-label={$t('trips_texts_scope')}>
            {#each [{ id: undefined, label: $t('trips_texts_scope_trip') }, { id: stop.id, label: $t( 'trips_texts_scope_stop', { values: { title: stop.title || $t('trips_untitled_stop') } } ) }] as option (option.id ?? 'trip')}
              <button
                type="button"
                role="radio"
                aria-checked={stopId === option.id}
                class={[
                  'rounded-xl border-2 px-4 py-2 text-start transition-colors',
                  stopId === option.id
                    ? 'border-primary bg-primary/5'
                    : 'border-gray-200 hover:bg-subtle dark:border-immich-dark-gray',
                ]}
                onclick={() => (stopId = option.id)}>{option.label}</button
              >
            {/each}
          </div>
        {/if}

        {#if !estimate}
          <div class="flex justify-center"><LoadingSpinner /></div>
        {:else if estimate.problem}
          <Alert color="warning" title={problemTexts[estimate.problem]}>
            <a class="text-primary underline" href={settingsUrl}>{$t('trips_texts_open_settings')}</a>
          </Alert>
        {:else}
          {#if estimate.calls === 0}
            <Text color="muted">{$t('trips_texts_nothing')}</Text>
          {:else}
            <ul class="flex flex-col gap-1 text-sm" data-testid="trip-texts-estimate">
              <li>{$t('trips_texts_calls', { values: { count: estimate.calls } })}</li>
              <li>{$t('trips_assets_count', { values: { count: estimate.assets } })}</li>
              <li>
                {$t('trips_stops_count', { values: { count: estimate.stops } })}{#if estimate.places > 0}, {$t(
                    'trips_places_count',
                    { values: { count: estimate.places } },
                  )}{/if}
              </li>
            </ul>
          {/if}
          {#if estimate.ownTexts > 0 || overwrite}
            <div class="flex items-start gap-2">
              <Checkbox id="trip-texts-overwrite" bind:checked={overwrite} />
              <Label for="trip-texts-overwrite">
                <span class="block">{$t('trips_texts_overwrite', { values: { count: estimate.ownTexts } })}</span>
                <span class="block text-sm text-gray-600 dark:text-gray-300">{$t('trips_texts_overwrite_hint')}</span>
              </Label>
            </div>
          {/if}
        {/if}
      {/if}
    </div>
  </ModalBody>
  <ModalFooter>
    <HStack fullWidth>
      <Button shape="round" color="secondary" fullWidth onclick={() => onClose(isStarted)}>{$t('close')}</Button>
      {#if progress && progress.failed.length > 0 && !isRunning}
        <Button shape="round" fullWidth color="secondary" loading={isBusy} disabled={isBusy} onclick={retry}
          >{$t('trips_texts_retry')}</Button
        >
      {/if}
      {#if !isRunning && !isStarted}
        <Button
          shape="round"
          fullWidth
          loading={isBusy}
          disabled={isBusy || !estimate || !!estimate.problem || estimate.calls === 0}
          onclick={start}
          data-testid="trip-texts-start">{$t('trips_texts_start')}</Button
        >
      {/if}
    </HStack>
  </ModalFooter>
</Modal>
