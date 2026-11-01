<script lang="ts" module>
  /** The accordion key, for links that open the section: `/user-settings?isOpen=trip-texts`. */
  export const TRIP_TEXTS_SETTINGS_KEY = 'trip-texts';
</script>

<script lang="ts">
  import SettingAccordion from '$lib/components/shared-components/settings/SettingAccordion.svelte';
  import { handleError } from '$lib/utils/handle-error';
  import {
    getTripLlmSettings,
    TripLlmKeyState,
    updateTripLlmSettings,
    type TripLlmSettingsResponseDto,
  } from '@immich/sdk';
  import { Button, Field, Input, LoadingSpinner, PasswordInput, Switch, Text, toastManager } from '@immich/ui';
  import { mdiTextBoxEditOutline } from '@mdi/js';
  import { t } from 'svelte-i18n';

  // The user's OpenAI-compatible server for trip texts (trips PLAN D16, DECISIONS-LOG 2026-11-01), a section of
  // Gallery's user settings. The key is write-only: the server only says whether one is saved.

  let settings = $state<TripLlmSettingsResponseDto>();
  let url = $state('');
  let model = $state('');
  let key = $state('');
  let allowUpload = $state(false);
  let isBusy = $state(false);

  const show = (response: TripLlmSettingsResponseDto) => {
    settings = response;
    url = response.url;
    model = response.model;
    key = '';
    allowUpload = response.allowUpload;
  };

  const load = async () => {
    try {
      show(await getTripLlmSettings());
    } catch (error) {
      handleError(error, $t('trips_texts_settings_failed'));
    }
  };

  const save = async (clearKey = false) => {
    isBusy = true;
    try {
      show(
        await updateTripLlmSettings({
          tripLlmSettingsUpdateDto: {
            url: url.trim(),
            model: model.trim(),
            allowUpload,
            ...(clearKey ? { key: null } : key.trim() ? { key: key.trim() } : {}),
          },
        }),
      );
      toastManager.primary($t('saved_settings'));
    } catch (error) {
      handleError(error, $t('errors.unable_to_update_settings'));
    } finally {
      isBusy = false;
    }
  };

  const onsubmit = (event: Event) => {
    event.preventDefault();
    void save();
  };

  // A saved key goes only to the URL it was entered for; the server drops it when the URL changes.
  const keyNote = $derived.by(() => {
    if (!settings) {
      return '';
    }
    if (!settings.canStoreKey) {
      return $t('trips_texts_key_no_secret');
    }
    if (settings.key === TripLlmKeyState.Unreadable) {
      return $t('trips_texts_key_unreadable');
    }
    if (settings.key === TripLlmKeyState.Set) {
      return url.trim() === settings.url ? $t('trips_texts_key_set') : $t('trips_texts_key_dropped');
    }
    return '';
  });
</script>

<SettingAccordion
  icon={mdiTextBoxEditOutline}
  key={TRIP_TEXTS_SETTINGS_KEY}
  title={$t('trips_texts_settings')}
  subtitle={$t('trips_texts_settings_description')}
>
  <section class="my-4" data-testid="trip-texts-settings">
    {#await load()}
      <LoadingSpinner />
    {:then}
      <form autocomplete="off" {onsubmit}>
        <div class="flex flex-col gap-4 sm:ms-8">
          <Field label={$t('trips_texts_url')} description={$t('trips_texts_url_description')} required>
            <Input bind:value={url} type="url" placeholder="https://api.openai.com/v1" />
          </Field>
          <Field label={$t('trips_texts_model')} description={$t('trips_texts_model_description')} required>
            <Input bind:value={model} />
          </Field>
          <Field label={$t('trips_texts_key')} disabled={!settings?.canStoreKey}>
            <PasswordInput bind:value={key} autocomplete="off" />
          </Field>
          {#if keyNote}
            <Text size="small" color="muted" class="-mt-2">{keyNote}</Text>
          {/if}
          <Field label={$t('trips_texts_allow_upload')} description={$t('trips_texts_allow_upload_description')}>
            <Switch bind:checked={allowUpload} />
          </Field>
          <div class="flex justify-end gap-2">
            {#if settings && settings.key !== TripLlmKeyState.None}
              <Button shape="round" size="small" color="secondary" disabled={isBusy} onclick={() => save(true)}
                >{$t('trips_texts_key_clear')}</Button
              >
            {/if}
            <Button shape="round" size="small" type="submit" disabled={isBusy || !url.trim() || !model.trim()}
              >{$t('save')}</Button
            >
          </div>
        </div>
      </form>
    {/await}
  </section>
</SettingAccordion>
