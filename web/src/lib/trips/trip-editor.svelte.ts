import { getTrip, TripLegStatus, type AssetResponseDto, type TripResponseDto } from '@immich/sdk';
import { authManager } from '$lib/managers/auth-manager.svelte';
import { buildTripView, type TripView } from '$lib/trips/trip-view';
import { handleError } from '$lib/utils/handle-error';

const POLL_MS = 4000;
/** Polls after a clock shift, while the assets' metadata is read again: about two minutes. */
const FOLLOW_POLLS = 30;

/**
 * The trip being viewed and, for owners and editors, edited (trips PLAN §2.5). Every edit answers with the whole trip,
 * which replaces the view; the album's assets stay as loaded. While legs are being routed or stops named, the trip is
 * read again every 4 s, as travel-album's editor polled `pending` legs.
 */
export class TripEditor {
  trip = $state<TripResponseDto>();
  view = $state<TripView>();
  isBusy = $state(false);

  /** The album's assets, as loaded */
  readonly assets: AssetResponseDto[];
  #timer: ReturnType<typeof setTimeout> | undefined;
  /** As the last read said: a read that changed nothing a guest sees still ends the wait for names. */
  #isNaming = false;
  #followPolls = 0;

  constructor(trip: TripResponseDto, assets: AssetResponseDto[]) {
    this.assets = assets;
    this.#show(trip);
  }

  get albumId() {
    return this.trip!.albumId;
  }

  /** Runs one edit; on success the trip it answers replaces the view. Returns whether the edit went through. */
  async run(edit: (id: string) => Promise<TripResponseDto>, errorMessage: string) {
    this.isBusy = true;
    try {
      this.#show(await edit(this.albumId));
      return true;
    } catch (error) {
      handleError(error, errorMessage);
      return false;
    } finally {
      this.isBusy = false;
    }
  }

  /** Reads the trip again for a while after a change it learns of later, such as the dates a clock shift moved. */
  follow() {
    this.#followPolls = FOLLOW_POLLS;
    this.#schedule();
  }

  destroy() {
    clearTimeout(this.#timer);
  }

  #show(trip: TripResponseDto) {
    this.trip = trip;
    this.#isNaming = trip.isNaming;
    this.view = buildTripView(trip, this.assets);
    this.#schedule();
  }

  #schedule() {
    clearTimeout(this.#timer);
    const trip = this.trip!;
    const isRouting = trip.legs.some(({ status }) => status === TripLegStatus.Pending);
    if (!isRouting && !this.#isNaming && this.#followPolls === 0) {
      return;
    }
    this.#timer = setTimeout(() => void this.#poll(), POLL_MS);
  }

  async #poll() {
    this.#followPolls = Math.max(0, this.#followPolls - 1);
    try {
      const trip = await getTrip({ id: this.albumId, ...authManager.params });
      // An edit that answered meanwhile is newer than this read.
      if (!this.isBusy) {
        if (trip.contentVersion !== this.trip?.contentVersion) {
          this.#show(trip);
          return;
        }
        this.#isNaming = trip.isNaming;
      }
    } catch {
      // A failed poll waits for the next one.
    }
    this.#schedule();
  }
}
