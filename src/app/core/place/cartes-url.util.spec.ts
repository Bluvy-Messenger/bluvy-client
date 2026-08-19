import {
  buildCartesUrl,
  formatOsmId,
  isAllowedCartesUrl,
  validatePlaceData,
} from './cartes-url.util';
import type { PlaceData } from './place.types';

describe('cartes-url.util', () => {
  describe('buildCartesUrl', () => {
    it('1. should construct a valid Cartes.app URL with default zoom', () => {
      const place: PlaceData = {
        name: 'Mairie de Romilly-sur-Seine',
        osmType: 'way',
        osmId: '228574493',
        latitude: 48.51926,
        longitude: 3.72663,
      };

      const url = buildCartesUrl(place);
      expect(url).toBe(
        'https://cartes.app/?allez=Mairie%20de%20Romilly-sur-Seine|w228574493|3.72663|48.51926#17.5/48.51926/3.72663'
      );
    });

    it('2. should correctly encode special characters and spaces in place name', () => {
      const place: PlaceData = {
        name: 'Café & Thé / Épicerie (Centre-Ville)',
        osmType: 'node',
        osmId: 12345,
        latitude: 48.8566,
        longitude: 2.3522,
        zoom: 18,
      };

      const url = buildCartesUrl(place);
      expect(url).toContain('Caf%C3%A9%20%26%20Th%C3%A9%20%2F%20%C3%89picerie%20(Centre-Ville)');
      expect(url).toContain('#18/48.8566/2.3522');
    });

    it('3. should handle OSM Node type with n prefix', () => {
      const place: PlaceData = {
        name: 'Tour Eiffel',
        osmType: 'node',
        osmId: '5013364',
        latitude: 48.85837,
        longitude: 2.294481,
      };

      const url = buildCartesUrl(place);
      expect(url).toContain('|n5013364|');
    });

    it('4. should handle OSM Way type with w prefix', () => {
      const place: PlaceData = {
        name: 'Mairie',
        osmType: 'way',
        osmId: 987654,
        latitude: 48.5,
        longitude: 3.7,
      };

      const url = buildCartesUrl(place);
      expect(url).toContain('|w987654|');
    });

    it('should handle OSM Relation type with r prefix', () => {
      const place: PlaceData = {
        name: 'Romilly-sur-Seine',
        osmType: 'relation',
        osmId: 2006924,
        latitude: 48.5197,
        longitude: 3.7263,
      };

      const url = buildCartesUrl(place);
      expect(url).toContain('|r2006924|');
    });
  });

  describe('formatOsmId', () => {
    it('should format node osmId', () => {
      expect(formatOsmId('node', 123)).toBe('n123');
      expect(formatOsmId('node', 'n123')).toBe('n123');
      expect(formatOsmId('N', '123')).toBe('n123');
    });

    it('should format way osmId', () => {
      expect(formatOsmId('way', 456)).toBe('w456');
      expect(formatOsmId('way', 'w456')).toBe('w456');
      expect(formatOsmId('W', '456')).toBe('w456');
    });

    it('should format relation osmId', () => {
      expect(formatOsmId('relation', 789)).toBe('r789');
      expect(formatOsmId('relation', 'r789')).toBe('r789');
      expect(formatOsmId('R', '789')).toBe('r789');
    });
  });

  describe('validatePlaceData', () => {
    it('10. should accept a valid PlaceData object', () => {
      const valid: PlaceData = {
        name: 'Gare de Lyon',
        osmType: 'node',
        osmId: 123456,
        latitude: 48.8443,
        longitude: 2.3744,
        zoom: 16,
        address: 'Place Louis-Armand, 75012 Paris, France',
      };

      expect(validatePlaceData(valid)).toBe(true);
    });

    it('5. should reject invalid or out-of-range coordinates', () => {
      expect(validatePlaceData({
        name: 'Invalid Lat',
        osmType: 'node',
        osmId: 1,
        latitude: 95, // out of range [-90, 90]
        longitude: 2,
      })).toBe(false);

      expect(validatePlaceData({
        name: 'Invalid Lon',
        osmType: 'node',
        osmId: 1,
        latitude: 45,
        longitude: -190, // out of range [-180, 180]
      })).toBe(false);

      expect(validatePlaceData({
        name: 'NaN Coord',
        osmType: 'node',
        osmId: 1,
        latitude: NaN,
        longitude: 2,
      })).toBe(false);

      expect(validatePlaceData({
        name: 'Infinity Coord',
        osmType: 'node',
        osmId: 1,
        latitude: 45,
        longitude: Infinity,
      })).toBe(false);
    });

    it('6. should reject incomplete or invalid payloads', () => {
      expect(validatePlaceData(null)).toBe(false);
      expect(validatePlaceData(undefined)).toBe(false);
      expect(validatePlaceData('string')).toBe(false);
      expect(validatePlaceData(123)).toBe(false);
      expect(validatePlaceData({})).toBe(false);

      // Missing name
      expect(validatePlaceData({
        osmType: 'node',
        osmId: 1,
        latitude: 48,
        longitude: 2,
      })).toBe(false);

      // Empty name
      expect(validatePlaceData({
        name: '   ',
        osmType: 'node',
        osmId: 1,
        latitude: 48,
        longitude: 2,
      })).toBe(false);

      // Invalid osmType
      expect(validatePlaceData({
        name: 'Place',
        osmType: 'invalid-type',
        osmId: 1,
        latitude: 48,
        longitude: 2,
      })).toBe(false);

      // Invalid osmId (not numeric)
      expect(validatePlaceData({
        name: 'Place',
        osmType: 'node',
        osmId: 'abc-xyz',
        latitude: 48,
        longitude: 2,
      })).toBe(false);

      // Invalid zoom
      expect(validatePlaceData({
        name: 'Place',
        osmType: 'node',
        osmId: 1,
        latitude: 48,
        longitude: 2,
        zoom: 30, // max is 22
      })).toBe(false);
    });
  });

  describe('isAllowedCartesUrl', () => {
    it('9. should refuse external URLs and non-https protocols', () => {
      expect(isAllowedCartesUrl('http://cartes.app/')).toBe(false);
      expect(isAllowedCartesUrl('https://evil-cartes.app/')).toBe(false);
      expect(isAllowedCartesUrl('https://cartes.app.fake.com/')).toBe(false);
      expect(isAllowedCartesUrl('javascript:alert(1)')).toBe(false);
      expect(isAllowedCartesUrl('data:text/html,<h1>test</h1>')).toBe(false);
      expect(isAllowedCartesUrl('')).toBe(false);
    });

    it('should accept valid Cartes.app URLs', () => {
      expect(isAllowedCartesUrl('https://cartes.app/?allez=Test|w123|2.3|48.8#16/48.8/2.3')).toBe(true);
      expect(isAllowedCartesUrl('https://cartes.app/')).toBe(true);
    });
  });
});
