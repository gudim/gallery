import { getTrip, TripKind, TripLegMode, TripLegStatus, type TripResponseDto } from '@immich/sdk';
import { TripEditor } from '$lib/trips/trip-editor.svelte';
import { handleError } from '$lib/utils/handle-error';

vi.mock('@immich/sdk', async (original) => ({ ...(await original<typeof import('@immich/sdk')>()), getTrip: vi.fn() }));
vi.mock('$lib/utils/handle-error', () => ({ handleError: vi.fn() }));

const trip = (overrides: Partial<TripResponseDto> = {}): TripResponseDto => ({
  albumId: 'album',
  kind: TripKind.Route,
  language: 'en',
  contentVersion: 1,
  isFavorites: false,
  isFeatured: false,
  isShowcased: false,
  assets: [],
  stops: [],
  legs: [],
  likes: [],
  places: [],
  overlays: [],
  ...overrides,
});

const pendingLeg = {
  id: 'leg',
  fromStopId: 'a',
  toStopId: 'b',
  mode: TripLegMode.Driving,
  isModeManual: false,
  status: TripLegStatus.Pending,
  polyline: null,
  distance: null,
  duration: null,
  departureName: null,
  departureLatitude: null,
  departureLongitude: null,
  arrivalName: null,
  arrivalLatitude: null,
  arrivalLongitude: null,
};

describe('TripEditor', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(getTrip).mockReset();
    vi.mocked(handleError).mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('shows the trip an edit answers', async () => {
    const editor = new TripEditor(trip(), []);
    const isDone = await editor.run(
      () => Promise.resolve(trip({ kind: TripKind.Places, contentVersion: 2 })),
      'failed',
    );

    expect(isDone).toBe(true);
    expect(editor.view?.kind).toBe(TripKind.Places);
    expect(editor.isBusy).toBe(false);
  });

  it('keeps the trip and reports a refused edit', async () => {
    const editor = new TripEditor(trip(), []);
    const error = new Error('refused');
    const isDone = await editor.run(() => Promise.reject(error), 'failed');

    expect(isDone).toBe(false);
    expect(editor.trip?.contentVersion).toBe(1);
    expect(handleError).toHaveBeenCalledWith(error, 'failed');
  });

  it('reads the trip again while legs are being routed, and stops when they are done', async () => {
    const editor = new TripEditor(trip({ legs: [pendingLeg] }), []);
    vi.mocked(getTrip).mockResolvedValue(
      trip({ contentVersion: 2, legs: [{ ...pendingLeg, status: TripLegStatus.Ok }] }),
    );

    await vi.advanceTimersByTimeAsync(4000);
    expect(getTrip).toHaveBeenCalledTimes(1);
    expect(editor.trip?.contentVersion).toBe(2);

    await vi.advanceTimersByTimeAsync(20_000);
    expect(getTrip).toHaveBeenCalledTimes(1);
    editor.destroy();
  });

  it('does not read a trip with nothing pending', async () => {
    const editor = new TripEditor(trip(), []);
    await vi.advanceTimersByTimeAsync(20_000);

    expect(getTrip).not.toHaveBeenCalled();
    editor.destroy();
  });
});
