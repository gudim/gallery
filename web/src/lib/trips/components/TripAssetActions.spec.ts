import { getTrip, removeAssetFromAlbum, TripKind, type TripResponseDto } from '@immich/sdk';
import { modalManager, toastManager } from '@immich/ui';
import { screen } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { assetMultiSelectManager } from '$lib/managers/asset-multi-select-manager.svelte';
import TripAssetActions from '$lib/trips/components/TripAssetActions.svelte';
import { TripEditor } from '$lib/trips/trip-editor.svelte';
import type { TripUnplaced } from '$lib/trips/trip-view';
import { renderWithTooltips } from '$tests/helpers';
import { timelineAssetFactory } from '@test-data/factories/asset-factory';

vi.mock('@immich/sdk', async (original) => ({
  ...(await original<typeof import('@immich/sdk')>()),
  getTrip: vi.fn(),
  removeAssetFromAlbum: vi.fn(),
}));

const trip = (contentVersion: number): TripResponseDto => ({
  albumId: 'album',
  kind: TripKind.Plain,
  language: 'en',
  contentVersion,
  isNaming: false,
  isFavorites: false,
  isFeatured: false,
  isShowcased: false,
  assets: [],
  stops: [],
  legs: [],
  likes: [],
  places: [],
  overlays: [],
});

const unplaced: TripUnplaced = {
  type: 'unplaced',
  id: 'unplaced',
  day: 0,
  photos: [],
  videoCount: 0,
  t0: '—',
  t1: '—',
};

describe('TripAssetActions', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(toastManager, 'primary').mockImplementation(() => ({}) as never);
    assetMultiSelectManager.clear();
    assetMultiSelectManager.selectAssets([
      timelineAssetFactory.build({ id: 'a1' }),
      timelineAssetFactory.build({ id: 'a2' }),
    ]);
  });

  const clickHide = async () => {
    await userEvent.setup().click(screen.getByTestId('trip-hide'));
  };

  it('hides the picked assets from the album and shows the trip read again', async () => {
    vi.spyOn(modalManager, 'showDialog').mockResolvedValue(true);
    vi.mocked(removeAssetFromAlbum).mockResolvedValue([
      { id: 'a1', success: true },
      { id: 'a2', success: true },
    ]);
    vi.mocked(getTrip).mockResolvedValue(trip(2));
    const editor = new TripEditor(trip(1), []);
    const onMoved = vi.fn();
    renderWithTooltips(TripAssetActions, { editor, item: unplaced, onMoved });

    await clickHide();

    expect(removeAssetFromAlbum).toHaveBeenCalledWith({ id: 'album', bulkIdsDto: { ids: ['a1', 'a2'] } });
    expect(editor.trip?.contentVersion).toBe(2);
    expect(onMoved).toHaveBeenCalled();
    expect(assetMultiSelectManager.assets).toHaveLength(0);
  });

  it('leaves the album alone when the hide is not confirmed', async () => {
    vi.spyOn(modalManager, 'showDialog').mockResolvedValue(false);
    renderWithTooltips(TripAssetActions, { editor: new TripEditor(trip(1), []), item: unplaced, onMoved: vi.fn() });

    await clickHide();

    expect(removeAssetFromAlbum).not.toHaveBeenCalled();
  });
});
