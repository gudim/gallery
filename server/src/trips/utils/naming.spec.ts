import { describe, expect, it } from 'vitest';
import { TripKind, TripStopRole } from 'src/trips/enum.js';
import { buildTripGeoRequest, resolveTripGeoConfig } from 'src/trips/utils/geo-services.js';
import {
  followsStart,
  hasPlaceNames,
  isUntitled,
  namesByDistrict,
  nominatimReverseRequest,
  normalizeTripLanguage,
  parseNominatimReverse,
  resolveTripNamingLanguages,
  stopTitle,
  tripNamingLanguages,
} from 'src/trips/utils/naming.js';

describe('resolveTripNamingLanguages', () => {
  it('names in Russian and keeps English too, as travel-album did', () => {
    expect(resolveTripNamingLanguages({})).toEqual(['ru', 'en']);
    expect(resolveTripNamingLanguages({ TRIPS_GEO_LANGS: ' ' })).toEqual(['ru', 'en']);
  });

  it('takes the languages from TRIPS_GEO_LANGS, the first naming', () => {
    expect(resolveTripNamingLanguages({ TRIPS_GEO_LANGS: 'en, de,en' })).toEqual(['en', 'de']);
    expect(resolveTripNamingLanguages({ TRIPS_GEO_LANGS: 'zh_hans' })).toEqual(['zh-Hans']);
  });

  it('refuses something that is not a list of language codes', () => {
    expect(() => resolveTripNamingLanguages({ TRIPS_GEO_LANGS: ',' })).toThrow('TRIPS_GEO_LANGS');
    expect(() => resolveTripNamingLanguages({ TRIPS_GEO_LANGS: 'ru;en' })).toThrow('TRIPS_GEO_LANGS');
  });
});

describe('normalizeTripLanguage', () => {
  it('writes a tag as accept-language takes it', () => {
    expect(normalizeTripLanguage('RU')).toBe('ru');
    expect(normalizeTripLanguage('en_us')).toBe('en-US');
    expect(normalizeTripLanguage('zh-hant-tw')).toBe('zh-Hant-TW');
    expect(normalizeTripLanguage('es-419')).toBe('es-419');
  });

  it('answers null for something else', () => {
    expect(normalizeTripLanguage('english')).toBeNull();
    expect(normalizeTripLanguage('ru,en')).toBeNull();
    expect(normalizeTripLanguage('')).toBeNull();
  });
});

describe('tripNamingLanguages', () => {
  it('names in the trip’s language and asks for every instance language but it', () => {
    expect(tripNamingLanguages('de', ['ru', 'en'])).toEqual({ language: 'de', otherLanguages: ['ru', 'en'] });
    expect(tripNamingLanguages('en', ['ru', 'en'])).toEqual({ language: 'en', otherLanguages: ['ru'] });
  });

  it('names a trip without a language in the instance’s first', () => {
    expect(tripNamingLanguages(null, ['ru', 'en'])).toEqual({ language: 'ru', otherLanguages: ['en'] });
  });
});

describe('nominatimReverseRequest', () => {
  it('asks for one point in one language with the address and the names', () => {
    const http = buildTripGeoRequest(
      nominatimReverseRequest({ latitude: 54.6871561, longitude: 25.279651 }, 'ru'),
      resolveTripGeoConfig({}),
    );
    expect(http.method).toBe('GET');
    expect(http.url).toBe(
      'https://nominatim.openstreetmap.org/reverse?accept-language=ru&addressdetails=1&format=jsonv2&lat=54.687156&lon=25.279651&namedetails=1&zoom=18',
    );
  });

  it('caches each language under its own key, and a point within a micro-degree under the same', () => {
    const config = resolveTripGeoConfig({});
    const key = (latitude: number, lang: string) =>
      buildTripGeoRequest(nominatimReverseRequest({ latitude, longitude: 25 }, lang), config).key;
    expect(key(54.1, 'ru')).not.toBe(key(54.1, 'en'));
    expect(key(54.1000001, 'ru')).toBe(key(54.1, 'ru'));
  });
});

const regionOf = (address: Record<string, string>) => parseNominatimReverse({ name: 'x', address })?.region;
const districtOf = (address: Record<string, string>) => parseNominatimReverse({ name: 'x', address })?.district;

