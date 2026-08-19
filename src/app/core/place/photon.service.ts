import { Injectable } from '@angular/core';
import type { OsmType, PhotonFeature, PhotonResponse, PlaceData } from './place.types';
import { validatePlaceData } from './cartes-url.util';

@Injectable({ providedIn: 'root' })
export class PhotonService {
  private readonly baseUrl = 'https://photon.komoot.io/api/';

  async search(query: string, lang = 'fr', limit = 12, signal?: AbortSignal): Promise<PlaceData[]> {
    const trimmed = query.trim();
    if (!trimmed) {
      return [];
    }

    const params = new URLSearchParams({
      q: trimmed,
      limit: String(limit),
      lang: lang.toLowerCase().startsWith('fr') ? 'fr' : (lang.toLowerCase().startsWith('de') ? 'de' : 'en'),
    });

    const response = await fetch(`${this.baseUrl}?${params.toString()}`, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
      },
      signal,
    });

    if (!response.ok) {
      throw new Error(`Photon search failed with HTTP status ${response.status}`);
    }

    const data: PhotonResponse = await response.json();
    if (!data || !Array.isArray(data.features)) {
      return [];
    }

    const results: PlaceData[] = [];

    for (const feature of data.features) {
      const place = this.mapFeatureToPlace(feature);
      if (place && validatePlaceData(place)) {
        results.push(place);
      }
    }

    return results;
  }

  private mapFeatureToPlace(feature: PhotonFeature): PlaceData | null {
    if (!feature || !feature.geometry || !Array.isArray(feature.geometry.coordinates)) {
      return null;
    }

    const [lon, lat] = feature.geometry.coordinates;
    const props = feature.properties || {};

    const rawType = (props.osm_type || 'N').toUpperCase();
    let osmType: OsmType = 'node';
    if (rawType === 'W') osmType = 'way';
    else if (rawType === 'R') osmType = 'relation';

    const rawId = props.osm_id ?? Date.now();

    const name = props.name ||
      [props.housenumber, props.street].filter(Boolean).join(' ') ||
      props.city ||
      props.state ||
      props.country ||
      'Lieu';

    const streetPart = [props.housenumber, props.street].filter(Boolean).join(' ');
    const localityPart = [props.postcode, props.city].filter(Boolean).join(' ');
    const addressParts = [
      streetPart,
      localityPart,
      props.state !== props.city ? props.state : null,
      props.country,
    ].filter((part): part is string => Boolean(part && part.trim().length > 0));

    // If the name is already the entire address or identical to streetPart/localityPart, clean it up
    const address = addressParts.join(', ');

    let zoom = 17.5;
    if (props.type === 'country') zoom = 6;
    else if (props.type === 'state') zoom = 9;
    else if (props.type === 'city' || props.osm_value === 'city' || props.osm_value === 'town') zoom = 13;
    else if (props.osm_value === 'village' || props.osm_value === 'suburb') zoom = 15;

    return {
      name: name.trim(),
      osmType,
      osmId: rawId,
      latitude: lat,
      longitude: lon,
      zoom,
      address: address || undefined,
    };
  }
}
