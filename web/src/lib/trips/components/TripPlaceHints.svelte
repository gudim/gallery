<script lang="ts">
  import { assetMultiSelectManager } from '$lib/managers/asset-multi-select-manager.svelte';
  import type { TripEditor } from '$lib/trips/trip-editor.svelte';
  import { toTimelineAsset } from '$lib/utils/timeline-util';
  import { getTripPlaceHints, moveAssets, toCenter, type TripPlaceHintsDto } from '@immich/sdk';
  import { Button } from '@immich/ui';
  import { t } from 'svelte-i18n';

  // Places offered to the Unplaced assets of a Places trip by their likeness to assets with GPS (trips PLAN §2.5,
  // travel-album editor.js place hints). A hint moves nothing by itself: "Select" picks its assets in the timeline
  // below, where Gallery's selection can drop some before moving the rest, and "Move" files them all.

  interface Props {
    editor: TripEditor;
  }

  let { editor }: Props = $props();

  let hints = $state<TripPlaceHintsDto>();

  // Asked again after every edit, as travel-album's editor did when the content version moved.
  $effect(() => {
    const { albumId, contentVersion } = editor.trip!;
    void load(albumId, contentVersion);
  });

  const load = async (albumId: string, contentVersion: number) => {
    try {
      const found = await getTripPlaceHints({ id: albumId });
      if (editor.trip?.contentVersion === contentVersion) {
        hints = found;
      }
    } catch {
      // Hints are a convenience; without them the assets are filed by hand.
      hints = undefined;
    }
  };

  const titleOf = (stopId: string) => {
    const stop = editor.view!.stops.find(({ id }) => id === stopId);
    return stop?.title || stop?.region || $t('trips_untitled_stop');
  };

  const select = (assetIds: string[]) => {
    const assets = editor.assets.filter(({ id }) => assetIds.includes(id));
    assetMultiSelectManager.clear();
    assetMultiSelectManager.selectAssets(assets.map((asset) => toTimelineAsset(asset)));
  };

  const run = async (edit: Parameters<TripEditor['run']>[0]) => {
    if (await editor.run(edit, $t('trips_edit_failed'))) {
      assetMultiSelectManager.clear();
    }
  };
</script>

{#snippet hint(label: string, assetIds: string[], action: string, onMove: () => Promise<void>)}
  <!-- On a phone the buttons wrap below the label rather than cut it short. -->
  <div class="flex flex-wrap items-center gap-x-2 py-1">
    <div class="min-w-48 flex-1">
      <p class="text-sm">{label}</p>
      <p class="text-xs text-gray-500 dark:text-gray-400">
        {$t('trips_assets_count', { values: { count: assetIds.length } })}
      </p>
    </div>
    <div class="ms-auto flex">
      <Button size="small" variant="ghost" color="secondary" onclick={() => select(assetIds)}>{$t('select')}</Button>
      <Button size="small" variant="ghost" disabled={editor.isBusy} onclick={() => void onMove()}>{action}</Button>
    </div>
  </div>
{/snippet}

{#if hints && (hints.places.length > 0 || hints.center.length > 0)}
  <div class="mt-3" data-testid="trip-place-hints">
    <p class="text-xs text-gray-500 dark:text-gray-400">{$t('trips_hints_title')}</p>
    {#each hints.places as place (place.stopId)}
      {@render hint(titleOf(place.stopId), place.assetIds, $t('move'), () =>
        run((id) => moveAssets({ id, tripAssetsMoveDto: { assetIds: place.assetIds, stopId: place.stopId } })),
      )}
    {/each}
    {#if hints.center.length > 0}
      {@render hint($t('trips_hints_like_none'), hints.center, $t('trips_to_center'), () =>
        run((id) => toCenter({ id, tripAssetsCenterDto: { assetIds: hints!.center } })),
      )}
    {/if}
  </div>
{/if}