describe('parseNominatimReverse', () => {
  it('takes the city as the region, with the country', () => {
    expect(
      parseNominatimReverse({
        name: 'Ратуша',
        display_name: 'Ратуша, 1, Площадь, Вильнюс, Литва',
        address: { city: 'Вильнюс', suburb: 'Старый город', country: 'Литва' },
      }),
    ).toEqual({ label: 'Ратуша', region: 'Вильнюс', district: 'Старый город', country: 'Литва' });
  });

  it('falls back from city to town, village and county, and from quarter to suburb and neighbourhood', () => {
    expect(regionOf({ town: 'Town', village: 'Village', county: 'County' })).toBe('Town');
    expect(regionOf({ village: 'Village', county: 'County' })).toBe('Village');
    expect(regionOf({ county: 'County' })).toBe('County');
    expect(regionOf({ state: 'State' })).toBeNull();

    expect(districtOf({ quarter: 'Quarter', suburb: 'Suburb' })).toBe('Quarter');
    expect(districtOf({ suburb: 'Suburb', neighbourhood: 'Hood' })).toBe('Suburb');
    expect(districtOf({ neighbourhood: 'Hood' })).toBe('Hood');
  });

  it('drops a district that is the region itself', () => {
    expect(parseNominatimReverse({ address: { city: 'Birzhai', suburb: 'Birzhai' } })?.district).toBeNull();
  });

  it('labels a place without a name by the first two parts of its display name', () => {
    expect(parseNominatimReverse({ name: '', display_name: '12, Main Street, Springfield, USA' })).toEqual({
      label: '12, Main Street',
      region: null,
      district: null,
      country: null,
    });
  });

  it('answers null where Nominatim knows no place', () => {
    expect(parseNominatimReverse({ error: 'Unable to geocode' })).toBeNull();
  });

  it('throws on an answer that is not a place, so it is not cached', () => {
    expect(() => parseNominatimReverse([])).toThrow();
    expect(() => parseNominatimReverse('oops')).toThrow();
    expect(() => parseNominatimReverse(null)).toThrow();
  });
});

describe('stopTitle', () => {
  const names = { label: 'Ратуша', region: 'Вильнюс', district: 'Старый город', country: 'Литва' };

  it('titles a stop by its region, else its label', () => {
    expect(stopTitle(names, false)).toBe('Вильнюс');
    expect(stopTitle({ ...names, region: null }, false)).toBe('Ратуша');
    expect(stopTitle({ ...names, region: null, label: '' }, false)).toBeNull();
  });

  it('titles a place by city and district', () => {
    expect(stopTitle(names, true)).toBe('Вильнюс — Старый город');
    expect(stopTitle({ ...names, district: null }, true)).toBe('Вильнюс');
  });

  it('names by district in Places trips only', () => {
    expect(namesByDistrict(TripKind.Places)).toBe(true);
    expect(namesByDistrict(TripKind.Route)).toBe(false);
  });
});

describe('which stops naming touches', () => {
  it('names a stop without a title, a blank one included', () => {
    expect(isUntitled({ title: null })).toBe(true);
    expect(isUntitled({ title: '  ' })).toBe(true);
    expect(isUntitled({ title: 'Home' })).toBe(false);
  });

  it('asks for the other languages of a stop with names from Nominatim only', () => {
    expect(hasPlaceNames({ region: 'Вильнюс', country: null, titleSource: 'manual' })).toBe(true);
    expect(hasPlaceNames({ region: null, country: 'Литва', titleSource: null })).toBe(true);
    expect(hasPlaceNames({ region: null, country: null, titleSource: 'geocoded' })).toBe(true);
    expect(hasPlaceNames({ region: null, country: null, titleSource: 'manual' })).toBe(false);
  });

  it('lets a finish at the start follow the start', () => {
    expect(followsStart({ role: TripStopRole.Finish, isFinishAtStart: true })).toBe(true);
    expect(followsStart({ role: TripStopRole.Finish, isFinishAtStart: false })).toBe(false);
    expect(followsStart({ role: null, isFinishAtStart: false })).toBe(false);
  });
});
