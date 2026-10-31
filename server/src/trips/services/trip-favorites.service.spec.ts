import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { favoritesAlbumName } from 'src/trips/services/trip-favorites.service.js';

// Gallery's ten maintained locales, by i18n file name; vitest roots at `server/`.
const LOCALES = ['en', 'de', 'fr', 'it', 'nl', 'pl', 'es', 'ru', 'zh_Hans', 'zh_Hant'];

describe(favoritesAlbumName.name, () => {
  it('names the album in the language tag, then its language, then English', () => {
    expect(favoritesAlbumName('ru')).toBe('Избранное');
    expect(favoritesAlbumName('zh-Hant')).toBe('收藏');
    expect(favoritesAlbumName('de-AT')).toBe('Favoriten');
    expect(favoritesAlbumName('lt')).toBe('Favorites');
  });

  it.each(LOCALES)('matches the favorites string of i18n/%s.json', (locale) => {
    const { favorites } = JSON.parse(readFileSync(`../i18n/${locale}.json`, 'utf8')) as { favorites: string };
    expect(favoritesAlbumName(locale.replace('_', '-'))).toBe(favorites);
  });
});
