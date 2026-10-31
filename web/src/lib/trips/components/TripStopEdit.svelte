<script lang="ts">
  import TripPointModal from '$lib/trips/components/TripPointModal.svelte';
  import type { TripEditor } from '$lib/trips/trip-editor.svelte';
  import type { TripTransit, TripViewStop } from '$lib/trips/trip-view';
  import {
    addPoint,
    deleteStop,
    mergeNextStop,
    movePoint,
    removeFinish,
    removeStart,
    setFinish,
    setStart,
    setTransit,
    TripKind,
    TripStopRole,
    updateStop,
    type TripStopUpdateDto,
  } from '@immich/sdk';
  import { Button, Field, Input, modalManager, Select, Textarea } from '@immich/ui';
  import {
    mdiArrowCollapseVertical,
    mdiBusStop,
    mdiCheck,
    mdiCursorMove,
    mdiDeleteOutline,
    mdiImageMarkerOutline,
    mdiMapMarkerPlusOutline,
    mdiMapMarkerRadiusOutline,
    mdiMapMarkerRemoveOutline,
    mdiSwapVertical,
  } from '@mdi/js';
  import { onDestroy, untrack } from 'svelte';
  import { t } from 'svelte-i18n';

  // The opened stop in edit mode (trips PLAN §2.5, travel-album static/admin/editor.js): its title and story, saved
  // a second after typing stops, and what can be done to it. Assets are picked in the timeline below.

  interface Props {
    editor: TripEditor;
    item: TripViewStop | TripTransit;
    /** Puts a draggable pin for the stop on the map */
    onMovePin: (stop: TripViewStop) => void;
    /** The stop is gone (merged or deleted) */
    onGone: () => void;
  }

  let { editor, item, onMovePin, onGone }: Props = $props();

  const view = $derived(editor.view!);
  const trip = $derived(editor.trip!);
  const isRoute = $derived(view.kind === TripKind.Route);
  const hasMap = $derived(view.kind !== TripKind.Plain);
  const stop = $derived(item.type === 'stop' ? item : undefined);
  const role = $derived(stop?.stop.role ?? null);
  const isHandPoint = $derived(!!stop && stop.stop.isAddedByHand && !role);
  const hasAssets = $derived(item.photos.length > 0);
  const point = $derived(
    item.latitude !== null && item.longitude !== null
      ? { latitude: item.latitude, longitude: item.longitude }
      : undefined,
  );

  // Texts: saved a second after the last key, or when the field is left, as travel-album's autosave.
  type Texts = { title: string; story: string };
  let texts = $state<Texts>({ title: '', story: '' });
  let saved = $state<Texts>({ title: '', story: '' });
  let saveState = $state<'idle' | 'saving' | 'saved'>('idle');
  let textStopId = '';
  $effect(() => {
    if (stop && stop.id !== textStopId) {
      untrack(() => void flush());
      textStopId = stop.id;
      texts = { title: stop.stop.title ?? '', story: stop.stop.story ?? '' };
      saved = { ...texts };
      saveState = 'idle';
    }
  });

  let timer: ReturnType<typeof setTimeout> | undefined;
  const flush = async () => {
    clearTimeout(timer);
    const id = textStopId;
    const change: TripStopUpdateDto = {};
    if (texts.title !== saved.title) {
      change.title = texts.title;
    }
    if (texts.story !== saved.story) {
      change.story = texts.story;
    }
    if (!id || Object.keys(change).length === 0) {
      return;
    }
    const sent = { ...texts };
    saveState = 'saving';
    const isSaved = await editor.run(
      (albumId) => updateStop({ id: albumId, stopId: id, tripStopUpdateDto: change }),
      $t('trips_save_failed'),
    );
    // The owner may have opened another stop meanwhile; its texts are not these.
    if (id !== textStopId) {
      return;
    }
    if (isSaved) {
      saved = sent;
    }
    saveState = isSaved ? 'saved' : 'idle';
  };
  const schedule = () => {
    saveState = 'idle';
    clearTimeout(timer);
    timer = setTimeout(() => void flush(), 1000);
  };
  onDestroy(() => void flush());

  const placeOptions = $derived([
    { value: 'none', label: $t('trips_no_place') },
    ...trip.places.map((place) => ({ value: place.id, label: place.title || place.key })),
  ]);

  const run = (edit: Parameters<TripEditor['run']>[0], message = $t('trips_edit_failed')) => editor.run(edit, message);

  const pickPoint = (title: string) =>
    modalManager.show(TripPointModal, { albumId: editor.albumId, title, point, isNamed: true });

  const onEnd = async () => {
    const picked = await pickPoint(role === TripStopRole.Start ? $t('trips_start') : $t('trips_finish'));
    if (!picked) {
      return;
    }
    const end = { latitude: picked.latitude, longitude: picked.longitude, title: picked.title || null };
    await run((id) =>
      role === TripStopRole.Start ? setStart({ id, tripEndDto: end }) : setFinish({ id, tripFinishUpdateDto: end }),
    );
  };

  const onRemoveEnd = async () => {
    if (await run((id) => (role === TripStopRole.Start ? removeStart({ id }) : removeFinish({ id })))) {
      onGone();
    }
  };

  const onAddPoint = async () => {
    const picked = await pickPoint($t('trips_add_point'));
    if (picked) {
      await run((id) =>
        addPoint({
          id,
          tripPointCreateDto: {
            ...picked,
            title: picked.title || null,
            afterStopId: role === TripStopRole.Start ? null : item.id,
          },
        }),
      );
    }
  };

  // A point added by hand goes after any other stop of the route, listed in trip order.
  const orderOptions = $derived.by(() => {
    if (!isHandPoint) {
      return [];
    }
    // Going after the stop it already follows changes nothing.
    const previousId = view.stops[view.stops.findIndex(({ id }) => id === item.id) - 1]?.id;
    return view.stops
      .filter(({ id, stop }) => id !== item.id && id !== previousId && stop.role !== TripStopRole.Finish)
      .map((candidate) => ({
        value: candidate.id,
        label:
          candidate.stop.role === TripStopRole.Start
            ? $t('trips_start')
            : candidate.title || candidate.region || $t('trips_untitled_stop'),
      }));
  });

  // Right after the start is `null` to the server.
  const onOrder = (afterId: string) => {
    const after = view.stops.find(({ id }) => id === afterId);
    const afterStopId = !after || after.stop.role === TripStopRole.Start ? null : after.id;
    return run((id) => movePoint({ id, stopId: item.id, tripPointOrderDto: { afterStopId } }));
  };

  const onDelete = async () => {
    const isSure = await modalManager.showDialog({
      title: $t('trips_delete_stop'),
      prompt: $t('trips_delete_stop_prompt'),
      confirmText: $t('delete'),
    });
    if (isSure && (await run((id) => deleteStop({ id, stopId: item.id })))) {
      onGone();
    }
  };

  const onMerge = async () => {
    await run((id) => mergeNextStop({ id, stopId: item.id }));
  };

  const transitIds = $derived(item.type === 'transit' ? item.stopIds : [item.id]);
  const onTransit = (isTransit: boolean) =>
    run((id) => setTransit({ id, tripTransitUpdateDto: { stopIds: transitIds, isTransit } })).then(
      (isDone) => isDone && onGone(),
    );
