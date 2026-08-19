export type OsmType = 'node' | 'way' | 'relation';

export interface PlaceData {
  name: string;
  osmType: OsmType;
  osmId: number | string;
  latitude: number;
  longitude: number;
  zoom?: number;
  address?: string;
}

export interface PhotonFeatureProperties {
  osm_type?: string;
  osm_id?: number | string;
  osm_key?: string;
  osm_value?: string;
  name?: string;
  street?: string;
  housenumber?: string;
  postcode?: string;
  city?: string;
  state?: string;
  county?: string;
  country?: string;
  countrycode?: string;
  type?: string;
  extent?: [number, number, number, number];
}

export interface PhotonGeometry {
  type: string;
  coordinates: [number, number]; // [longitude, latitude]
}

export interface PhotonFeature {
  type: string;
  geometry: PhotonGeometry;
  properties: PhotonFeatureProperties;
}

export interface PhotonResponse {
  type: string;
  features: PhotonFeature[];
}
