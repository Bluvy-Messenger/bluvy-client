import type { OsmType, PlaceData } from './place.types';

const DEFAULT_ZOOM = 17.5;
const MIN_LATITUDE = -90;
const MAX_LATITUDE = 90;
const MIN_LONGITUDE = -180;
const MAX_LONGITUDE = 180;
const MIN_ZOOM = 1;
const MAX_ZOOM = 22;

/**
 * Normalizes and prefixes an OpenStreetMap identifier (e.g. 'w228574493', 'n123', 'r456').
 */
export function formatOsmId(osmType: OsmType | string, osmId: number | string): string {
  const cleanId = String(osmId).replace(/^[nwrNWR]/, '').trim();
  const normalizedType = String(osmType).toLowerCase().trim();

  let prefix = 'w';
  if (normalizedType === 'node' || normalizedType === 'n') {
    prefix = 'n';
  } else if (normalizedType === 'relation' || normalizedType === 'r') {
    prefix = 'r';
  } else if (normalizedType === 'way' || normalizedType === 'w') {
    prefix = 'w';
  }

  return `${prefix}${cleanId}`;
}

/**
 * Validates that an untrusted object strictly matches the PlaceData contract.
 */
export function validatePlaceData(data: unknown): data is PlaceData {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return false;
  }

  const p = data as Record<string, unknown>;

  if (typeof p['name'] !== 'string' || p['name'].trim().length === 0) {
    return false;
  }

  const validOsmTypes: OsmType[] = ['node', 'way', 'relation'];
  if (typeof p['osmType'] !== 'string' || !validOsmTypes.includes(p['osmType'] as OsmType)) {
    return false;
  }

  if (typeof p['osmId'] !== 'number' && typeof p['osmId'] !== 'string') {
    return false;
  }
  const cleanId = String(p['osmId']).replace(/^[nwrNWR]/, '').trim();
  if (!cleanId || !/^\d+$/.test(cleanId)) {
    return false;
  }

  if (
    typeof p['latitude'] !== 'number' ||
    !Number.isFinite(p['latitude']) ||
    p['latitude'] < MIN_LATITUDE ||
    p['latitude'] > MAX_LATITUDE
  ) {
    return false;
  }

  if (
    typeof p['longitude'] !== 'number' ||
    !Number.isFinite(p['longitude']) ||
    p['longitude'] < MIN_LONGITUDE ||
    p['longitude'] > MAX_LONGITUDE
  ) {
    return false;
  }

  if (p['zoom'] !== undefined) {
    if (
      typeof p['zoom'] !== 'number' ||
      !Number.isFinite(p['zoom']) ||
      p['zoom'] < MIN_ZOOM ||
      p['zoom'] > MAX_ZOOM
    ) {
      return false;
    }
  }

  if (p['address'] !== undefined && typeof p['address'] !== 'string') {
    return false;
  }

  return true;
}

/**
 * Builds the canonical Cartes.app deep-link URL from structured PlaceData.
 * Format: https://cartes.app/?allez=Nom|OSM_ID|longitude|latitude#zoom/latitude/longitude
 */
export function buildCartesUrl(place: PlaceData): string {
  const encodedName = encodeURIComponent(place.name.trim());
  const osmIdFormatted = formatOsmId(place.osmType, place.osmId);
  const lat = place.latitude;
  const lon = place.longitude;
  const zoom = place.zoom ?? DEFAULT_ZOOM;

  return `https://cartes.app/?allez=${encodedName}|${osmIdFormatted}|${lon}|${lat}#${zoom}/${lat}/${lon}`;
}

/**
 * Validates that an iframe URL originates strictly from Cartes.app over HTTPS.
 */
export function isAllowedCartesUrl(url: string): boolean {
  if (!url || typeof url !== 'string') return false;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' && parsed.hostname === 'cartes.app';
  } catch {
    return false;
  }
}