</script>

<div class="flex flex-col gap-3" data-testid="trip-stop-edit">
  {#if stop}
    <Field label={$t('trips_stop_title')}>
      <Input
        bind:value={texts.title}
        oninput={schedule}
        onblur={() => void flush()}
        placeholder={stop.region || $t('trips_stop_title_hint')}
        data-testid="trip-stop-title"
      />
    </Field>
    {#if !role}
      <Field label={$t('trips_stop_story')}>
        <Textarea
          bind:value={texts.story}
          oninput={schedule}
          onblur={() => void flush()}
          grow
          class="max-h-[30vh]"
          data-testid="trip-stop-story"
        />
      </Field>
    {/if}
    <p class="-mt-1 h-4 text-xs text-gray-500 dark:text-gray-400" aria-live="polite">
      {saveState === 'saving' ? $t('trips_saving') : saveState === 'saved' ? $t('trips_saved') : ''}
    </p>
    {#if trip.places.length > 0 && !role}
      <Field label={$t('trips_place')}>
        <Select
          options={placeOptions}
          value={stop.placeId ?? 'none'}
          onChange={(placeId) =>
            run((id) =>
              updateStop({ id, stopId: item.id, tripStopUpdateDto: { placeId: placeId === 'none' ? null : placeId } }),
            )}
        />
      </Field>
    {/if}
    {#if isHandPoint && isRoute && orderOptions.length > 0}
      <Field label={$t('trips_point_after')}>
        <Select options={orderOptions} placeholder={$t('trips_point_after_hint')} onChange={onOrder} />
      </Field>
    {/if}
  {/if}

  <div class="flex flex-wrap gap-2" data-testid="trip-stop-actions">
    {#if role}
      <Button
        size="small"
        shape="round"
        color="secondary"
        variant="outline"
        leadingIcon={mdiMapMarkerRadiusOutline}
        onclick={onEnd}>{$t('trips_change_place')}</Button
      >
      {#if role === TripStopRole.Finish && !stop?.stop.isFinishAtStart}
        <Button
          size="small"
          shape="round"
          color="secondary"
          variant="outline"
          leadingIcon={mdiCheck}
          onclick={() => run((id) => setFinish({ id, tripFinishUpdateDto: { isFinishAtStart: true } }))}
          >{$t('trips_finish_at_start')}</Button
        >
      {/if}
      <Button
        size="small"
        shape="round"
        color="secondary"
        variant="outline"
        leadingIcon={mdiMapMarkerRemoveOutline}
        onclick={onRemoveEnd}
        >{role === TripStopRole.Start ? $t('trips_remove_start') : $t('trips_remove_finish')}</Button
      >
    {:else if stop && hasMap && point}
      <Button
        size="small"
        shape="round"
        color="secondary"
        variant="outline"
        leadingIcon={mdiCursorMove}
        onclick={() => onMovePin(stop)}
        data-testid="trip-move-pin">{$t('trips_move_pin')}</Button
      >
      {#if stop.stop.isPositionManual && hasAssets}
        <Button
          size="small"
          shape="round"
          color="secondary"
          variant="outline"
          leadingIcon={mdiImageMarkerOutline}
          onclick={() =>
            run((id) => updateStop({ id, stopId: item.id, tripStopUpdateDto: { isPositionManual: false } }))}
          >{$t('trips_pin_to_assets')}</Button
        >
      {/if}
    {/if}
    {#if isRoute && (role === TripStopRole.Start || (stop && !role))}
      <Button
        size="small"
        shape="round"
        color="secondary"
        variant="outline"
        leadingIcon={mdiMapMarkerPlusOutline}
        onclick={onAddPoint}>{$t('trips_add_point_after')}</Button
      >
    {/if}
    {#if stop && !role && hasAssets}
      <Button
        size="small"
        shape="round"
        color="secondary"
        variant="outline"
        leadingIcon={mdiArrowCollapseVertical}
        onclick={onMerge}>{$t('trips_merge_next')}</Button
      >
      {#if isRoute}
        <Button
          size="small"
          shape="round"
          color="secondary"
          variant="outline"
          leadingIcon={mdiBusStop}
          onclick={() => onTransit(true)}>{$t('trips_mark_on_the_way')}</Button
        >
      {/if}
    {/if}
    {#if item.type === 'transit'}
      <Button
        size="small"
        shape="round"
        color="secondary"
        variant="outline"
        leadingIcon={mdiSwapVertical}
        onclick={() => onTransit(false)}>{$t('trips_not_on_the_way')}</Button
      >
    {/if}
    {#if stop && !role && !hasAssets}
      <Button
        size="small"
        shape="round"
        color="danger"
        variant="outline"
        leadingIcon={mdiDeleteOutline}
        onclick={onDelete}
        data-testid="trip-delete-stop">{$t('trips_delete_stop')}</Button
      >
    {/if}
  </div>
</div>
