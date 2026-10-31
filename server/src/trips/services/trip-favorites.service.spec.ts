import { describe, expect, it } from 'vitest';
import { favoritesAlbumName } from 'src/trips/services/trip-favorites.service.js';

describe(favoritesAlbumName.name, () => {
  it('names the album in the language tag, then its language, then English', () => {
    expect(favoritesAlbumName('ru')).toBe('Избранное');
    expect(favoritesAlbumName('zh-Hant')).toBe('收藏');
    expect(favoritesAlbumName('de-AT')).toBe('Favoriten');
    expect(favoritesAlbumName('lt')).toBe('Favorites');
  });
});
