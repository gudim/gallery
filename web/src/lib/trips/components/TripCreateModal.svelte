<script lang="ts">
  import { handleError } from '$lib/utils/handle-error';
  import { createTrip, TripKind } from '@immich/sdk';
  import { Icon, Modal, ModalBody, ModalFooter, Button, HStack } from '@immich/ui';
  import { mdiCalendarText, mdiMapMarkerMultipleOutline, mdiMapMarkerPath } from '@mdi/js';
  import { locale, t } from 'svelte-i18n';

  // Makes a trip from an album (trips PLAN §2.5): the owner picks its kind, the server lays it out, and stops are named
  // in the language of the owner's interface.

  type Props = {
    albumId: string;
    onClose: (isCreated?: boolean) => void;
  };

  let { albumId, onClose }: Props = $props();

  let kind = $state(TripKind.Route);
  let isBusy = $state(false);

  const kinds = [
    { kind: TripKind.Route, icon: mdiMapMarkerPath },
    { kind: TripKind.Places, icon: mdiMapMarkerMultipleOutline },
    { kind: TripKind.Plain, icon: mdiCalendarText },
  ];

  const onCreate = async () => {
    isBusy = true;
    try {
      await createTrip({ tripCreateDto: { albumId, kind, language: $locale ?? null } });
      onClose(true);
    } catch (error) {
      handleError(error, $t('trips_create_failed'));
    } finally {
      isBusy = false;
    }
  };
</script>

<Modal title={$t('trips_create_title')} icon={mdiMapMarkerPath} size="small" {onClose}>
  <ModalBody>
    <p class="mb-3 text-sm text-gray-600 dark:text-gray-300">{$t('trips_create_hint')}</p>
    <div class="flex flex-col gap-2" role="radiogroup" aria-label={$t('trips_kind')}>
      {#each kinds as option (option.kind)}
        <button
          type="button"
          role="radio"
          aria-checked={kind === option.kind}
          class={[
            'flex items-start gap-3 rounded-xl border-2 px-4 py-3 text-start transition-colors',
            kind === option.kind
              ? 'border-primary bg-primary/5'
              : 'border-gray-200 hover:bg-subtle dark:border-immich-dark-gray',
          ]}
          onclick={() => (kind = option.kind)}
          data-testid="trip-kind-{option.kind}"
        >
          <Icon icon={option.icon} size="24" class={kind === option.kind ? 'text-primary' : 'text-gray-500'} />
          <span>
            <span class="block font-medium">{$t(`trips_kind_${option.kind}`)}</span>
            <span class="block text-sm text-gray-600 dark:text-gray-300">{$t(`trips_kind_${option.kind}_hint`)}</span>
          </span>
        </button>
      {/each}
    </div>
  </ModalBody>
  <ModalFooter>
    <HStack fullWidth>
      <Button shape="round" color="secondary" fullWidth onclick={() => onClose()}>{$t('cancel')}</Button>
      <Button shape="round" fullWidth loading={isBusy} disabled={isBusy} onclick={onCreate} data-testid="trip-create"
        >{$t('trips_create')}</Button
      >
    </HStack>
  </ModalFooter>
</Modal>
