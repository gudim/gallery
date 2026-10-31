<script lang="ts">
  import type { TripEditor } from '$lib/trips/trip-editor.svelte';
  import {
    getLegStations,
    retryLeg,
    setLegMode,
    setLegStation,
    TripLegMode,
    TripLegStatus,
    TripStationSide,
    type TripLegDto,
    type TripLegStationsDto,
    type TripStationDto,
  } from '@immich/sdk';
  import { Button, Field, LoadingSpinner, Select } from '@immich/ui';
  import { mdiRefresh } from '@mdi/js';
  import { t } from 'svelte-i18n';

  // A leg in edit mode (trips PLAN §2.5, travel-album editor.js legCard): its mode, a train's stations near both ends,
  // and a retry when routing failed. A trail is drawn by an overlay, so it is never offered as a mode.

  interface Props {
    editor: TripEditor;
    leg: TripLegDto;
  }

  let { editor, leg }: Props = $props();

  const AUTO = 'auto';
  const MODES = [
    TripLegMode.Foot,
    TripLegMode.Driving,
    TripLegMode.Bicycle,
    TripLegMode.Bus,
    TripLegMode.Train,
    TripLegMode.Boat,
    TripLegMode.Flight,
    TripLegMode.Direct,
  ];
  const modeOptions = $derived([
    { value: AUTO, label: $t('trips_mode_auto') },
    ...MODES.map((mode) => ({ value: mode, label: $t(`trips_mode_${mode}`) })),
  ]);

  const onMode = (value: string) =>
    editor.run(
      (id) =>
        setLegMode({
          id,
          legId: leg.id,
          tripLegModeUpdateDto: { mode: value === AUTO ? null : (value as TripLegMode) },
        }),
      $t('trips_edit_failed'),
    );

  let stations = $state<TripLegStationsDto | null>();
  // The leg object is replaced by every read of the trip; the list is asked again only for another leg or mode.
  const albumId = $derived(editor.albumId);
  const legId = $derived(leg.id);
  const isTrain = $derived(leg.mode === TripLegMode.Train);
  $effect(() => {
    const id = legId;
    stations = undefined;
    if (!isTrain) {
      return;
    }
    getLegStations({ id: albumId, legId: id })
      .then((result) => legId === id && (stations = result))
      .catch(() => legId === id && (stations = null));
  });

  const stationKey = (station: { latitude: number | null; longitude: number | null }) =>
    `${station.latitude},${station.longitude}`;
  const stationOptions = (list: TripStationDto[]) =>
    list.map((station) => ({
      value: stationKey(station),
      label: `${station.name || $t('trips_station_unnamed')} · ${$t('trips_km', {
        values: { km: (station.distance / 1000).toFixed(1) },
      })}`,
    }));

  const onStation = (side: TripStationSide, list: TripStationDto[], key: string) => {
    const station = list.find((candidate) => stationKey(candidate) === key);
    if (station) {
      void editor.run(
        (id) =>
          setLegStation({
            id,
            legId: leg.id,
            tripLegStationUpdateDto: {
              side,
              latitude: station.latitude,
              longitude: station.longitude,
              name: station.name,
            },
          }),
        $t('trips_edit_failed'),
      );
    }
  };
</script>

<div class="flex flex-col gap-3" data-testid="trip-leg-edit">
  <Field label={$t('trips_leg_mode')}>
    <Select options={modeOptions} value={leg.isModeManual ? leg.mode : AUTO} onChange={onMode} />
  </Field>
  {#if leg.status === TripLegStatus.Pending}
    <p class="flex items-center gap-2 text-sm text-gray-600 dark:text-gray-300">
      <LoadingSpinner size="small" />{$t('trips_leg_pending')}
    </p>
  {:else if leg.status === TripLegStatus.Attention}
    <div class="flex flex-wrap items-center gap-2">
      <p class="text-sm text-gray-700 dark:text-gray-300">{$t('trips_leg_attention')}</p>
      <Button
        size="small"
        shape="round"
        color="secondary"
        variant="outline"
        leadingIcon={mdiRefresh}
        onclick={() => editor.run((id) => retryLeg({ id, legId: leg.id }), $t('trips_edit_failed'))}
        >{$t('trips_retry')}</Button
      >
    </div>
  {/if}
  {#if leg.mode === TripLegMode.Train}
    {#if stations === undefined}
      <p class="flex items-center gap-2 text-sm text-gray-600 dark:text-gray-300">
        <LoadingSpinner size="small" />{$t('trips_stations_loading')}
      </p>
    {:else if stations === null}
      <p class="text-sm text-gray-600 dark:text-gray-300">{$t('trips_stations_failed')}</p>
    {:else}
      {#each [{ side: TripStationSide.Departure, list: stations.departure, name: leg.departureName, latitude: leg.departureLatitude, longitude: leg.departureLongitude }, { side: TripStationSide.Arrival, list: stations.arrival, name: leg.arrivalName, latitude: leg.arrivalLatitude, longitude: leg.arrivalLongitude }] as end (end.side)}
        <Field label={$t(`trips_station_${end.side}`)}>
          {#if end.list.length > 0}
            <Select
              options={stationOptions(end.list)}
              value={stationKey(end)}
              placeholder={end.name ?? $t('trips_station_pick')}
              onChange={(key) => onStation(end.side, end.list, key)}
            />
          {:else}
            <p class="text-sm text-gray-600 dark:text-gray-300">{$t('trips_station_none')}</p>
          {/if}
        </Field>
      {/each}
    {/if}
  {/if}
</div>
