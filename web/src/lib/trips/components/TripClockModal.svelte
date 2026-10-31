<script lang="ts">
  import type { TripEditor } from '$lib/trips/trip-editor.svelte';
  import { handleError } from '$lib/utils/handle-error';
  import { getTripCameras, updateAssets, type TripCameraDto } from '@immich/sdk';
  import { Button, Field, LoadingSpinner, Modal, ModalBody, NumberInput, toastManager } from '@immich/ui';
  import { mdiClockEditOutline } from '@mdi/js';
  import { t } from 'svelte-i18n';

  // The clock-offset wizard (trips PLAN D9, travel-album import wizard and camera list): the album's cameras, and for
  // one without GPS a shift of its clock, suggested where the cameras with GPS time it. A shift moves the dates of the
  // caller's own assets of the camera through Immich's bulk asset update; the trip follows once their metadata is read
  // again, which `TripEditor.follow` waits for.

  type Props = {
    editor: TripEditor;
    onClose: () => void;
  };

  let { editor, onClose }: Props = $props();

  let cameras = $state<TripCameraDto[]>();
  let minutes = $state<Record<string, number>>({});
  let applying = $state<string>();

  const keyOf = ({ make, model, isVideo }: TripCameraDto) => JSON.stringify([make, model, isVideo]);

  const load = async () => {
    try {
      ({ cameras } = await getTripCameras({ id: editor.albumId }));
      minutes = Object.fromEntries(cameras.map((camera) => [keyOf(camera), camera.suggestion?.offsetMinutes ?? 0]));
    } catch (error) {
      handleError(error, $t('trips_clock_failed'));
      onClose();
    }
  };
  void load();

  const nameOf = ({ make, model, isVideo }: TripCameraDto) => {
    const name = model || make;
    if (isVideo) {
      return name ? `${$t('trips_clock_video')} · ${name}` : $t('trips_clock_video');
    }
    return name || $t('trips_clock_camera_unknown');
  };

  // −39 → "−39 min", 65 → "+1 h 5 min"
  const offsetLabel = (offset: number) => {
    const sign = offset < 0 ? '−' : '+';
    const [hours, rest] = [Math.floor(Math.abs(offset) / 60), Math.abs(offset) % 60];
    return (
      sign +
      (hours > 0
        ? $t('trips_duration_hours', { values: { hours, minutes: rest } })
        : $t('trips_duration_minutes', { values: { minutes: rest } }))
    );
  };
  const percent = (share: number) => Math.round(share * 100);

  // A whole number of minutes other than none, on assets of the caller's own.
  const canShift = (camera: TripCameraDto) => {
    const offset = minutes[keyOf(camera)];
    return !applying && camera.ownAssetIds.length > 0 && Number.isSafeInteger(offset) && offset !== 0;
  };

  const onShift = async (camera: TripCameraDto) => {
    const key = keyOf(camera);
    applying = key;
    try {
      await updateAssets({ assetBulkUpdateDto: { ids: camera.ownAssetIds, dateTimeRelative: minutes[key] } });
      editor.follow();
      toastManager.primary($t('trips_clock_applied'));
      onClose();
    } catch (error) {
      handleError(error, $t('trips_clock_failed'));
    } finally {
      applying = undefined;
    }
  };
</script>

<Modal title={$t('trips_clock')} icon={mdiClockEditOutline} size="medium" {onClose}>
  <ModalBody>
    <p class="mb-3 text-sm text-gray-600 dark:text-gray-300">{$t('trips_clock_hint')}</p>
    {#if !cameras}
      <div class="flex justify-center py-6"><LoadingSpinner /></div>
    {:else}
      <div class="flex flex-col divide-y divide-gray-200 dark:divide-immich-dark-gray" data-testid="trip-cameras">
        {#each cameras as camera (keyOf(camera))}
          {@const key = keyOf(camera)}
          {@const others = camera.assetCount - camera.ownAssetIds.length}
          <div class="py-3">
            <p class="text-sm font-medium">{nameOf(camera)}</p>
            <p class="text-xs text-gray-500 dark:text-gray-400">
              {$t('trips_assets_count', { values: { count: camera.assetCount } })} · {$t('trips_clock_gps', {
                values: { count: camera.gpsCount },
              })}
            </p>
            {#if camera.isReference}
              <p class="mt-1 text-sm text-gray-700 dark:text-gray-300">{$t('trips_clock_reference')}</p>
            {:else}
              {#if camera.suggestion}
                <p class="mt-1 text-sm text-gray-700 dark:text-gray-300">
                  {$t('trips_clock_suggestion', {
                    values: {
                      offset: offsetLabel(camera.suggestion.offsetMinutes),
                      best: percent(camera.suggestion.best),
                      current: percent(camera.suggestion.current),
                    },
                  })}
                </p>
              {/if}
              {#if others > 0}
                <p class="mt-1 text-xs text-gray-500 dark:text-gray-400">
                  {$t('trips_clock_others', { values: { count: others } })}
                </p>
              {/if}
              <div class="mt-2 flex items-end gap-2">
                <div class="w-40">
                  <Field label={$t('trips_clock_minutes')} disabled={camera.ownAssetIds.length === 0}>
                    <NumberInput step={1} bind:value={minutes[key]} />
                  </Field>
                </div>
                <Button
                  size="small"
                  shape="round"
                  loading={applying === key}
                  disabled={!canShift(camera)}
                  onclick={() => onShift(camera)}>{$t('trips_clock_apply')}</Button
                >
              </div>
            {/if}
          </div>
        {/each}
      </div>
    {/if}
  </ModalBody>
</Modal>
