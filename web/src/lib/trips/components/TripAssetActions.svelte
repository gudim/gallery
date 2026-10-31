<script lang="ts">
  import ButtonContextMenu from '$lib/components/shared-components/context-menu/ButtonContextMenu.svelte';
  import MenuOption from '$lib/components/shared-components/context-menu/MenuOption.svelte';
  import { assetMultiSelectManager } from '$lib/managers/asset-multi-select-manager.svelte';
  import TripPointModal from '$lib/trips/components/TripPointModal.svelte';
  import type { TripEditor } from '$lib/trips/trip-editor.svelte';
  import type { TripItem } from '$lib/trips/trip-view';
  import {
    createStop,
    moveAssets,
    removeAssetPoint,
    setAssetPoint,
    splitStop,
    toCenter,
    TripKind,
    TripPointSource,
    type TripEndDto,
  } from '@immich/sdk';
  import { IconButton, modalManager } from '@immich/ui';
  import {
    mdiCallSplit,
    mdiImageMove,
    mdiMapMarkerPlusOutline,
    mdiMapMarkerRadiusOutline,
    mdiMapMarkerRemoveOutline,
    mdiTarget,
  } from '@mdi/js';
  import { t } from 'svelte-i18n';

  // What can be done to the assets picked in a stop's timeline (trips PLAN §2.5, travel-album editor.js
  // selectionBar): move them to another stop, make a stop of them, split the stop at one, set or clear one's point,
  // and on a Places trip file Unplaced ones to the centre.

  interface Props {
    editor: TripEditor;
    /** The stop or item whose timeline the assets were picked in */
    item: TripItem;
    /** The stop the assets went to, or `undefined` when they stay */
    onMoved: (stopId?: string) => void;
  }

  let { editor, item, onMoved }: Props = $props();

  const view = $derived(editor.view!);
  const trip = $derived(editor.trip!);
  const ids = $derived(assetMultiSelectManager.assets.map(({ id }) => id));
  const single = $derived(ids.length === 1 ? ids[0] : undefined);
  const filing = $derived(single ? trip.assets.find(({ assetId }) => assetId === single) : undefined);
  const isPlaces = $derived(view.kind === TripKind.Places);
  const hasMap = $derived(view.kind !== TripKind.Plain);

  const done = async (edit: Parameters<TripEditor['run']>[0], stopId?: string) => {
    if (await editor.run(edit, $t('trips_edit_failed'))) {
      assetMultiSelectManager.clear();
      onMoved(stopId);
    }
  };

  // Other stops of assets, the neighbours of this one first, as travel-album's move menu.
  const targets = $derived.by(() => {
    const stops = view.stops.filter(({ id, stop }) => id !== item.id && !stop.role);
    const at = view.stops.findIndex(({ id }) => id === item.id);
    const index = new Map(view.stops.map(({ id }, position) => [id, position]));
    return at === -1
      ? stops
      : [...stops].sort((a, b) => Math.abs(index.get(a.id)! - at) - Math.abs(index.get(b.id)! - at));
  });

  /** The split begins with the picked asset; the first asset of a stop would leave nothing behind. */
  const canSplit = $derived(item.type === 'stop' && !!single && item.photos[0]?.id !== single);
  const centre = $derived(view.stops.find(({ stop }) => stop.isAtCenter));

  const onPoint = async () => {
    const photo = item.photos.find(({ id }) => id === single);
    const point =
      photo && photo.latitude !== null && photo.longitude !== null
        ? { latitude: photo.latitude, longitude: photo.longitude }
        : undefined;
    const picked = await modalManager.show(TripPointModal, {
      albumId: editor.albumId,
      title: $t('trips_asset_point'),
      point,
    });
    if (picked && single) {
      await done((id) =>
        setAssetPoint({
          id,
          assetId: single,
          tripAssetPointDto: { latitude: picked.latitude, longitude: picked.longitude },
        }),
      );
    }
  };

  const onCentre = async () => {
    let centreDto: TripEndDto | undefined;
    if (!centre) {
      const picked = await modalManager.show(TripPointModal, {
        albumId: editor.albumId,
        title: $t('trips_centre'),
        isNamed: true,
      });
      if (!picked) {
        return;
      }
      centreDto = { latitude: picked.latitude, longitude: picked.longitude, title: picked.title || null };
    }
    await done((id) => toCenter({ id, tripAssetsCenterDto: { assetIds: ids, centre: centreDto } }));
  };
</script>

{#if targets.length > 0}
  <ButtonContextMenu icon={mdiImageMove} title={$t('trips_move_to_stop')} offset={{ x: 175, y: 25 }}>
    {#each targets as target (target.id)}
      <MenuOption
        text={target.title || target.region || $t('trips_untitled_stop')}
        onClick={() =>
          done((id) => moveAssets({ id, tripAssetsMoveDto: { assetIds: ids, stopId: target.id } }), target.id)}
      />
    {/each}
  </ButtonContextMenu>
{/if}
<IconButton
  shape="round"
  color="secondary"
  variant="ghost"
  icon={mdiMapMarkerPlusOutline}
  aria-label={$t('trips_new_stop')}
  title={$t('trips_new_stop')}
  onclick={() => done((id) => createStop({ id, tripStopCreateDto: { assetIds: ids } }))}
  data-testid="trip-new-stop"
/>
{#if canSplit && single}
  <IconButton
    shape="round"
    color="secondary"
    variant="ghost"
    icon={mdiCallSplit}
    aria-label={$t('trips_split_here')}
    title={$t('trips_split_here')}
    onclick={() => done((id) => splitStop({ id, stopId: item.id, tripStopSplitDto: { assetId: single } }))}
    data-testid="trip-split"
  />
{/if}
{#if hasMap && single}
  <IconButton
    shape="round"
    color="secondary"
    variant="ghost"
    icon={mdiMapMarkerRadiusOutline}
    aria-label={$t('trips_asset_point')}
    title={$t('trips_asset_point')}
    onclick={onPoint}
  />
  {#if filing?.pointSource === TripPointSource.Manual}
    <IconButton
      shape="round"
      color="secondary"
      variant="ghost"
      icon={mdiMapMarkerRemoveOutline}
      aria-label={$t('trips_asset_point_reset')}
      title={$t('trips_asset_point_reset')}
      onclick={() => single && done((id) => removeAssetPoint({ id, assetId: single }))}
    />
  {/if}
{/if}
{#if isPlaces && item.type === 'unplaced'}
  <IconButton
    shape="round"
    color="secondary"
    variant="ghost"
    icon={mdiTarget}
    aria-label={$t('trips_to_centre')}
    title={$t('trips_to_centre')}
    onclick={onCentre}
  />
{/if}
