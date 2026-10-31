import { getTrip, TripKind, TripLegStatus, type AssetResponseDto, type TripResponseDto } from '@immich/sdk';
import { authManager } from '$lib/managers/auth-manager.svelte';
import { buildTripView, type TripView } from '$lib/trips/trip-view';
import { handleError } from '$lib/utils/handle-error';

const POLL_MS = 4000;
/** Polls per edit while naming may still be running: a naming that failed leaves the title blank for good. */
const NAMING_POLLS = 30;

/** A stop with a point and no name yet, which the naming job will fill. */
const isUnnamed = (trip: TripResponseDto) =>
  trip.kind !== TripKind.Plain &&
  trip.stops.some(({ title, region, latitude }) => latitude !== null && !title?.trim() && !region);

/**
 * The trip being viewed and, for owners and editors, edited (trips PLAN §2.5). Every edit answers with the whole trip,
 * which replaces the view; the album's assets stay as loaded. While legs are being routed or stops named, the trip is
 * read again every 4 s, as travel-album's editor polled `pending` legs.
 */
export class TripEditor {
  trip = $state<TripResponseDto>();
  view = $state<TripView>();
  isBusy = $state(false);

  #assets: AssetResponseDto[];
  #timer: ReturnType<typeof setTimeout> | undefined;
  #namingPolls = NAMING_POLLS;

  constructor(trip: TripResponseDto, assets: AssetResponseDto[]) {
    this.#assets = assets;
    this.#show(trip);
  }

  get albumId() {
    return this.trip!.albumId;
  }

  /** Runs one edit; on success the trip it answers replaces the view. Returns whether the edit went through. */
  async run(edit: (id: string) => Promise<TripResponseDto>, errorMessage: string) {
    this.isBusy = true;
    try {
      this.#namingPolls = NAMING_POLLS;
      this.#show(await edit(this.albumId));
      return true;
    } catch (error) {
      handleError(error, errorMessage);
      return false;
    } finally {
      this.isBusy = false;
    }
  }

  destroy() {
    clearTimeout(this.#timer);
  }

  #show(trip: TripResponseDto) {
    this.trip = trip;
    this.view = buildTripView(trip, this.#assets);
    this.#schedule();
  }

  #schedule() {
    clearTimeout(this.#timer);
    const trip = this.trip!;
    const isRouting = trip.legs.some(({ status }) => status === TripLegStatus.Pending);
    const isNaming = this.#namingPolls > 0 && isUnnamed(trip);
    if (!isRouting && !isNaming) {
      return;
    }
    this.#timer = setTimeout(() => void this.#poll(), POLL_MS);
  }

  async #poll() {
    this.#namingPolls = Math.max(0, this.#namingPolls - 1);
    try {
      const trip = await getTrip({ id: this.albumId, ...authManager.params });
      // An edit that answered meanwhile is newer than this read.
      if (!this.isBusy && trip.contentVersion !== this.trip?.contentVersion) {
        this.#show(trip);
        return;
      }
    } catch {
      // A failed poll waits for the next one.
    }
    this.#schedule();
  }
}
